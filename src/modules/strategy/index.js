const config = require('../../config');
const logger = require('../../utils/logger');
const { 
  analyzeTrend, calculateStochastic, findSupportResistance,
  analyzeStructure, detectAtSpike, detectRetest,
  detectEma1321, detectStochCross, detectDivergence, detectOrderBlocks
} = require('../indicators');

// ═══════════════════════════════════════════════════════════════════
// MARKET MICROSTRUCTURE ANALYZER
// Interprets all off-chart Binance data into scored signals
// ═══════════════════════════════════════════════════════════════════

/**
 * Analyze all market microstructure data fetched from Binance.
 * Returns scored observations (longBonus, shortBonus) + labels.
 *
 * @param {object} micro
 * @param {object|null} micro.oi         fetchOpenInterest result
 * @param {Array}       micro.oiHistory  fetchOpenInterestHistory result
 * @param {Array}       micro.crowdRatio fetchGlobalLongShortRatio result
 * @param {Array}       micro.topRatio   fetchTopTraderLongShortRatio result
 * @param {object|null} micro.orderBook  fetchOrderBookDepth result
 * @param {Array}       micro.liquidations fetchLiquidationOrders result
 * @param {number}      currentPrice
 * @returns {{ longBonus: number, shortBonus: number, tags: string[], reasons: { long: string[], short: string[] }, raw: object }}
 */
function analyzeMicrostructure(micro = {}, currentPrice = 0) {
  const {
    oi = null,
    oiHistory = [],
    crowdRatio = [],
    topRatio = [],
    orderBook = null,
    liquidations = [],
  } = micro;

  let longBonus = 0;
  let shortBonus = 0;
  const tags = [];
  const reasons = { long: [], short: [] };
  const raw = {};

  // ─── 1. Open Interest Trend (Rising OI = conviction, Falling OI = exhaustion) ───
  if (oiHistory.length >= 3) {
    const oldest = oiHistory[0].sumOpenInterest;
    const latest = oiHistory[oiHistory.length - 1].sumOpenInterest;
    const oiChangePct = ((latest - oldest) / oldest) * 100;
    raw.oiChangePct = oiChangePct;

    if (oiChangePct > 5) {
      // Rising OI: market is adding positions — follow the trend
      longBonus += 8;
      shortBonus += 8;
      tags.push(`OI ↑ +${oiChangePct.toFixed(1)}%`);
      reasons.long.push(`Open Interest naik ${oiChangePct.toFixed(1)}% — posisi baru terbuka, konfirmasi trend`);
      reasons.short.push(`Open Interest naik ${oiChangePct.toFixed(1)}% — konfirmasi dorongan sell`);
    } else if (oiChangePct < -5) {
      // Falling OI: positions closing — potential exhaustion/reversal
      longBonus -= 5;
      shortBonus -= 5;
      tags.push(`OI ↓ ${oiChangePct.toFixed(1)}%`);
      reasons.long.push(`⚠️ Open Interest turun ${Math.abs(oiChangePct).toFixed(1)}% — posisi ditutup, trend bisa melemah`);
      reasons.short.push(`⚠️ Open Interest turun ${Math.abs(oiChangePct).toFixed(1)}% — trend bisa melemah`);
    }
  }

  // ─── 2. Retail Crowd Ratio (Contrarian Indicator) ───
  // When retail is 70%+ Long → bearish signal (trapped longs)
  // When retail is 70%+ Short → bullish signal (trapped shorts / short squeeze)
  if (crowdRatio.length > 0) {
    const latest = crowdRatio[crowdRatio.length - 1];
    const longPct = latest.longAccount * 100;
    const shortPct = latest.shortAccount * 100;
    raw.crowdLongPct = longPct;
    raw.crowdShortPct = shortPct;

    if (longPct >= 70) {
      // Crowd heavily long → bearish contrarian
      shortBonus += 12;
      longBonus -= 8;
      tags.push(`CROWD ${longPct.toFixed(0)}% LONG`);
      reasons.short.push(`Retail crowd ${longPct.toFixed(0)}% Long — contrarian SHORT signal (trapped longs)`);
    } else if (longPct >= 60) {
      shortBonus += 6;
      tags.push(`CROWD ${longPct.toFixed(0)}% LONG`);
      reasons.short.push(`Retail crowd condong Long (${longPct.toFixed(0)}%) — mild bearish sentiment`);
    } else if (shortPct >= 70) {
      // Crowd heavily short → bullish contrarian
      longBonus += 12;
      shortBonus -= 8;
      tags.push(`CROWD ${shortPct.toFixed(0)}% SHORT`);
      reasons.long.push(`Retail crowd ${shortPct.toFixed(0)}% Short — contrarian LONG signal (short squeeze risk)`);
    } else if (shortPct >= 60) {
      longBonus += 6;
      tags.push(`CROWD ${shortPct.toFixed(0)}% SHORT`);
      reasons.long.push(`Retail crowd condong Short (${shortPct.toFixed(0)}%) — mild bullish sentiment`);
    }
  }

  // ─── 3. Order Book Depth Imbalance (L2 Data) ───
  if (orderBook) {
    const { imbalance, bias: obBias, bidVolume, askVolume } = orderBook;
    raw.obImbalance = imbalance;
    raw.obBias = obBias;

    if (obBias === 'BUY' && imbalance > 0.2) {
      longBonus += 10;
      tags.push(`ORDER BOOK BID WALL`);
      reasons.long.push(`Order book imbalance ${(imbalance*100).toFixed(0)}% favor Bids — bullish pressure`);
    } else if (obBias === 'BUY') {
      longBonus += 5;
      reasons.long.push(`Order book sedikit favor bids (${(imbalance*100).toFixed(0)}%)`);
    } else if (obBias === 'SELL' && Math.abs(imbalance) > 0.2) {
      shortBonus += 10;
      tags.push(`ORDER BOOK ASK WALL`);
      reasons.short.push(`Order book imbalance ${(Math.abs(imbalance)*100).toFixed(0)}% favor Asks — bearish pressure`);
    } else if (obBias === 'SELL') {
      shortBonus += 5;
      reasons.short.push(`Order book sedikit favor asks (${(Math.abs(imbalance)*100).toFixed(0)}%)`);
    }
  }

  return { longBonus, shortBonus, tags, reasons, raw };
}

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
function calculateRiskReward(bias, currentPrice, levels, options = {}) {
  const MIN_RR = config.strategy.minRrRatio;
  const baseMaxSl = config.strategy.maxSlAllowed || 0.08;
  const MAX_SL_ALLOWED = options.atr ? Math.min(baseMaxSl, (options.atr * 2) / currentPrice) : baseMaxSl;
  const MIN_SL_DISTANCE = 0.005;   // 0.5% Min Distance (avoid tight noise)
  const ATR_MULTIPLIER = 1.5;      // Rule 4: SL min 1.5x ATR
  
  const ACCOUNT_BALANCE = options.accountBalance || config.strategy.accountBalance;
  const RISK_PCT = config.strategy.riskPercentage;
  const MAX_POS_PCT = config.strategy.maxPositionPercentage;
  const LEVERAGE = 20;             // 20x leverage
  
  const atrDist = options.atr ? options.atr * ATR_MULTIPLIER : 0;
  const atrDistPercent = options.atr ? atrDist / currentPrice : 0;

  let entry = currentPrice;
  let sl, tp;
  let scaled = false;

  // Calculate Risk in Dollar (5% of balance or $0.25 minimum)
  const riskDollar = Math.max(ACCOUNT_BALANCE * RISK_PCT, config.strategy.minRiskDollar || 0.25);

  if (bias === 'LONG') {
    // [CONSERVATIVE] SL at Wick Support, TP at Body Resistance
    const wickSupport = (levels && levels.wick) ? levels.wick.support : (typeof levels === 'number' ? levels : 0);
    const bodyResistance = (levels && levels.body) ? levels.body.resistance : (typeof options.resistance === 'number' ? options.resistance : Infinity);

    sl = options.sl || Math.min(wickSupport * 0.998, entry - atrDist);
    tp = options.tp || (bodyResistance !== Infinity ? bodyResistance * 0.998 : entry * (1 + (entry - sl) * MIN_RR / entry));
    
    const slDistPercent = (entry - sl) / entry;
    // Skip technical rejection if manual/AI levels are provided
    if (!options.sl && (slDistPercent < Math.max(MIN_SL_DISTANCE, atrDistPercent) || slDistPercent > MAX_SL_ALLOWED)) return null;

    const riskPerUnit = entry - sl;
    const rewardPerUnit = tp - entry;
    const rr = riskPerUnit > 0 ? rewardPerUnit / riskPerUnit : 0;

    // Position Sizing
    let quantity = riskDollar / riskPerUnit;
    if (options.stepSize) quantity = roundStep(quantity, options.stepSize);
    let notionalValue = quantity * entry;
    
    // Cap at Max Position Size (5% of account)
    const maxNotional = ACCOUNT_BALANCE * MAX_POS_PCT;
    
    // Rule: Ensure it meets Binance MIN_NOTIONAL (often 5-100 USDT)
    const minRequired = options.minNotional || 5.0;

    if (notionalValue < minRequired) {
        notionalValue = minRequired;
        quantity = options.stepSize ? roundStep(notionalValue / entry, options.stepSize) : (notionalValue / entry);
        if (quantity === 0 && options.stepSize) quantity = options.stepSize;
        notionalValue = quantity * entry;
        scaled = true;
    }

    if (notionalValue > maxNotional) {
      notionalValue = maxNotional;
      quantity = options.stepSize ? roundStep(notionalValue / entry, options.stepSize) : (notionalValue / entry);
      notionalValue = quantity * entry;
      // If after capping it's below minNotional, it's untradeable
      if (notionalValue < minRequired) return null;
    }

    const margin = notionalValue / LEVERAGE;
    if (margin > ACCOUNT_BALANCE) return null;

    return { entry, sl, tp, rr, isScaled: scaled, positionSize: { risk: (Math.abs(entry - sl) * quantity), leverage: LEVERAGE, quantity, margin, notional: notionalValue } };
  } else {
    // [CONSERVATIVE] SL at Wick Resistance, TP at Body Support
    const wickResistance = (levels && levels.wick) ? levels.wick.resistance : (typeof options.resistance === 'number' ? options.resistance : Infinity);
    const bodySupport = (levels && levels.body) ? levels.body.support : (typeof levels === 'number' ? levels : 0);

    sl = options.sl || Math.max(wickResistance !== Infinity ? wickResistance * 1.002 : entry * 1.02, entry + atrDist);
    tp = options.tp || (bodySupport > 0 ? bodySupport * 1.002 : entry * (1 - (sl - entry) * MIN_RR / entry));
    
    const slDistPercent = (sl - entry) / entry;
    if (!options.sl && (slDistPercent < Math.max(MIN_SL_DISTANCE, atrDistPercent) || slDistPercent > MAX_SL_ALLOWED)) return null;

    const riskPerUnit = sl - entry;
    const rewardPerUnit = entry - tp;
    const rr = riskPerUnit > 0 ? rewardPerUnit / riskPerUnit : 0;

    let quantity = riskDollar / riskPerUnit;
    if (options.stepSize) quantity = roundStep(quantity, options.stepSize);
    let notionalValue = quantity * entry;
    const maxNotional = ACCOUNT_BALANCE * MAX_POS_PCT;

    // Rule: Ensure it meets Binance MIN_NOTIONAL
    const minRequired = options.minNotional || 5.0;

    if (notionalValue < minRequired) {
        notionalValue = minRequired;
        quantity = options.stepSize ? roundStep(notionalValue / entry, options.stepSize) : (notionalValue / entry);
        if (quantity === 0 && options.stepSize) quantity = options.stepSize;
        notionalValue = quantity * entry;
        scaled = true;
    }

    if (notionalValue > maxNotional) {
      notionalValue = maxNotional;
      quantity = options.stepSize ? roundStep(notionalValue / entry, options.stepSize) : (notionalValue / entry);
      notionalValue = quantity * entry;
      if (notionalValue < minRequired) return null;
    }

    const margin = notionalValue / LEVERAGE;
    if (margin > ACCOUNT_BALANCE) return null;

    return { entry, sl, tp, rr, isScaled: scaled, positionSize: { risk: (Math.abs(sl - entry) * quantity), leverage: LEVERAGE, quantity, margin, notional: notionalValue } };
  }
}

/**
 * Evaluate a symbol across multiple timeframes.
 */
function evaluateSignal(symbol, data, options = {}) {
  const { D1, H4, H1 } = data;
  const fundingRate = options.fundingRate || 0;
  const micro = options.micro || {};
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
  const h1Spike = detectAtSpike(H1, 14);

  const breakoutLevel = d1Trend.direction === 'bullish' ? h4SR.wick.support : h4SR.wick.resistance;
  const retestStatus = detectRetest(H1, breakoutLevel, d1Trend.direction === 'bullish' ? 'LONG' : 'SHORT');

  const distToWickSupport = h4SR.wick.support ? ((h4SR.currentPrice - h4SR.wick.support) / h4SR.currentPrice) * 100 : Infinity;
  const distToWickResistance = h4SR.wick.resistance !== Infinity ? ((h4SR.wick.resistance - h4SR.currentPrice) / h4SR.currentPrice) * 100 : Infinity;
  const pricePosition = classifyPricePosition(distToWickSupport, distToWickResistance);

  const analysis = { d1Trend, h4SR, h4Stoch, h4Trend, h1Trend, h1Structure, h1Stoch, pricePosition, retestStatus };

  const globalTrend = d1Trend.direction !== 'neutral' ? d1Trend : h4Trend;
  if (globalTrend.direction === 'neutral') {
    return options.includeRejectionReason ? { signal: null, rejectionReason: 'Neutral HTF trend (D1 & H4)' } : null;
  }
  
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
    const supportVal = (h4SR.wick && typeof h4SR.wick.support === 'number') ? h4SR.wick.support.toFixed(4) : 'N/A';
    const distVal = typeof distToWickSupport === 'number' ? distToWickSupport.toFixed(2) : 'N/A';
    longReasons.push(`H4 near wick support @ ${supportVal} (${distVal}%)`);
    longScore += 20;
  } else if (distToWickSupport < 6) {
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

  if (h4Trend.direction === 'bearish') {
    shortScore += 15;
    shortReasons.push(`H4 trend bearish (${h4Trend.strengthLabel})`);
  }
  if (pricePosition === 'near_resistance') {
    const resVal = (h4SR.wick && typeof h4SR.wick.resistance === 'number') ? h4SR.wick.resistance.toFixed(4) : 'N/A';
    const distVal = typeof distToWickResistance === 'number' ? distToWickResistance.toFixed(2) : 'N/A';
    shortReasons.push(`H4 near wick resistance @ ${resVal} (${distVal}%)`);
    shortScore += 20;
  }
  if (h1Structure.structure === 'bearish') {
    shortScore += 15;
    shortReasons.push(`H1 bearish structure`);
  }
  if (h1Structure.bos && h1Structure.bosType === 'bearish_bos') {
    shortScore += 15;
    shortReasons.push(`H1 bearish Break of Structure (BoS)`);
  }
  
  if (fundingRate < -0.03) {
    shortScore -= 15;
    tags.push('LOW FUNDING: SHORT SQUEEZE RISK');
    warnings.push(`⚠️ Funding Rate sangat negatif (${(fundingRate*100).toFixed(3)}%) - Risiko short squeeze.`);
  }

  // 5. Stochastic (0-15 pts)
  if (h4Stoch.signal === 'overbought') shortScore += 10;
  if (h1Stoch.signal === 'overbought') shortScore += 5;

  // ══════════════════════════════════════
  // H1 MENTOR SIGNALS: EMA 13/21, Stoch Cross, Divergence, Order Block
  // ══════════════════════════════════════
  const ema1321 = detectEma1321(H1);
  const h1StochCross = detectStochCross(h1Stoch.kSeries, h1Stoch.dSeries);
  const h1Divergence = detectDivergence(H1, h1Stoch.kSeries, 14);
  const h4OB = detectOrderBlocks(H4, { impulseMultiplier: 1.8, proximityPct: 0.03 });
  const h1OB = detectOrderBlocks(H1, { impulseMultiplier: 1.8, proximityPct: 0.025 });

  // ─── A. EMA 13/21 (price above both + golden cross) ───
  // Mentor: "Above 13 & 21 EMA" + "13 & 21 EMA Cross" = BUY
  if (ema1321.priceAboveBoth) {
    longScore += 12;
    longReasons.push(`H1 price above EMA13(${ema1321.ema13.toFixed(4)}) & EMA21(${ema1321.ema21.toFixed(4)})`);
  } else if (ema1321.priceBelowBoth) {
    shortScore += 12;
    shortReasons.push(`H1 price below EMA13(${ema1321.ema13.toFixed(4)}) & EMA21(${ema1321.ema21.toFixed(4)})`);
  }

  if (ema1321.goldenCross) {
    longScore += 18;  // Strong signal: fresh golden cross
    longReasons.push(`✨ H1 EMA13/21 Golden Cross (13 crossed above 21)`);
  } else if (ema1321.ema13AboveEma21) {
    longScore += 6;   // Ongoing bullish EMA alignment
    longReasons.push(`H1 EMA13 above EMA21 (bullish alignment)`);
  }

  if (ema1321.deathCross) {
    shortScore += 18;
    shortReasons.push(`✨ H1 EMA13/21 Death Cross (13 crossed below 21)`);
  } else if (!ema1321.ema13AboveEma21) {
    shortScore += 6;
    shortReasons.push(`H1 EMA13 below EMA21 (bearish alignment)`);
  }

  // ─── B. Stochastic Cross ───
  // Mentor: "Stochastic Cross" = BUY
  if (h1StochCross.crossBullish) {
    const zoneBonus = h1StochCross.crossInZone ? 10 : 5; // Cross in oversold = stronger
    longScore += zoneBonus;
    longReasons.push(`H1 Stoch %K crossed above %D${h1StochCross.crossInZone ? ' (in oversold zone — HIGH CONF)' : ''}`);
  }
  if (h1StochCross.crossBearish) {
    const zoneBonus = h1StochCross.crossInZone ? 10 : 5;
    shortScore += zoneBonus;
    shortReasons.push(`H1 Stoch %K crossed below %D${h1StochCross.crossInZone ? ' (in overbought zone — HIGH CONF)' : ''}`);
  }

  // ─── C. Divergence ───
  // Mentor: "Bullish Divergence" = BUY
  if (h1Divergence.bullishDiv) {
    longScore += 15;
    longReasons.push(`🔍 H1 Bullish Divergence: ${h1Divergence.detail}`);
  }
  if (h1Divergence.hiddenBullishDiv) {
    longScore += 8;
    longReasons.push(`🔍 H1 Hidden Bullish Divergence (trend continuation)`);
  }
  if (h1Divergence.bearishDiv) {
    shortScore += 15;
    shortReasons.push(`🔍 H1 Bearish Divergence: ${h1Divergence.detail}`);
  }
  if (h1Divergence.hiddenBearishDiv) {
    shortScore += 8;
    shortReasons.push(`🔍 H1 Hidden Bearish Divergence (trend continuation)`);
  }

  // ─── D. Order Block ───
  // Mentor: "Approaching Order Block" = buy consideration
  // H4 OB (bigger, more significant)
  if (h4OB.inBullishOB || h4OB.approachingBullishOB) {
    const strength = h4OB.approachingBullishOB?.strength || 1;
    const pts = h4OB.inBullishOB ? 20 : 14;
    longScore += Math.min(pts, pts * Math.min(strength / 2, 1.5));
    const zone = h4OB.approachingBullishOB;
    longReasons.push(
      `🟦 H4 ${h4OB.inBullishOB ? 'IN' : 'Approaching'} Bullish OB [${zone?.bottom?.toFixed(4)}–${zone?.top?.toFixed(4)}] (strength: ${zone?.strength?.toFixed(1)}x ATR)`
    );
    tags.push(h4OB.inBullishOB ? 'H4 OB ENTRY ZONE' : 'H4 OB APPROACHING');
  }
  if (h4OB.inBearishOB || h4OB.approachingBearishOB) {
    const strength = h4OB.approachingBearishOB?.strength || 1;
    const pts = h4OB.inBearishOB ? 20 : 14;
    shortScore += Math.min(pts, pts * Math.min(strength / 2, 1.5));
    const zone = h4OB.approachingBearishOB;
    shortReasons.push(
      `🟥 H4 ${h4OB.inBearishOB ? 'IN' : 'Approaching'} Bearish OB [${zone?.top?.toFixed(4)}–${zone?.bottom?.toFixed(4)}] (strength: ${zone?.strength?.toFixed(1)}x ATR)`
    );
    tags.push(h4OB.inBearishOB ? 'H4 OB SELL ZONE' : 'H4 OB SELL APPROACHING');
  }

  // H1 OB (more entry-specific)
  if (h1OB.inBullishOB || h1OB.approachingBullishOB) {
    longScore += h1OB.inBullishOB ? 12 : 8;
    const zone = h1OB.approachingBullishOB;
    longReasons.push(
      `🟦 H1 ${h1OB.inBullishOB ? 'IN' : 'Approaching'} Bullish OB [${zone?.bottom?.toFixed(4)}–${zone?.top?.toFixed(4)}]`
    );
  }
  if (h1OB.inBearishOB || h1OB.approachingBearishOB) {
    shortScore += h1OB.inBearishOB ? 12 : 8;
    const zone = h1OB.approachingBearishOB;
    shortReasons.push(
      `🟥 H1 ${h1OB.inBearishOB ? 'IN' : 'Approaching'} Bearish OB [${zone?.bottom?.toFixed(4)}–${zone?.top?.toFixed(4)}]`
    );
  }

  // ══════════════════════════════════════
  // MARKET MICROSTRUCTURE SCORING (up to +/-50 pts)
  // ══════════════════════════════════════
  const microResult = analyzeMicrostructure(micro, h4SR.currentPrice);

  longScore += microResult.longBonus;
  shortScore += microResult.shortBonus;
  longReasons.push(...microResult.reasons.long);
  shortReasons.push(...microResult.reasons.short);
  tags.push(...microResult.tags);

  // ═══════════════════════════════════════════════════════
  // PICK BIAS + FINAL REFINEMENT
  // ═══════════════════════════════════════════════════════
  // Pick Bias
  // Rule 4: Ambiguitas check (lebih besar, bukan lebih besar sama dengan)
  if (longScore === shortScore && longScore > 0) {
    return options.includeRejectionReason ? { signal: null, rejectionReason: 'Neutral conflict (LongScore == ShortScore)' } : null;
  }
  
  let bias = longScore > shortScore ? 'LONG' : 'SHORT';
  let score = longScore > shortScore ? longScore : shortScore;
  let reasons = longScore > shortScore ? longReasons : shortReasons;

  if (score < 30) {
    return options.includeRejectionReason ? { signal: null, rejectionReason: `Score too low (${score}/30)` } : null;
  }

  const riskReward = calculateRiskReward(bias, h4SR.currentPrice, h4SR, { 
    atr,
    accountBalance: options.accountBalance || config.strategy.accountBalance,
    stepSize: options.stepSize,
    minNotional: options.minNotional
  });

  if (!riskReward) {
      const wickSup = (h4SR.wick && typeof h4SR.wick.support === 'number') ? h4SR.wick.support : 0;
      const wickRes = (h4SR.wick && typeof h4SR.wick.resistance === 'number') ? h4SR.wick.resistance : Infinity;

      const slDist = bias === 'LONG' 
        ? (h4SR.currentPrice - (wickSup * 0.998)) / h4SR.currentPrice
        : (wickRes !== Infinity ? ((wickRes * 1.002) - h4SR.currentPrice) / h4SR.currentPrice : 0.02);
      
      const balance = options.accountBalance || config.strategy.accountBalance;
      const minOrderValue = options.minNotional || 5.0;
      const marginForMin = minOrderValue / 20;

      let reason = 'Technical levels (SL/TP) invalid or too tight';
      if (slDist > config.strategy.maxSlAllowed) reason = `SL distance too wide (${(slDist*100).toFixed(1)}% > ${(config.strategy.maxSlAllowed*100).toFixed(0)}%)`;
      else if (marginForMin > balance) reason = `Insufficient balance to meet exchange MIN_NOTIONAL ($${minOrderValue})`;
      
      return options.includeRejectionReason ? { signal: null, rejectionReason: reason } : null;
  }
  // Verticality & Mean Reversion Protection
  const distFromLvl = bias === 'LONG' ? distToWickSupport : distToWickResistance;
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
    analysis: {
      ...analysis,
      ema1321,
      h1StochCross,
      h1Divergence,
      h4OB: { approachingBullishOB: h4OB.approachingBullishOB, approachingBearishOB: h4OB.approachingBearishOB, inBullishOB: h4OB.inBullishOB, inBearishOB: h4OB.inBearishOB },
      h1OB: { approachingBullishOB: h1OB.approachingBullishOB, approachingBearishOB: h1OB.approachingBearishOB, inBullishOB: h1OB.inBullishOB, inBearishOB: h1OB.inBearishOB },
    },
    riskReward,
    isStrict,
    lowConfidence: !isStrict,
    fundingRate: (fundingRate * 100).toFixed(4) + '%',
    trading_type: tradingType,
    microstructure: microResult.raw,
  };
}

module.exports = { evaluateSignal, classifyPricePosition, calculateRiskReward, analyzeMicrostructure };
