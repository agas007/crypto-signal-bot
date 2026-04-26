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
  
  // FIX 2: SL minimum = 1.5x ATR atau 0.8%, ambil yang lebih besar
  const atrBasedMinSl = options.atr ? (options.atr * 1.5) / currentPrice : 0.008;
  const MIN_SL_DISTANCE = Math.max(0.008, atrBasedMinSl); // WIDENED: 0.8% Min Distance to avoid tight crypto noise
  const ATR_MULTIPLIER = 1.5;      // Rule 4: SL min 1.5x ATR
  
  const ACCOUNT_BALANCE = options.accountBalance || config.strategy.accountBalance;
  const RISK_PCT = config.strategy.riskPercentage;
  const MAX_POS_PCT = config.strategy.maxPositionPercentage;
  const LEVERAGE = 20;             // 20x leverage
  
  const atrDist = options.atr ? options.atr * ATR_MULTIPLIER : 0;
  const atrDistPercent = options.atr ? atrDist / currentPrice : 0;
  const breakoutContext = options.breakoutContext || null;

  let entry = currentPrice;
  let sl, tp;
  let scaled = false;

  // Rule 5: Volatility-based Position Sizing
  // If ATR % is very high (> 3%), reduce risk by half to survive volatility
  let riskFactor = 1.0;
  if (atrDistPercent > 0.03) {
      riskFactor = 0.5;
      logger.info(`🛡️ High Volatility Detected (${(atrDistPercent*100).toFixed(1)}%). Reducing risk by 50%.`);
  }

  // Calculate Risk in Dollar (5% of balance * riskFactor or $0.25 minimum)
  const riskDollar = Math.max(ACCOUNT_BALANCE * RISK_PCT * riskFactor, config.strategy.minRiskDollar || 0.25);

  if (bias === 'LONG') {
    // [CONSERVATIVE] SL at Wick Support, TP at Body Resistance
    const wickSupport = (levels && levels.wick) ? levels.wick.support : (typeof levels === 'number' ? levels : 0);
    const bodyResistance = (levels && levels.body) ? levels.body.resistance : (typeof options.resistance === 'number' ? options.resistance : Infinity);
    const hasBullishBosAnchor =
      breakoutContext &&
      breakoutContext.type === 'bullish_bos' &&
      Number.isFinite(breakoutContext.level) &&
      breakoutContext.level > 0 &&
      breakoutContext.level < entry;

    // For breakout-retest longs, anchor the stop just below the broken resistance
    // instead of the much older support far below the move.
    const technicalSl = hasBullishBosAnchor
      ? breakoutContext.level * 0.997
      : wickSupport * 0.998;
    sl = options.sl || (hasBullishBosAnchor ? technicalSl : Math.min(technicalSl, entry - atrDist));
    
    // Realistic TP: Use Body Resistance, if none (ATH/Discovery), project 4x ATR instead of forced RR
    tp = options.tp || (bodyResistance !== Infinity ? bodyResistance * 0.998 : entry + (options.atr * 4));
    
    const slDistPercent = (entry - sl) / entry;
    // Skip technical rejection if manual/AI levels are provided
    const minSlDistance = hasBullishBosAnchor
      ? Math.max(0.0035, atrDistPercent * 0.35)
      : Math.max(MIN_SL_DISTANCE, atrDistPercent);
    if (!options.sl && (slDistPercent < minSlDistance || slDistPercent > MAX_SL_ALLOWED)) {
      logger.debug(`[RR] LONG ${currentPrice}: SL distance (${(slDistPercent*100).toFixed(2)}%) out of bounds (${(minSlDistance*100).toFixed(2)}% - ${(MAX_SL_ALLOWED*100).toFixed(0)}%)`);
      return null;
    }

    const riskPerUnit = entry - sl;
    const rewardPerUnit = tp - entry;
    const rr = riskPerUnit > 0 ? rewardPerUnit / riskPerUnit : 0;

    // FIX 3: Prevent Inflated R:R using unreachable historical TP
    if (rr > 8) {
      logger.debug(`LONG: R:R ${rr.toFixed(1)} too high, likely historical TP. Capping.`);
      return null;
    }

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
      if (notionalValue < minRequired) {
        logger.debug(`[RR] LONG: Notional ${notionalValue} < min ${minRequired} after cap`);
        return null;
      }
    }

    const margin = notionalValue / LEVERAGE;
    if (margin > ACCOUNT_BALANCE) {
      logger.debug(`[RR] LONG: Margin ${margin} > balance ${ACCOUNT_BALANCE}`);
      return null;
    }

    return { entry, sl, tp, rr, isScaled: scaled, positionSize: { risk: (Math.abs(entry - sl) * quantity), leverage: LEVERAGE, quantity, margin, notional: notionalValue } };
  } else {
    // [CONSERVATIVE] SL at Wick Resistance, TP at Body Support
    const wickResistance = (levels && levels.wick) ? levels.wick.resistance : (typeof options.resistance === 'number' ? options.resistance : Infinity);
    const bodySupport = (levels && levels.body) ? levels.body.support : (typeof levels === 'number' ? levels : 0);
    const hasBearishBosAnchor =
      breakoutContext &&
      breakoutContext.type === 'bearish_bos' &&
      Number.isFinite(breakoutContext.level) &&
      breakoutContext.level > entry;

    // Symmetric rule for bearish breakdowns: keep the stop just above the broken support.
    const technicalSl = hasBearishBosAnchor
      ? breakoutContext.level * 1.003
      : (wickResistance !== Infinity ? wickResistance * 1.002 : entry * 1.02);
    sl = options.sl || (hasBearishBosAnchor ? technicalSl : Math.max(technicalSl, entry + atrDist));
    
    // Realistic TP: Use Body Support, if none (Discovery), project 4x ATR downward
    tp = options.tp || (bodySupport > 0 ? bodySupport * 1.002 : Math.max(entry - (options.atr * 4), 0));
    
    const slDistPercent = (sl - entry) / entry;
    const minSlDistance = hasBearishBosAnchor
      ? Math.max(0.0035, atrDistPercent * 0.35)
      : Math.max(MIN_SL_DISTANCE, atrDistPercent);
    if (!options.sl && (slDistPercent < minSlDistance || slDistPercent > MAX_SL_ALLOWED)) {
      logger.debug(`[RR] SHORT ${currentPrice}: SL distance (${(slDistPercent*100).toFixed(2)}%) out of bounds (${(minSlDistance*100).toFixed(2)}% - ${(MAX_SL_ALLOWED*100).toFixed(0)}%)`);
      return null;
    }

    const riskPerUnit = sl - entry;
    const rewardPerUnit = entry - tp;
    const rr = riskPerUnit > 0 ? rewardPerUnit / riskPerUnit : 0;

    // FIX 3: Prevent Inflated R:R using unreachable historical TP
    if (rr > 8) {
      logger.debug(`SHORT: R:R ${rr.toFixed(1)} too high, likely historical TP. Capping.`);
      return null;
    }

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
      if (notionalValue < minRequired) {
        logger.debug(`[RR] SHORT: Notional ${notionalValue} < min ${minRequired} after cap`);
        return null;
      }
    }

    const margin = notionalValue / LEVERAGE;
    if (margin > ACCOUNT_BALANCE) {
      logger.debug(`[RR] SHORT: Margin ${margin} > balance ${ACCOUNT_BALANCE}`);
      return null;
    }

    return { entry, sl, tp, rr, isScaled: scaled, positionSize: { risk: (Math.abs(sl - entry) * quantity), leverage: LEVERAGE, quantity, margin, notional: notionalValue } };
  }
}

/**
 * Evaluate a symbol across multiple timeframes with Weighted Scoring v4.5.1.
 * Total Pts: 100 (Trend 30, Structure 20, Indicators 15, Micro 10, Retest 15, RR 10)
 * Includes MTA (M15 timing) and Candlestick Patterns.
 */
function evaluateSignal(symbol, data, options = {}) {
  const { D1, H4, H1, M15 } = data;
  const fundingRate = options.fundingRate || 0;
  const micro = options.micro || {};
  const emaParams = config.indicators.ema;
  const stochParams = config.indicators.stochastic;

  // ─── 1. Technical Analysis ──────────────────────────────
  const d1Trend = analyzeTrend(D1, emaParams);
  const h4SR = findSupportResistance(H4, config.indicators.swingLookback);
  const h4Trend = analyzeTrend(H4, emaParams);
  const h1Trend = analyzeTrend(H1, emaParams);
  const m15Trend = M15 ? analyzeTrend(M15, emaParams) : null;
  
  const bosConfirmationCandles = config.strategy.bosConfirmationCandles || 2;
  const h1Structure = analyzeStructure(H1, 3, { confirmationCandles: M15, confirmationCount: bosConfirmationCandles });
  const h1Stoch = calculateStochastic(H1, stochParams);
  const h4Stoch = calculateStochastic(H4, stochParams);
  const h1StochCross = detectStochCross(h1Stoch.kSeries, h1Stoch.dSeries);
  const h1Spike = detectAtSpike(H1, 14);
  const ema1321 = detectEma1321(H1);
  const h1OB = detectOrderBlocks(H1, { impulseMultiplier: 1.8, proximityPct: 0.025 });
  const h4OB = detectOrderBlocks(H4, { impulseMultiplier: 1.8, proximityPct: 0.03 });

  // Candlestick Analysis
  const { detectEngulfing, detectPinBar } = require('../indicators');
  const h1Engulfing = detectEngulfing(H1);
  const h1Pin = detectPinBar(H1);

  const breakoutBias = d1Trend.direction === 'bullish' ? 'LONG' : 'SHORT';
  const breakoutLevel = breakoutBias === 'LONG' ? h4SR.wick.support : h4SR.wick.resistance;
  const retestStatus = detectRetest(H1, breakoutLevel, breakoutBias);

  const distToWickSupport = h4SR.wick.support ? ((h4SR.currentPrice - h4SR.wick.support) / h4SR.currentPrice) * 100 : Infinity;
  const distToWickResistance = h4SR.wick.resistance !== Infinity ? ((h4SR.wick.resistance - h4SR.currentPrice) / h4SR.currentPrice) * 100 : Infinity;
  const pricePosition = classifyPricePosition(distToWickSupport, distToWickResistance);
  const supportTouches = h4SR.wick.supportTouches || 0;
  const resistanceTouches = h4SR.wick.resistanceTouches || 0;

  const atr = h1Spike.atr;
  const atrPercent = (atr / h4SR.currentPrice) * 100;

  // ─── 2. Initialize Scores ──────────────────────────────
  let longScore = 0;
  let shortScore = 0;
  const longReasons = [];
  const shortReasons = [];
  const warnings = [];
  const tags = [];

  // ─── CATEGORY 1: Macro Trend (D1/H4) & Timing (M15) (Max: 30 pts) ───
  if (d1Trend.direction === 'bullish') {
    longScore += d1Trend.strengthLabel === 'strong' ? 15 : 10;
    longReasons.push(`D1 trend bullish (${d1Trend.strengthLabel}) (+15)`);
  } else if (d1Trend.direction === 'bearish') {
    shortScore += d1Trend.strengthLabel === 'strong' ? 15 : 10;
    shortReasons.push(`D1 trend bearish (${d1Trend.strengthLabel}) (+15)`);
  }

  if (h4Trend.direction === 'bullish') {
    longScore += 10;
    longReasons.push(`H4 trend bullish (+10)`);
  } else if (h4Trend.direction === 'bearish') {
    shortScore += 10;
    shortReasons.push(`H4 trend bearish (+10)`);
  }

  // MTA Timing (M15)
  if (m15Trend) {
    if (m15Trend.direction === 'bullish') {
      longScore += 5;
      longReasons.push(`M15 timing confirmation (bullish) (+5)`);
    } else if (m15Trend.direction === 'bearish') {
      shortScore += 5;
      shortReasons.push(`M15 timing confirmation (bearish) (+5)`);
    }
  }

  // Trend Conflict Kill-switch
  const trendConflict = d1Trend.direction !== 'neutral' && h4Trend.direction !== 'neutral' && d1Trend.direction !== h4Trend.direction;
  if (trendConflict) {
    longScore -= 20;
    shortScore -= 20;
    warnings.push(`⚠️ Trend Conflict (D1 ${d1Trend.direction} vs H4 ${h4Trend.direction}). Low conviction.`);
    tags.push('CONFLICT');
  }

  // ─── CATEGORY 2: H1 Structure & Candles (Max: 20 pts) ───
  if (h1Structure.structure === 'bullish') {
    longScore += 10;
    longReasons.push(`H1 bullish structure (Higher Lows) (+10)`);
  } else if (h1Structure.structure === 'bearish') {
    shortScore += 10;
    shortReasons.push(`H1 bearish structure (Lower Highs) (+10)`);
  }

  if (h1Structure.bos) {
    if (h1Structure.bosType === 'bullish_bos') {
      if (pricePosition === 'near_resistance') {
        longScore += 2;
        warnings.push('⚠️ Bullish BoS muncul dekat resistance. Ini rawan false breakout, tunggu hold/retest dulu.');
      } else {
        longScore += 10;
        longReasons.push(`H1 bullish BoS (+10)`);
      }
    } else if (h1Structure.bosType === 'bearish_bos') {
      if (pricePosition === 'near_support') {
        shortScore += 2;
        warnings.push('⚠️ Bearish BoS muncul dekat support. Ini rawan false breakdown, tunggu hold/retest dulu.');
      } else {
        shortScore += 10;
        shortReasons.push(`H1 bearish BoS (+10)`);
      }
    }
  } else if (h1Structure.pendingBosType) {
      warnings.push(`⚠️ ${h1Structure.pendingBosType === 'bullish_bos' ? 'Breakout atas' : 'Breakdown bawah'} belum confirmed. Tunggu ${bosConfirmationCandles} candle M15 closed dulu sebelum dianggap BoS valid.`);
  }

  // Candlestick Bonus at Key Levels (Trend-Weighted Fix)
  if (pricePosition !== 'middle') {
    if (longScore > shortScore && (h1Engulfing.bull || h1Pin.bullPin)) {
      const bonus = d1Trend.direction === 'bullish' ? 10 : 2;
      longScore += bonus;
      longReasons.push(`🕯️ Bullish PA (+${bonus}, trend-dictated)`);
      if (bonus === 10) tags.push('PA CONFIRMED');
    } else if (shortScore > longScore && (h1Engulfing.bear || h1Pin.bearPin)) {
      const bonus = d1Trend.direction === 'bearish' ? 10 : 2;
      shortScore += bonus;
      shortReasons.push(`🕯️ Bearish PA (+${bonus}, trend-dictated)`);
      if (bonus === 10) tags.push('PA CONFIRMED');
    }
  }

  // ─── CATEGORY 3: Indicators (Max: 15 pts) ───
  if (ema1321.ema13AboveEma21) {
    longScore += 10;
    longReasons.push(`H1 EMA13 > EMA21 alignment (+10)`);
  } else {
    shortScore += 10;
    shortReasons.push(`H1 EMA13 < EMA21 alignment (+10)`);
  }

  // Stochastic Momentum Scoring (H1 + H4)
  if (h1Stoch.signal === 'oversold') {
    longScore += 8;
    longReasons.push(`H1 Stochastic oversold (K=${h1Stoch.k.toFixed(1)}) — long momentum expected (+8)`);
  } else if (h1Stoch.signal === 'overbought') {
    shortScore += 8;
    shortReasons.push(`H1 Stochastic overbought (K=${h1Stoch.k.toFixed(1)}) — short momentum expected (+8)`);
  }

  if (h4Stoch.signal === 'oversold') {
    longScore += 5;
    longReasons.push(`H4 Stochastic oversold (K=${h4Stoch.k.toFixed(1)}) — bullish momentum building (+5)`);
  } else if (h4Stoch.signal === 'overbought') {
    shortScore += 5;
    shortReasons.push(`H4 Stochastic overbought (K=${h4Stoch.k.toFixed(1)}) — bearish momentum building (+5)`);
  }

  // Stochastic crossover in zone (higher conviction)
  if (h1StochCross.crossBullish && h1StochCross.crossInZone) {
    longScore += 5;
    longReasons.push(`H1 Stoch bullish cross in oversold zone (+5)`);
  } else if (h1StochCross.crossBearish && h1StochCross.crossInZone) {
    shortScore += 5;
    shortReasons.push(`H1 Stoch bearish cross in overbought zone (+5)`);
  }

  // Low Volatility Filter
  const minVol = config.filters.minAtrPercent || 0.5;
  if (atrPercent < minVol) {
    longScore -= 10;
    shortScore -= 10;
    warnings.push(`✋ Market flat/sideways (ATR: ${atrPercent.toFixed(2)}%). Avoid entries.`);
  } else {
    longScore += 5;
    shortScore += 5;
  }

  // Price location filter: treat resistance/support context as directional bias,
  // not just a label for charting.
  if (pricePosition === 'near_resistance') {
    shortScore += 12;
    longScore -= 12;
    shortReasons.push('H4 price dekat resistance — rejection/failed breakout lebih likely');
    warnings.push('⚠️ Price dekat resistance. Long butuh confluence ekstra dan retest yang bersih.');
  } else if (pricePosition === 'near_support') {
    longScore += 12;
    shortScore -= 12;
    longReasons.push('H4 price dekat support — bounce lebih likely');
    warnings.push('ℹ️ Price dekat support. Short butuh breakdown valid, bukan sekadar wick.');
  } else {
    longScore -= 8;
    shortScore -= 8;
    warnings.push('ℹ️ Price berada di middle zone. Edge menurun, tunggu area level yang lebih jelas.');
  }

  // Repeated-touch levels behave more like magnets for rejection/bounce until proven broken.
  const repeatedLevelTouches = config.strategy.repeatedLevelTouches || 3;
  const standbyMinRr = config.strategy.standbyMinRr || 2.0;

  if (pricePosition === 'near_resistance' && resistanceTouches >= repeatedLevelTouches) {
    const touchBonus = resistanceTouches >= 5 ? 10 : 7;
    shortScore += touchBonus;
    longScore -= 4;
    shortReasons.push(`Resistance H4 sudah dites ${resistanceTouches}x — standby SHORT saat rejection lebih valid (+${touchBonus})`);
    tags.push('REPEATED RESISTANCE');
  } else if (pricePosition === 'near_support' && supportTouches >= repeatedLevelTouches) {
    const touchBonus = supportTouches >= 5 ? 10 : 7;
    longScore += touchBonus;
    shortScore -= 4;
    longReasons.push(`Support H4 sudah dites ${supportTouches}x — standby LONG saat bounce lebih valid (+${touchBonus})`);
    tags.push('REPEATED SUPPORT');
  }

  const standbyBias =
    pricePosition === 'near_resistance' && resistanceTouches >= repeatedLevelTouches
      ? 'SHORT'
      : pricePosition === 'near_support' && supportTouches >= repeatedLevelTouches
        ? 'LONG'
        : null;
  const standbyTouches = standbyBias === 'SHORT' ? resistanceTouches : standbyBias === 'LONG' ? supportTouches : 0;
  const standbyLevel = standbyBias === 'SHORT' ? h4SR.wick.support : standbyBias === 'LONG' ? h4SR.wick.resistance : null;

  // ─── CATEGORY 4: Micro Structure (Max: 10 pts) ───
  const microResult = analyzeMicrostructure(micro, h4SR.currentPrice);
  longScore += Math.min(10, microResult.longBonus);
  shortScore += Math.min(10, microResult.shortBonus);
  longReasons.push(...microResult.reasons.long.map(r => `${r} (Micro)`));
  shortReasons.push(...microResult.reasons.short.map(r => `${r} (Micro)`));
  tags.push(...microResult.tags);

  // ─── CATEGORY 5: Breakout & Retest (Max: 15 pts) ───
  if (retestStatus === 'CONFIRMED') {
    if (breakoutBias === 'LONG') {
      longScore += 15;
      longReasons.push(`H1 breakout retest confirmed (+15)`);
    } else {
      shortScore += 15;
      shortReasons.push(`H1 breakdown retest confirmed (+15)`);
    }
  } else {
    // Directional OB scoring — bullish OB favours LONG, bearish OB favours SHORT
    if (h1OB.inBullishOB || h4OB.inBullishOB) {
      longScore += 10;
      longReasons.push(`Inside Bullish Order Block — institutional demand zone (+10)`);
    }
    if (h1OB.inBearishOB || h4OB.inBearishOB) {
      shortScore += 10;
      shortReasons.push(`Inside Bearish Order Block — institutional supply zone (+10)`);
    }
  }

  // ─── CATEGORY 6: R:R & Risk (Max: 10 pts) ───
  const bias = longScore > shortScore ? 'LONG' : 'SHORT';
  const breakoutContext =
    bias === 'LONG' && h1Structure.bosType === 'bullish_bos' && Number.isFinite(h1Structure.lastSwingHigh)
      ? { type: 'bullish_bos', level: h1Structure.lastSwingHigh }
      : bias === 'SHORT' && h1Structure.bosType === 'bearish_bos' && Number.isFinite(h1Structure.lastSwingLow)
        ? { type: 'bearish_bos', level: h1Structure.lastSwingLow }
        : null;
  const riskReward = calculateRiskReward(bias, h4SR.currentPrice, h4SR, { 
    atr,
    accountBalance: options.accountBalance || config.strategy.accountBalance,
    stepSize: options.stepSize,
    minNotional: options.minNotional,
    breakoutContext,
  });

  if (riskReward) {
    if (riskReward.rr >= 3.0) {
      longScore += 10;
      shortScore += 10;
      longReasons.push(`Elite R:R Ratio (${riskReward.rr.toFixed(1)}) (+10)`);
    } else if (riskReward.rr >= 2.0) {
      longScore += 5;
      shortScore += 5;
      longReasons.push(`Good R:R Ratio (${riskReward.rr.toFixed(1)}) (+5)`);
    } else {
        // Rule: R:R must be 2.0+ or it's a weak setup
        longScore -= 15;
        shortScore -= 15;
    }
  }

  // ─── FINAL SELECTION ──────────────────────────────────
  let finalScore = longScore > shortScore ? longScore : shortScore;
  let reasons = longScore > shortScore ? longReasons : shortReasons;
  
  if (finalScore < 30) {
    return options.includeRejectionReason ? { signal: null, rejectionReason: `Weighted score too low (${finalScore}/100)` } : null;
  }

  if (!riskReward || riskReward.rr < 2.0) {
      return options.includeRejectionReason ? { signal: null, rejectionReason: `Poor R:R Ratio (${riskReward ? riskReward.rr.toFixed(1) : 'N/A'}). Need min 2.0.` } : null;
  }

  const standbyOnly = Boolean(standbyBias && bias === standbyBias && riskReward && riskReward.rr < standbyMinRr);
  if (standbyOnly) {
    const rrValue = riskReward.rr.toFixed(2);
    const targetLabel = standbyBias === 'SHORT' ? 'support' : 'resistance';
    const standbyReason = `${symbol} dekat ${standbyBias === 'SHORT' ? 'resistance' : 'support'} kuat (${standbyTouches}x touch), tapi R:R ke ${targetLabel} terdekat baru ${rrValue}. Tetap standby dulu, tunggu > ${standbyMinRr.toFixed(1)} sebelum naik jadi signal.`;

    return {
      symbol,
      bias: standbyBias,
      score: finalScore,
      reasons,
      warnings,
      tags: [...tags, 'STANDBY_SETUP'],
      analysis: {
        d1Trend, h4SR, h4Trend, h1Trend, m15Trend, h1Structure, ema1321, h4OB, h1OB, h1Engulfing, h1Pin, h1Stoch, h4Stoch
      },
      riskReward,
      isStrict: false,
      lowConfidence: true,
      fundingRate: (fundingRate * 100).toFixed(4) + '%',
      trading_type: 'MONITORING',
      microstructure: microResult.raw,
      standbyOnly: true,
      standbyReason,
      standbyContext: {
        bias: standbyBias,
        touches: standbyTouches,
        targetLevel: standbyLevel,
      },
    };
  }

  const distFromLvl = bias === 'LONG' ? distToWickSupport : distToWickResistance;
  if (distFromLvl > 5.0) {
    finalScore -= 10;
    tags.push('VERTICAL ENTRY');
    warnings.push(`✋ Price is ${distFromLvl.toFixed(1)}% away from key level (FOMO).`);
  }

  // God-Candle Penalty (ATR Spike)
  if (h1Spike.spike) {
    finalScore -= 20;
    tags.push('GOD-CANDLE ALERT');
    warnings.push(`☄️ Abnormal H1 ATR Spike (${h1Spike.ratio.toFixed(1)}x average). Avoid FOMO at price peaks.`);
  }


  // Rule 6: Technical score >= 70% first. AI is final sanity check.
  // Rule 3: Hanya hitung POSITIVE reasons untuk isStrict (menghindari false positive dari warnings)
  const isStrict = finalScore >= 55 && reasons.length >= 3;
  const tradingType = distFromLvl < 4.0 ? 'SWING / DAY TRADING' : 'MOMENTUM SCALP';

  return {
    symbol,
    bias,
    score: finalScore,
    reasons,
    warnings,
    tags,
    analysis: {
      d1Trend, h4SR, h4Trend, h1Trend, m15Trend, h1Structure, ema1321, h4OB, h1OB, h1Engulfing, h1Pin, h1Stoch, h4Stoch
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
