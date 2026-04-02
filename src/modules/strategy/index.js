const config = require('../../config');
const logger = require('../../utils/logger');
const { analyzeTrend, calculateStochastic, findSupportResistance, analyzeStructure, detectAtSpike } = require('../indicators');

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
  const MAX_SL_ALLOWED = 0.04; // 4% Maximum Risk limit

  if (bias === 'LONG') {
    const entry = currentPrice;
    const sl = support * 0.998;
    
    // Hard Reject if distance to support > 4%
    const slDistPercent = (entry - sl) / entry;
    if (slDistPercent > MAX_SL_ALLOWED) return null;

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

    // Hard Reject if distance to resistance > 4%
    const slDistPercent = (sl - entry) / entry;
    if (slDistPercent > MAX_SL_ALLOWED) return null;

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
 * @param {string} symbol
 * @param {{ D1: Array, H4: Array, M15: Array }} data
 * @returns {{ symbol, bias, score, reasons: string[], rejectReasons: string[], analysis: Object, riskReward: Object } | null}
 */
function evaluateSignal(symbol, data) {
  const { D1, H4, H1 } = data;
  const emaParams = config.indicators.ema;
  const stochParams = config.indicators.stochastic;

  // ─── Analysis ──────────────────────────────────────────
  const d1Trend = analyzeTrend(D1, emaParams);
  const h4SR = findSupportResistance(H4, config.indicators.swingLookback);
  const h4Stoch = calculateStochastic(H4, stochParams);
  const h4Trend = analyzeTrend(H4, emaParams);
  const h1Trend = analyzeTrend(H1, emaParams);
  const h1Structure = analyzeStructure(H1);
  const h1Stoch = calculateStochastic(H1, stochParams);

  // New: Spike Detection (Penalty for 'God-Candle')
  const h1Spike = detectAtSpike(H1, 14);

  const pricePosition = classifyPricePosition(h4SR.distToSupport, h4SR.distToResistance);

  const analysis = {
    d1Trend,
    h4SR,
    h4Stoch,
    h4Trend,
    h1Trend,
    h1Structure,
    h1Stoch,
    pricePosition,
  };

  // Only reject if there is literally zero directional info
  if (d1Trend.direction === 'neutral' && h4Trend.direction === 'neutral' && h1Trend.direction === 'neutral') {
    return null;
  }

  const longReasons = [];
  let longScore = 0;
  const tags = [];

  // D1 Trend alignment (0-25 pts)
  if (d1Trend.direction === 'bullish') {
    longScore += d1Trend.strengthLabel === 'strong' ? 25 : d1Trend.strengthLabel === 'moderate' ? 20 : 10;
    longReasons.push(`D1 trend bullish (${d1Trend.strengthLabel})`);
  }
  if (d1Trend.direction === 'bearish' && d1Trend.strengthLabel === 'strong') {
    longScore -= 30;
  }

  // H4 Trend alignment (0-15 pts)
  if (h4Trend.direction === 'bullish') {
    longReasons.push(`H4 bullish (${h4Trend.strengthLabel})`);
    longScore += 15;
  }

  // H4 Price position (0-20 pts)
  if (pricePosition === 'near_support') {
    longReasons.push(`H4 near support @ ${h4SR.nearestSupport.toFixed(4)} (${h4SR.distToSupport.toFixed(2)}%)`);
    longScore += 20;
  } else if (h4SR.distToSupport < 6) {
    longReasons.push(`H4 moderate proximity to support (${h4SR.distToSupport.toFixed(2)}%)`);
    longScore += 8;
  }

  // H1 Structure
  if (h1Structure.structure === 'bullish') {
    longScore += 15;
    longReasons.push(`H1 bullish structure`);
  }
  if (h1Structure.bos && h1Structure.bosType === 'bullish_bos') {
    longScore += 15;
    longReasons.push(`H1 bullish Break of Structure`);
  }

  // Stochastic
  if (h4Stoch.signal === 'oversold') longScore += 10;
  if (h1Stoch.signal === 'oversold') longScore += 5;

  // ═══════════════════════════════════════════════════════
  // SHORT SCORING (simplified)
  // ═══════════════════════════════════════════════════════
  const shortReasons = [];
  let shortScore = 0;
  if (d1Trend.direction === 'bearish') shortScore += 25;
  if (h4Trend.direction === 'bearish') shortScore += 15;
  if (pricePosition === 'near_resistance') shortScore += 20;
  if (h1Structure.structure === 'bearish') shortScore += 15;

  // ═══════════════════════════════════════════════════════
  // PICK BIAS + APPLY NEW FILTERS
  // ═══════════════════════════════════════════════════════

  let bias = null;
  let score = 0;
  let reasons = [];

  if (longScore >= shortScore) {
    bias = 'LONG'; score = longScore; reasons = longReasons;
  } else {
    bias = 'SHORT'; score = shortScore; reasons = shortReasons;
  }

  const riskReward = calculateRiskReward(bias, h4SR.currentPrice, h4SR.nearestSupport, h4SR.nearestResistance);
  if (!riskReward) return null; // Hard reject if SL distance > 4%

  // 1. Max SL Threshold (Capital Protection) - We still keep this 15% check for other logic, but 4% is already rejected above
  const slDistPercent = (Math.abs(riskReward.entry - riskReward.sl) / riskReward.entry) * 100;
  if (slDistPercent > 15) {
    score -= 10;
    tags.push('WIDE SL WARNING');
    reasons.push(`⚠️ WIDE SL: SL distance is ${slDistPercent.toFixed(1)}% (>15%)`);
  }

  // 2. Verticality & Mean Reversion Check
  // If price is > 5% above S/R Proximity threshold (which is 4%), basically > 5% from support level
  if (bias === 'LONG' && h4SR.distToSupport > 5.0) {
    tags.push('WAIT FOR RETEST');
    reasons.push(`✋ Price is floating ${h4SR.distToSupport.toFixed(1)}% above support. Waiting for retest.`);
  }

  // 3. God-Candle Penalty
  if (h1Spike.spike) {
    score -= 15;
    tags.push('GOD-CANDLE ALERT');
    reasons.push(`☄️ Abnormal ATR Spike (${h1Spike.ratio.toFixed(1)}x average). High correction risk.`);
  }

  const isStrict = score >= 65 && reasons.length >= 3;

  return {
    symbol,
    bias,
    score,
    reasons,
    tags,
    analysis,
    riskReward,
    isStrict,
    lowConfidence: !isStrict,
  };
}

module.exports = { evaluateSignal, classifyPricePosition, calculateRiskReward };
