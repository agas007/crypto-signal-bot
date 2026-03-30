const config = require('../../config');
const logger = require('../../utils/logger');
const { analyzeTrend, calculateStochastic, findSupportResistance, analyzeStructure } = require('../indicators');

/**
 * Classify price position relative to support/resistance.
 *
 * @param {number} distToSupport - Distance to nearest support as %
 * @param {number} distToResistance - Distance to nearest resistance as %
 * @param {number} [threshold=2.0] - % threshold for "near"
 * @returns {'near_support'|'near_resistance'|'middle'}
 */
function classifyPricePosition(distToSupport, distToResistance, threshold = 2.0) {
  const nearSupport = distToSupport < threshold;
  const nearResistance = distToResistance < threshold;

  // If near both, it's a tight range — treat as middle (no good R:R possible)
  if (nearSupport && nearResistance) return 'middle';
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
  if (bias === 'LONG') {
    const entry = currentPrice;
    const sl = support * 0.998; // small buffer below support
    const tp = resistance !== Infinity ? resistance * 0.998 : entry * (1 + (entry - sl) * config.strategy.minRrRatio / entry);
    const risk = entry - sl;
    const reward = tp - entry;
    const rr = risk > 0 ? reward / risk : 0;
    return { entry, sl, tp, rr };
  } else {
    const entry = currentPrice;
    const sl = resistance !== Infinity ? resistance * 1.002 : entry * 1.02; // buffer above resistance
    const tp = support > 0 ? support * 1.002 : entry * (1 - (sl - entry) * config.strategy.minRrRatio / entry);
    const risk = sl - entry;
    const reward = entry - tp;
    const rr = risk > 0 ? reward / risk : 0;
    return { entry, sl, tp, rr };
  }
}

/**
 * Evaluate a symbol across multiple timeframes with STRICT filtering.
 *
 * Flow:
 *   1. Analyze all timeframes
 *   2. Apply hard kill-switch filters (instant reject)
 *   3. Weighted scoring for remaining candidates
 *   4. Pre-calculate R:R
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
  // HARD KILL-SWITCH FILTERS (instant reject)
  // ═══════════════════════════════════════════════════════
  const rejectReasons = [];

  // 1. Market is sideways / unclear
  if (d1Trend.direction === 'neutral' || d1Trend.strengthLabel === 'weak') {
    rejectReasons.push(`D1 trend unclear: ${d1Trend.direction} (${d1Trend.strengthLabel})`);
  }

  // 2. Price is in the middle zone
  if (pricePosition === 'middle') {
    rejectReasons.push(`Price in middle zone (S:${h4SR.distToSupport.toFixed(1)}% R:${h4SR.distToResistance.toFixed(1)}%)`);
  }

  // 3. No break of structure on M15
  if (!m15Structure.bos) {
    rejectReasons.push(`No M15 Break of Structure detected`);
  }

  // 4. M15 has no clear structure
  if (m15Structure.structure === 'no_structure') {
    rejectReasons.push(`M15 structure unclear: ${m15Structure.detail}`);
  }

  // If ANY kill-switch triggered, reject immediately
  if (rejectReasons.length > 0) {
    logger.debug(`${symbol} ✘ REJECTED: ${rejectReasons.join(' | ')}`);
    return null;
  }

  // ═══════════════════════════════════════════════════════
  // DIRECTIONAL EVALUATION
  // ═══════════════════════════════════════════════════════

  // ─── LONG Evaluation ──────────────────────────────────
  const longReasons = [];
  let longScore = 0;
  let longValid = true;

  // MANDATORY: D1 must be bullish (not necessarily strong)
  if (d1Trend.direction === 'bullish') {
    longReasons.push(`D1 ${d1Trend.strengthLabel} bullish (spread: ${d1Trend.spreadPercent.toFixed(2)}%)`);
    longScore += d1Trend.strengthLabel === 'strong' ? 30 : 20;
  } else {
    longValid = false; // Can't go LONG against D1 trend
  }

  // TREND PROTECTION: Don't LONG if D1 is strong bearish
  if (d1Trend.direction === 'bearish' && d1Trend.strengthLabel === 'strong') {
    longValid = false;
  }

  // MANDATORY: H4 price must be near support
  if (pricePosition === 'near_support') {
    longReasons.push(`H4 near support @ ${h4SR.nearestSupport.toFixed(4)} (${h4SR.distToSupport.toFixed(2)}%)`);
    longScore += 30;
  } else {
    longValid = false;
  }

  // MANDATORY: M15 must show bullish structure + BoS
  if (m15Structure.structure === 'bullish' && m15Structure.bos && m15Structure.bosType === 'bullish_bos') {
    longReasons.push(`M15 bullish structure + BoS (${m15Structure.detail})`);
    longScore += 25;
  } else {
    longValid = false;
  }

  // BONUS: H4 stoch oversold (confluence, not required)
  if (h4Stoch.signal === 'oversold') {
    longReasons.push(`H4 stoch oversold (K:${h4Stoch.k.toFixed(1)} D:${h4Stoch.d.toFixed(1)})`);
    longScore += 15;
  }

  // ─── SHORT Evaluation ─────────────────────────────────
  const shortReasons = [];
  let shortScore = 0;
  let shortValid = true;

  // MANDATORY: D1 must be bearish
  if (d1Trend.direction === 'bearish') {
    shortReasons.push(`D1 ${d1Trend.strengthLabel} bearish (spread: ${d1Trend.spreadPercent.toFixed(2)}%)`);
    shortScore += d1Trend.strengthLabel === 'strong' ? 30 : 20;
  } else {
    shortValid = false;
  }

  // TREND PROTECTION: Don't SHORT if D1 is strong bullish
  if (d1Trend.direction === 'bullish' && d1Trend.strengthLabel === 'strong') {
    shortValid = false;
  }

  // MANDATORY: H4 price must be near resistance
  if (pricePosition === 'near_resistance') {
    shortReasons.push(`H4 near resistance @ ${h4SR.nearestResistance.toFixed(4)} (${h4SR.distToResistance.toFixed(2)}%)`);
    shortScore += 30;
  } else {
    shortValid = false;
  }

  // MANDATORY: M15 must show bearish structure + BoS
  if (m15Structure.structure === 'bearish' && m15Structure.bos && m15Structure.bosType === 'bearish_bos') {
    shortReasons.push(`M15 bearish structure + BoS (${m15Structure.detail})`);
    shortScore += 25;
  } else {
    shortValid = false;
  }

  // BONUS: H4 stoch overbought (confluence, not required)
  if (h4Stoch.signal === 'overbought') {
    shortReasons.push(`H4 stoch overbought (K:${h4Stoch.k.toFixed(1)} D:${h4Stoch.d.toFixed(1)})`);
    shortScore += 15;
  }

  // ═══════════════════════════════════════════════════════
  // PICK BIAS + R:R VALIDATION
  // ═══════════════════════════════════════════════════════

  let bias = null;
  let score = 0;
  let reasons = [];

  if (longValid && shortValid) {
    // Both valid → pick higher score
    if (longScore >= shortScore) {
      bias = 'LONG'; score = longScore; reasons = longReasons;
    } else {
      bias = 'SHORT'; score = shortScore; reasons = shortReasons;
    }
  } else if (longValid) {
    bias = 'LONG'; score = longScore; reasons = longReasons;
  } else if (shortValid) {
    bias = 'SHORT'; score = shortScore; reasons = shortReasons;
  } else {
    logger.debug(`${symbol} → no valid direction (L:${longValid}/${longScore} S:${shortValid}/${shortScore})`);
    return null;
  }

  // Minimum score threshold (need at least 75 = all 3 mandatory conditions met)
  if (score < 75) {
    logger.debug(`${symbol} → score too low: ${score} (need 75+)`);
    return null;
  }

  // Pre-calculate R:R
  const riskReward = calculateRiskReward(
    bias,
    h4SR.currentPrice,
    h4SR.nearestSupport,
    h4SR.nearestResistance
  );

  // Kill if R:R < minimum
  if (riskReward.rr < config.strategy.minRrRatio) {
    logger.debug(`${symbol} → R:R too low: ${riskReward.rr.toFixed(2)} (need ${config.strategy.minRrRatio}+)`);
    return null;
  }

  logger.info(`${symbol} ✓ ${bias} candidate (score: ${score}, R:R: ${riskReward.rr.toFixed(2)})`);
  return { symbol, bias, score, reasons, rejectReasons: [], analysis, riskReward };
}

module.exports = { evaluateSignal, classifyPricePosition, calculateRiskReward };
