const config = require('../../config');
const logger = require('../../utils/logger');
const { analyzeTrend, calculateStochastic, findSupportResistance, analyzeStructure } = require('../indicators');

/**
 * Classify price position relative to support/resistance.
 * Relaxed version: wider threshold (4% instead of 2%).
 *
 * @param {number} distToSupport - Distance to nearest support as %
 * @param {number} distToResistance - Distance to nearest resistance as %
 * @param {number} [threshold=4.0] - % threshold for "near"
 * @returns {'near_support'|'near_resistance'|'middle'}
 */
function classifyPricePosition(distToSupport, distToResistance, threshold = 4.0) {
  const nearSupport = distToSupport < threshold;
  const nearResistance = distToResistance < threshold;

  if (nearSupport && nearResistance) return 'middle'; // tight range
  if (nearSupport) return 'near_support';
  if (nearResistance) return 'near_resistance';
  return 'middle';
}

/**
 * Pre-calculate Risk:Reward ratio based on key levels.
 *
 * @param {'LONG'|'SHORT'} bias
 * @param {number} currentPrice
 * @param {number} support
 * @param {number} resistance
 * @returns {{ entry: number, sl: number, tp: number, rr: number }}
 */
function calculateRiskReward(bias, currentPrice, support, resistance) {
  const minRr = config.strategy.minRrRatio;

  if (bias === 'LONG') {
    const entry = currentPrice;
    const sl = support * 0.998;
    const tp = resistance !== Infinity
      ? resistance * 0.998
      : entry * (1 + (entry - sl) * minRr / entry);
    const risk = entry - sl;
    const reward = tp - entry;
    const rr = risk > 0 ? reward / risk : 0;
    return { entry, sl, tp, rr };
  } else {
    const entry = currentPrice;
    const sl = resistance !== Infinity ? resistance * 1.002 : entry * 1.02;
    const tp = support > 0
      ? support * 1.002
      : entry * (1 - (sl - entry) * minRr / entry);
    const risk = sl - entry;
    const reward = entry - tp;
    const rr = risk > 0 ? reward / risk : 0;
    return { entry, sl, tp, rr };
  }
}

/**
 * Evaluate a symbol across multiple timeframes with RELAXED scoring.
 *
 * Flow (no hard kill-switches, everything is scored):
 *   1. Analyze all timeframes
 *   2. Score each condition (weighted)
 *   3. Determine bias from best scoring direction
 *   4. Pre-calculate R:R
 *   5. Return if score meets minimum threshold
 *
 * @param {string} symbol
 * @param {{ D1: Array, H4: Array, M15: Array }} data
 * @returns {{ symbol, bias, score, reasons: string[], rejectReasons: string[], analysis: Object, riskReward: Object } | null}
 */
function evaluateSignal(symbol, data) {
  const { D1, H4, M15 } = data;
  const emaParams = config.indicators.ema;
  const stochParams = config.indicators.stochastic;

  // ─── Analysis ──────────────────────────────────────────
  const d1Trend = analyzeTrend(D1, emaParams);
  const h4SR = findSupportResistance(H4, config.indicators.swingLookback);
  const h4Stoch = calculateStochastic(H4, stochParams);
  const h4Trend = analyzeTrend(H4, emaParams);
  const m15Trend = analyzeTrend(M15, emaParams);
  const m15Structure = analyzeStructure(M15);
  const m15Stoch = calculateStochastic(M15, stochParams);

  const pricePosition = classifyPricePosition(h4SR.distToSupport, h4SR.distToResistance);

  const analysis = {
    d1Trend,
    h4SR,
    h4Stoch,
    h4Trend,
    m15Trend,
    m15Structure,
    m15Stoch,
    pricePosition,
  };

  // ═══════════════════════════════════════════════════════
  // SOFT REJECT (only truly hopeless cases)
  // ═══════════════════════════════════════════════════════
  
  // Only reject if there is literally zero directional info
  if (d1Trend.direction === 'neutral' && h4Trend.direction === 'neutral' && m15Trend.direction === 'neutral') {
    logger.debug(`${symbol} ✘ All timeframes neutral — no direction at all`);
    return null;
  }

  // ═══════════════════════════════════════════════════════
  // LONG SCORING (additive, no mandatory conditions)
  // ═══════════════════════════════════════════════════════
  const longReasons = [];
  let longScore = 0;

  // D1 Trend alignment (0-25 pts)
  if (d1Trend.direction === 'bullish') {
    if (d1Trend.strengthLabel === 'strong') {
      longReasons.push(`D1 strong bullish (spread: ${d1Trend.spreadPercent.toFixed(2)}%)`);
      longScore += 25;
    } else if (d1Trend.strengthLabel === 'moderate') {
      longReasons.push(`D1 moderate bullish (spread: ${d1Trend.spreadPercent.toFixed(2)}%)`);
      longScore += 20;
    } else {
      longReasons.push(`D1 weak bullish (spread: ${d1Trend.spreadPercent.toFixed(2)}%)`);
      longScore += 10;
    }
  }
  // Penalty for going against strong D1 bearish
  if (d1Trend.direction === 'bearish' && d1Trend.strengthLabel === 'strong') {
    longScore -= 30;
  }

  // H4 Trend alignment (0-15 pts)
  if (h4Trend.direction === 'bullish') {
    longReasons.push(`H4 bullish (${h4Trend.strengthLabel})`);
    longScore += h4Trend.strengthLabel === 'strong' ? 15 : 10;
  }

  // H4 Price position (0-20 pts)
  if (pricePosition === 'near_support') {
    longReasons.push(`H4 near support @ ${h4SR.nearestSupport.toFixed(4)} (${h4SR.distToSupport.toFixed(2)}%)`);
    longScore += 20;
  } else if (pricePosition === 'middle' && h4SR.distToSupport < 6) {
    // Give partial credit if within 6%
    longReasons.push(`H4 moderate proximity to support (${h4SR.distToSupport.toFixed(2)}%)`);
    longScore += 8;
  }

  // M15 Structure (0-15 pts)
  if (m15Structure.structure === 'bullish') {
    longReasons.push(`M15 bullish structure (${m15Structure.detail})`);
    longScore += 15;
  }

  // M15 Break of Structure (0-15 pts, bonus — not mandatory anymore)
  if (m15Structure.bos && m15Structure.bosType === 'bullish_bos') {
    longReasons.push(`M15 bullish BoS detected`);
    longScore += 15;
  }

  // M15 Trend confluence (0-10 pts)
  if (m15Trend.direction === 'bullish') {
    longReasons.push(`M15 trend bullish (${m15Trend.strengthLabel})`);
    longScore += 10;
  }

  // Stochastic momentum (0-10 pts)
  if (h4Stoch.signal === 'oversold') {
    longReasons.push(`H4 stoch oversold (K:${h4Stoch.k.toFixed(1)} D:${h4Stoch.d.toFixed(1)})`);
    longScore += 10;
  }
  if (m15Stoch.signal === 'oversold') {
    longReasons.push(`M15 stoch oversold (K:${m15Stoch.k.toFixed(1)})`);
    longScore += 5;
  }

  // Stoch crossover bonus
  if (h4Stoch.k > h4Stoch.d && h4Stoch.k < 40) {
    longReasons.push(`H4 stoch bullish crossover in low zone`);
    longScore += 8;
  }

  // ═══════════════════════════════════════════════════════
  // SHORT SCORING (additive, no mandatory conditions)
  // ═══════════════════════════════════════════════════════
  const shortReasons = [];
  let shortScore = 0;

  // D1 Trend alignment (0-25 pts)
  if (d1Trend.direction === 'bearish') {
    if (d1Trend.strengthLabel === 'strong') {
      shortReasons.push(`D1 strong bearish (spread: ${d1Trend.spreadPercent.toFixed(2)}%)`);
      shortScore += 25;
    } else if (d1Trend.strengthLabel === 'moderate') {
      shortReasons.push(`D1 moderate bearish (spread: ${d1Trend.spreadPercent.toFixed(2)}%)`);
      shortScore += 20;
    } else {
      shortReasons.push(`D1 weak bearish (spread: ${d1Trend.spreadPercent.toFixed(2)}%)`);
      shortScore += 10;
    }
  }
  // Penalty for going against strong D1 bullish
  if (d1Trend.direction === 'bullish' && d1Trend.strengthLabel === 'strong') {
    shortScore -= 30;
  }

  // H4 Trend alignment (0-15 pts)
  if (h4Trend.direction === 'bearish') {
    shortReasons.push(`H4 bearish (${h4Trend.strengthLabel})`);
    shortScore += h4Trend.strengthLabel === 'strong' ? 15 : 10;
  }

  // H4 Price position (0-20 pts)
  if (pricePosition === 'near_resistance') {
    shortReasons.push(`H4 near resistance @ ${h4SR.nearestResistance.toFixed(4)} (${h4SR.distToResistance.toFixed(2)}%)`);
    shortScore += 20;
  } else if (pricePosition === 'middle' && h4SR.distToResistance < 6) {
    shortReasons.push(`H4 moderate proximity to resistance (${h4SR.distToResistance.toFixed(2)}%)`);
    shortScore += 8;
  }

  // M15 Structure (0-15 pts)
  if (m15Structure.structure === 'bearish') {
    shortReasons.push(`M15 bearish structure (${m15Structure.detail})`);
    shortScore += 15;
  }

  // M15 Break of Structure (0-15 pts, bonus)
  if (m15Structure.bos && m15Structure.bosType === 'bearish_bos') {
    shortReasons.push(`M15 bearish BoS detected`);
    shortScore += 15;
  }

  // M15 Trend confluence (0-10 pts)
  if (m15Trend.direction === 'bearish') {
    shortReasons.push(`M15 trend bearish (${m15Trend.strengthLabel})`);
    shortScore += 10;
  }

  // Stochastic momentum (0-10 pts)
  if (h4Stoch.signal === 'overbought') {
    shortReasons.push(`H4 stoch overbought (K:${h4Stoch.k.toFixed(1)} D:${h4Stoch.d.toFixed(1)})`);
    shortScore += 10;
  }
  if (m15Stoch.signal === 'overbought') {
    shortReasons.push(`M15 stoch overbought (K:${m15Stoch.k.toFixed(1)})`);
    shortScore += 5;
  }

  // Stoch crossover bonus
  if (h4Stoch.k < h4Stoch.d && h4Stoch.k > 60) {
    shortReasons.push(`H4 stoch bearish crossover in high zone`);
    shortScore += 8;
  }

  // ═══════════════════════════════════════════════════════
  // PICK BIAS + VALIDATION
  // ═══════════════════════════════════════════════════════

  let bias = null;
  let score = 0;
  let reasons = [];

  // Minimum viable score = 40 (was 75)
  // This means roughly 2-3 conditions need to align
  const MIN_SCORE = 40;

  if (longScore >= MIN_SCORE && shortScore >= MIN_SCORE) {
    // Both valid → pick higher score
    if (longScore >= shortScore) {
      bias = 'LONG'; score = longScore; reasons = longReasons;
    } else {
      bias = 'SHORT'; score = shortScore; reasons = shortReasons;
    }
  } else if (longScore >= MIN_SCORE) {
    bias = 'LONG'; score = longScore; reasons = longReasons;
  } else if (shortScore >= MIN_SCORE) {
    bias = 'SHORT'; score = shortScore; reasons = shortReasons;
  } else {
    logger.debug(`${symbol} → score too low (L:${longScore} S:${shortScore}, need ${MIN_SCORE}+)`);
    return null;
  }

  // Must have at least 2 reasons (some signal behind the score)
  if (reasons.length < 2) {
    logger.debug(`${symbol} → not enough confluence: ${reasons.length} reasons`);
    return null;
  }

  // Pre-calculate R:R
  const riskReward = calculateRiskReward(
    bias,
    h4SR.currentPrice,
    h4SR.nearestSupport,
    h4SR.nearestResistance
  );

  // Kill if R:R < minimum (uses relaxed config value)
  if (riskReward.rr < config.strategy.minRrRatio) {
    logger.debug(`${symbol} → R:R too low: ${riskReward.rr.toFixed(2)} (need ${config.strategy.minRrRatio}+)`);
    return null;
  }

  logger.info(`${symbol} ✓ ${bias} candidate (score: ${score}, R:R: ${riskReward.rr.toFixed(2)}, reasons: ${reasons.length})`);
  return { symbol, bias, score, reasons, rejectReasons: [], analysis, riskReward };
}

module.exports = { evaluateSignal, classifyPricePosition, calculateRiskReward };
