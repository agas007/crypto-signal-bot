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
  const MAX_SL_ALLOWED = 0.04;      // 4% Max Risk
  const MIN_SL_DISTANCE = 0.005;   // 0.5% Min Distance (avoid tight noise)

  if (bias === 'LONG') {
    const entry = currentPrice;
    const sl = support * 0.998;
    
    const slDistPercent = (entry - sl) / entry;
    // Reject if too tight (<0.5%) or too wide (>4%)
    if (slDistPercent < MIN_SL_DISTANCE || slDistPercent > MAX_SL_ALLOWED) return null;

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

    const slDistPercent = (sl - entry) / entry;
    // Reject if too tight (<0.5%) or too wide (>4%)
    if (slDistPercent < MIN_SL_DISTANCE || slDistPercent > MAX_SL_ALLOWED) return null;

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
 * Evaluate a symbol across multiple timeframes.
 *
 * @param {string} symbol
 * @param {{ D1: Array, H4: Array, H1: Array }} data
 * @param {{ fundingRate: number }} options
 * @returns {Object | null}
 */
function evaluateSignal(symbol, data, options = {}) {
  const { D1, H4, H1 } = data;
  const fundingRate = options.fundingRate || 0;
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
  const h1Spike = detectAtSpike(H1, 14); // Penalty for 'God-Candle'

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

  // Basic Filter: Directional Info Required
  if (d1Trend.direction === 'neutral' && h4Trend.direction === 'neutral' && h1Trend.direction === 'neutral') {
    return null;
  }

  const longReasons = [];
  let longScore = 0;
  const tags = [];

  // 1. D1 Trend alignment (0-25 pts)
  if (d1Trend.direction === 'bullish') {
    longScore += d1Trend.strengthLabel === 'strong' ? 25 : d1Trend.strengthLabel === 'moderate' ? 20 : 10;
    longReasons.push(`D1 trend bullish (${d1Trend.strengthLabel})`);
  }
  if (d1Trend.direction === 'bearish' && d1Trend.strengthLabel === 'strong') {
    longScore -= 30; // Strong counter-trend filter
  }

  // 2. H4 Trend alignment (0-15 pts)
  if (h4Trend.direction === 'bullish') {
    longReasons.push(`H4 bullish (${h4Trend.strengthLabel})`);
    longScore += 15;
  }

  // 3. H4 Price position (0-20 pts)
  if (pricePosition === 'near_support') {
    longReasons.push(`H4 near support @ ${h4SR.nearestSupport.toFixed(4)} (${h4SR.distToSupport.toFixed(2)}%)`);
    longScore += 20;
  } else if (h4SR.distToSupport < 6) {
    longScore += 8;
  }

  // 4. H1 Structure (0-30 pts)
  if (h1Structure.structure === 'bullish') {
    longScore += 15;
    longReasons.push(`H1 bullish structure`);
  }
  if (h1Structure.bos && h1Structure.bosType === 'bullish_bos') {
    longScore += 15;
    longReasons.push(`H1 bullish Break of Structure (BoS)`);
  }

  // 5. Stochastic (0-15 pts)
  if (h4Stoch.signal === 'oversold') longScore += 10;
  if (h1Stoch.signal === 'oversold') longScore += 5;

  // 6. Funding Rate Penalty (Crowded Trade Protection)
  if (fundingRate > 0.03) {
    longScore -= 15;
    tags.push('HIGH FUNDING: LONG TRAP RISK');
    longReasons.push(`⚠️ Funding Rate tinggi (${(fundingRate*100).toFixed(3)}%) - Risiko long squeeze.`);
  }

  // ═══════════════════════════════════════════════════════
  // SHORT SCORING
  // ═══════════════════════════════════════════════════════
  const shortReasons = [];
  let shortScore = 0;
  if (d1Trend.direction === 'bearish') shortScore += 25;
  if (h4Trend.direction === 'bearish') shortScore += 15;
  if (pricePosition === 'near_resistance') shortScore += 20;
  if (h1Structure.structure === 'bearish') shortScore += 15;
  if (h1Structure.bos && h1Structure.bosType === 'bearish_bos') shortScore += 15;
  
  if (fundingRate < -0.03) {
    shortScore -= 15;
    tags.push('LOW FUNDING: SHORT SQUEEZE RISK');
    shortReasons.push(`⚠️ Funding Rate sangat negatif (${(fundingRate*100).toFixed(3)}%) - Risiko short squeeze.`);
  }

  // ═══════════════════════════════════════════════════════
  // PICK BIAS + FINAL REFINEMENT
  // ═══════════════════════════════════════════════════════
  let bias = longScore >= shortScore ? 'LONG' : 'SHORT';
  let score = longScore >= shortScore ? longScore : shortScore;
  let reasons = longScore >= shortScore ? longReasons : shortReasons;

  // Risk:Reward check (includes the 4% Hard SL Reject)
  const riskReward = calculateRiskReward(bias, h4SR.currentPrice, h4SR.nearestSupport, h4SR.nearestResistance);
  if (!riskReward) return null; // Rejected due to SL > 4%

  // Verticality & Mean Reversion Protection
  const distFromLvl = bias === 'LONG' ? h4SR.distToSupport : h4SR.distToResistance;
  if (distFromLvl > 5.0) {
    score -= 10;
    tags.push('WAIT FOR RETEST');
    reasons.push(`✋ Price is floating ${distFromLvl.toFixed(1)}% away from key level. Entry is currently 'vertical'.`);
  }

  // God-Candle Penalty (ATR Spike)
  if (h1Spike.spike) {
    score -= 20;
    tags.push('GOD-CANDLE ALERT');
    reasons.push(`☄️ Abnormal H1 ATR Spike (${h1Spike.ratio.toFixed(1)}x average). Avoid FOMO at price peaks.`);
  }

  // Trading Type Classification logic for AI
  const isRetested = distFromLvl < 4.0;
  const tradingType = isRetested ? 'SWING / DAY TRADING' : 'MOMENTUM SCALP';

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
    fundingRate: (fundingRate * 100).toFixed(4) + '%',
    trading_type: tradingType,
  };
}

module.exports = { evaluateSignal, classifyPricePosition, calculateRiskReward };
