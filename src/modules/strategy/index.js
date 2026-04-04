const config = require('../../config');
const logger = require('../../utils/logger');
const { analyzeTrend, calculateStochastic, findSupportResistance, analyzeStructure, detectAtSpike, detectRetest } = require('../indicators');

/**
 * Round quantity to the nearest step size to fulfill LOT_SIZE requirement.
 */
function roundStep(quantity, stepSize) {
    if (!stepSize || stepSize === 0) return quantity;
    const precision = stepSize.toString().split('.')[1]?.length || 0;
    return parseFloat((Math.floor(quantity / stepSize) * stepSize).toFixed(precision));
}

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
function calculateRiskReward(bias, currentPrice, support, resistance, options = {}) {
  const MIN_RR = config.strategy.minRrRatio;
  const MAX_SL_ALLOWED = 0.08;      // 8% Max Risk (increased from 4% to allow structural SL)
  const MIN_SL_DISTANCE = 0.005;   // 0.5% Min Distance (avoid tight noise)
  const ATR_MULTIPLIER = 1.5;      // Rule 4: SL min 1.5x ATR
  
  // Position Sizing (Rule: 2% Risk, Max 5% Notional)
  const ACCOUNT_BALANCE = options.accountBalance || config.strategy.accountBalance;
  const RISK_PCT = config.strategy.riskPercentage;
  const MAX_POS_PCT = config.strategy.maxPositionPercentage;
  const LEVERAGE = 20;             // 20x leverage
  
  const atrDist = options.atr ? options.atr * ATR_MULTIPLIER : 0;
  const atrDistPercent = options.atr ? atrDist / currentPrice : 0;

  if (bias === 'LONG') {
    const entry = currentPrice;
    // Rule 4: SL must be at least 1.5x ATR below entry, or below structure
    const structureSl = support * 0.998;
    const minAtrSl = entry - atrDist;
    const sl = Math.min(structureSl, minAtrSl); // Use whichever is lower (safer)
    
    const slDistPercent = (entry - sl) / entry;
    
    // Reject if too tight (<1.5x ATR or <0.5%) or too wide (>4%)
    if (slDistPercent < Math.max(MIN_SL_DISTANCE, atrDistPercent) || slDistPercent > MAX_SL_ALLOWED) return null;

    const tp = resistance !== Infinity
      ? resistance * 0.998
      : entry * (1 + (entry - sl) * MIN_RR / entry);
    
    const riskPerUnit = entry - sl;
    const rewardPerUnit = tp - entry;
    const rr = riskPerUnit > 0 ? rewardPerUnit / riskPerUnit : 0;

    // Position Sizing
    const riskDollar = ACCOUNT_BALANCE * RISK_PCT;
    let quantity = riskDollar / riskPerUnit;
    if (options.stepSize) quantity = roundStep(quantity, options.stepSize);
    let notionalValue = quantity * entry;
    
    // Cap at Max Position Size (5% of account)
    const maxNotional = ACCOUNT_BALANCE * MAX_POS_PCT;
    if (notionalValue > maxNotional) {
      notionalValue = maxNotional;
      quantity = options.stepSize ? roundStep(notionalValue / entry, options.stepSize) : (notionalValue / entry);
      notionalValue = quantity * entry;
    }

    const marginRequired = notionalValue / LEVERAGE;

    return { 
      entry, sl, tp, rr, 
      positionSize: {
        risk: riskDollar,
        leverage: LEVERAGE,
        quantity: quantity,
        margin: marginRequired,
        notional: notionalValue
      }
    };
  } else {
    const entry = currentPrice;
    const structureSl = resistance !== Infinity ? resistance * 1.002 : entry * 1.02;
    const minAtrSl = entry + atrDist;
    const sl = Math.max(structureSl, minAtrSl); // Use whichever is higher (safer)

    const slDistPercent = (sl - entry) / entry;
    
    // Reject if too tight (<1.5x ATR or <0.5%) or too wide (>4%)
    if (slDistPercent < Math.max(MIN_SL_DISTANCE, atrDistPercent) || slDistPercent > MAX_SL_ALLOWED) return null;

    const tp = support > 0
      ? support * 1.002
      : entry * (1 - (sl - entry) * MIN_RR / entry);
    
    const riskPerUnit = sl - entry;
    const rewardPerUnit = entry - tp;
    const rr = riskPerUnit > 0 ? rewardPerUnit / riskPerUnit : 0;

    // Position Sizing
    const riskDollar = ACCOUNT_BALANCE * RISK_PCT;
    let quantity = riskDollar / riskPerUnit;
    if (options.stepSize) quantity = roundStep(quantity, options.stepSize);
    let notionalValue = quantity * entry;
    
    // Cap at Max Position Size (5% of account)
    const maxNotional = ACCOUNT_BALANCE * MAX_POS_PCT;
    if (notionalValue > maxNotional) {
      notionalValue = maxNotional;
      quantity = options.stepSize ? roundStep(notionalValue / entry, options.stepSize) : (notionalValue / entry);
      notionalValue = quantity * entry;
    }

    const marginRequired = notionalValue / LEVERAGE;

    return { 
      entry, sl, tp, rr,
      positionSize: {
        risk: riskDollar,
        leverage: LEVERAGE,
        quantity: quantity,
        margin: marginRequired,
        notional: notionalValue
      }
    };
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

  // Retest Detection (Rule: Check if price retested the H4 SR level)
  const breakoutLevel = d1Trend.direction === 'bullish' ? h4SR.nearestSupport : h4SR.nearestResistance;
  const retestStatus = detectRetest(H1, breakoutLevel, d1Trend.direction === 'bullish' ? 'LONG' : 'SHORT');

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
    retestStatus,
  };

  // Rule 5: No entry if against HTF trend (4H/1D)
  // If D1 is bullish, we can only LONG. If D1 is bearish, we can only SHORT.
  // If D1 is neutral, we check H4.
  const globalTrend = d1Trend.direction !== 'neutral' ? d1Trend : h4Trend;
  if (globalTrend.direction === 'neutral') return null; // No clear HTF trend
  
  const atr = h1Spike.atr; // Access ATR from the existing h1Spike analysis

  const longReasons = [];
  const shortReasons = [];
  const warnings = [];
  const tags = [];
  let longScore = 0;
  let shortScore = 0;

  // 1. D1 Trend alignment (Rule 5: Hard Filter)
  if (d1Trend.direction === 'bullish') {
    longScore += d1Trend.strengthLabel === 'strong' ? 25 : d1Trend.strengthLabel === 'moderate' ? 20 : 10;
    longReasons.push(`D1 trend bullish (${d1Trend.strengthLabel})`);
  } else if (d1Trend.direction === 'bearish') {
    longScore -= 100; // Rule 5: Hard reject LONG against D1 Bearish
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

  // 6. Retest Confirmation (0-10 pts)
  if (retestStatus === 'CONFIRMED') {
    longScore += 10;
    longReasons.push('H1 retest confirmed at support');
  }

  // 6. Funding Rate Penalty (Crowded Trade Protection)
  if (fundingRate > 0.03) {
    longScore -= 15;
    tags.push('HIGH FUNDING: LONG TRAP RISK');
    warnings.push(`⚠️ Funding Rate tinggi (${(fundingRate*100).toFixed(3)}%) - Risiko long squeeze.`);
  }

  // ═══════════════════════════════════════════════════════
  // SHORT SCORING
  // ═══════════════════════════════════════════════════════
  if (d1Trend.direction === 'bearish') {
    shortScore += 25;
    shortReasons.push(`D1 trend bearish`);
  } else if (d1Trend.direction === 'bullish') {
    shortScore -= 100; // Rule 5: Hard reject SHORT against D1 Bullish
  }

  if (h4Trend.direction === 'bearish') shortScore += 15;
  if (pricePosition === 'near_resistance') shortScore += 20;
  if (h1Structure.structure === 'bearish') shortScore += 15;
  if (h1Structure.bos && h1Structure.bosType === 'bearish_bos') shortScore += 15;
  
  if (fundingRate < -0.03) {
    shortScore -= 15;
    tags.push('LOW FUNDING: SHORT SQUEEZE RISK');
    warnings.push(`⚠️ Funding Rate sangat negatif (${(fundingRate*100).toFixed(3)}%) - Risiko short squeeze.`);
  }

  // 5. Stochastic (0-15 pts)
  if (h4Stoch.signal === 'overbought') shortScore += 10;
  if (h1Stoch.signal === 'overbought') shortScore += 5;

  // ═══════════════════════════════════════════════════════
  // PICK BIAS + FINAL REFINEMENT
  // ═══════════════════════════════════════════════════════
  // Pick Bias
  // Rule 4: Ambiguitas check (lebih besar, bukan lebih besar sama dengan)
  if (longScore === shortScore && longScore > 0) return null; // Neutral conflict
  
  let bias = longScore > shortScore ? 'LONG' : 'SHORT';
  let score = longScore > shortScore ? longScore : shortScore;
  let reasons = longScore > shortScore ? longReasons : shortReasons;

  if (score < 30) return null; // Hard reject low scores early

  // Risk:Reward check (includes the 4% Hard SL Reject + 1.5x ATR min SL)
  const riskReward = calculateRiskReward(bias, h4SR.currentPrice, h4SR.nearestSupport, h4SR.nearestResistance, { 
    atr,
    accountBalance: options.accountBalance || config.strategy.accountBalance,
    stepSize: options.stepSize
  });
  if (!riskReward) return null; 

  // Verticality & Mean Reversion Protection
  const distFromLvl = bias === 'LONG' ? h4SR.distToSupport : h4SR.distToResistance;
  if (distFromLvl > 5.0) {
    score -= 10;
    tags.push('WAIT FOR RETEST');
    warnings.push(`✋ Price is floating ${distFromLvl.toFixed(1)}% away from key level. Entry is currently 'vertical'.`);
  }

  // God-Candle Penalty (ATR Spike)
  if (h1Spike.spike) {
    score -= 20;
    tags.push('GOD-CANDLE ALERT');
    warnings.push(`☄️ Abnormal H1 ATR Spike (${h1Spike.ratio.toFixed(1)}x average). Avoid FOMO at price peaks.`);
  }

  // Trading Type Classification logic for AI
  const isRetested = distFromLvl < 4.0;
  const tradingType = isRetested ? 'SWING / DAY TRADING' : 'MOMENTUM SCALP';

  // Rule 6: Technical score >= 70% first. AI is final sanity check.
  // Rule 3: Hanya hitung POSITIVE reasons untuk isStrict (menghindari false positive dari warnings)
  const isStrict = score >= 70 && reasons.length >= 3;

  return {
    symbol,
    bias,
    score,
    reasons,
    warnings,
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
