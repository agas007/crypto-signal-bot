const config = require('../../config');
const logger = require('../../utils/logger');
const { 
  analyzeTrend, calculateStochastic, findSupportResistance,
  analyzeStructure, detectAtSpike, detectRetest,
  detectCompression, detectEma1321, detectStochCross, detectOrderBlocks
} = require('../indicators');

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
 * Relaxed version: wider threshold (default 5% instead of 2%).
 *
 * @param {number} distToSupport - Distance to nearest support as %
 * @param {number} distToResistance - Distance to nearest resistance as %
 * @param {number} [threshold=4.0] - % threshold for "near"
 * @returns {'near_support'|'near_resistance'|'middle'}
 */
function classifyPricePosition(distToSupport, distToResistance, threshold = config.strategy.pricePositionThresholdPct || 4.0) {
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
  const makeFailure = (failureReason, extra = {}) => ({
    entry: currentPrice,
    sl: null,
    tp: null,
    rr: null,
    isScaled: false,
    failureReason,
    ...extra,
  });

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
    const trendSupport = levels?.trend?.support?.currentValue;
    const trendResistance = levels?.trend?.resistance?.currentValue;
    const wickSupport = (levels && levels.wick) ? levels.wick.support : (typeof levels === 'number' ? levels : 0);
    const bodyResistance = (levels && levels.body) ? levels.body.resistance : (typeof options.resistance === 'number' ? options.resistance : Infinity);
    const supportAnchor = Number.isFinite(trendSupport) && trendSupport > 0 ? trendSupport : wickSupport;
    const resistanceAnchor = Number.isFinite(trendResistance) && trendResistance > entry ? trendResistance : bodyResistance;
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
      : supportAnchor * 0.998;
    sl = options.sl || (hasBullishBosAnchor ? technicalSl : Math.min(technicalSl, entry - atrDist));
    
    // Realistic TP: Use Body Resistance, if none (ATH/Discovery), project 4x ATR instead of forced RR
    tp = options.tp || (resistanceAnchor !== Infinity ? resistanceAnchor * 0.998 : entry + (options.atr * 4));
    
    const slDistPercent = (entry - sl) / entry;
    // Skip technical rejection if manual/AI levels are provided
    const minSlDistance = hasBullishBosAnchor
      ? Math.max(0.0035, atrDistPercent * 0.35)
      : Math.max(MIN_SL_DISTANCE, atrDistPercent);
    if (!options.sl && (slDistPercent < minSlDistance || slDistPercent > MAX_SL_ALLOWED)) {
      logger.debug(`[RR] LONG ${currentPrice}: SL distance (${(slDistPercent*100).toFixed(2)}%) out of bounds (${(minSlDistance*100).toFixed(2)}% - ${(MAX_SL_ALLOWED*100).toFixed(0)}%)`);
      return makeFailure(
        `SL distance out of bounds (${(slDistPercent * 100).toFixed(2)}%, need ${(minSlDistance * 100).toFixed(2)}%-${(MAX_SL_ALLOWED * 100).toFixed(0)}%)`
      );
    }

    const riskPerUnit = entry - sl;
    const rewardPerUnit = tp - entry;
    const rr = riskPerUnit > 0 ? rewardPerUnit / riskPerUnit : 0;

    // FIX 3: Prevent Inflated R:R using unreachable historical TP
    if (rr > 8) {
      logger.debug(`LONG: R:R ${rr.toFixed(1)} too high, likely historical TP. Capping.`);
      return makeFailure(`R:R too high / likely unrealistic TP (${rr.toFixed(2)})`);
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
        return makeFailure(`Notional below min after cap (${notionalValue.toFixed(2)} < ${minRequired.toFixed(2)})`);
      }
    }

    const margin = notionalValue / LEVERAGE;
    if (margin > ACCOUNT_BALANCE) {
      logger.debug(`[RR] LONG: Margin ${margin} > balance ${ACCOUNT_BALANCE}`);
      return makeFailure(`Margin above balance (${margin.toFixed(2)} > ${ACCOUNT_BALANCE.toFixed(2)})`);
    }

    return { entry, sl, tp, rr, isScaled: scaled, positionSize: { risk: (Math.abs(entry - sl) * quantity), leverage: LEVERAGE, quantity, margin, notional: notionalValue } };
  } else {
    // [CONSERVATIVE] SL at Wick Resistance, TP at Body Support
    const trendSupport = levels?.trend?.support?.currentValue;
    const trendResistance = levels?.trend?.resistance?.currentValue;
    const wickResistance = (levels && levels.wick) ? levels.wick.resistance : (typeof options.resistance === 'number' ? options.resistance : Infinity);
    const bodySupport = (levels && levels.body) ? levels.body.support : (typeof levels === 'number' ? levels : 0);
    const resistanceAnchor = Number.isFinite(trendResistance) && trendResistance > entry ? trendResistance : wickResistance;
    const supportAnchor = Number.isFinite(trendSupport) && trendSupport > 0 && trendSupport < entry ? trendSupport : bodySupport;
    const hasBearishBosAnchor =
      breakoutContext &&
      breakoutContext.type === 'bearish_bos' &&
      Number.isFinite(breakoutContext.level) &&
      breakoutContext.level > entry;

    // Symmetric rule for bearish breakdowns: keep the stop just above the broken support.
    const technicalSl = hasBearishBosAnchor
      ? breakoutContext.level * 1.003
      : (resistanceAnchor !== Infinity ? resistanceAnchor * 1.002 : entry * 1.02);
    sl = options.sl || (hasBearishBosAnchor ? technicalSl : Math.max(technicalSl, entry + atrDist));
    
    // Realistic TP: Use Body Support, if none (Discovery), project 4x ATR downward
    tp = options.tp || (supportAnchor > 0 ? supportAnchor * 1.002 : Math.max(entry - (options.atr * 4), 0));
    
    const slDistPercent = (sl - entry) / entry;
    const minSlDistance = hasBearishBosAnchor
      ? Math.max(0.0035, atrDistPercent * 0.35)
      : Math.max(MIN_SL_DISTANCE, atrDistPercent);
    if (!options.sl && (slDistPercent < minSlDistance || slDistPercent > MAX_SL_ALLOWED)) {
      logger.debug(`[RR] SHORT ${currentPrice}: SL distance (${(slDistPercent*100).toFixed(2)}%) out of bounds (${(minSlDistance*100).toFixed(2)}% - ${(MAX_SL_ALLOWED*100).toFixed(0)}%)`);
      return makeFailure(
        `SL distance out of bounds (${(slDistPercent * 100).toFixed(2)}%, need ${(minSlDistance * 100).toFixed(2)}%-${(MAX_SL_ALLOWED * 100).toFixed(0)}%)`
      );
    }

    const riskPerUnit = sl - entry;
    const rewardPerUnit = entry - tp;
    const rr = riskPerUnit > 0 ? rewardPerUnit / riskPerUnit : 0;

    // FIX 3: Prevent Inflated R:R using unreachable historical TP
    if (rr > 8) {
      logger.debug(`SHORT: R:R ${rr.toFixed(1)} too high, likely historical TP. Capping.`);
      return makeFailure(`R:R too high / likely unrealistic TP (${rr.toFixed(2)})`);
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
        return makeFailure(`Notional below min after cap (${notionalValue.toFixed(2)} < ${minRequired.toFixed(2)})`);
      }
    }

    const margin = notionalValue / LEVERAGE;
    if (margin > ACCOUNT_BALANCE) {
      logger.debug(`[RR] SHORT: Margin ${margin} > balance ${ACCOUNT_BALANCE}`);
      return makeFailure(`Margin above balance (${margin.toFixed(2)} > ${ACCOUNT_BALANCE.toFixed(2)})`);
    }

    return { entry, sl, tp, rr, isScaled: scaled, positionSize: { risk: (Math.abs(sl - entry) * quantity), leverage: LEVERAGE, quantity, margin, notional: notionalValue } };
  }
}

function pickKeyLevel(currentPrice, candidates, side) {
  const normalized = (candidates || [])
    .filter((item) => Number.isFinite(item?.value) && item.value > 0)
    .map((item) => ({
      ...item,
      distancePct: currentPrice > 0 ? Math.abs(currentPrice - item.value) / currentPrice : Infinity,
      sideMatch: side === 'support' ? item.value < currentPrice : item.value > currentPrice,
    }));

  const sideMatched = normalized.filter((item) => item.sideMatch);
  const pool = sideMatched.length > 0 ? sideMatched : normalized;

  if (!pool.length) {
    return {
      value: side === 'support' ? 0 : Infinity,
      touches: 0,
      source: 'none',
      distancePct: Infinity,
      sideMatch: false,
    };
  }

  pool.sort((a, b) => {
    if (a.distancePct !== b.distancePct) return a.distancePct - b.distancePct;
    return (b.touches || 0) - (a.touches || 0);
  });

  return pool[0];
}

function getPatternScoreWeight(patternName) {
  switch (patternName) {
    case 'range':
      return 12;
    case 'ascending_triangle':
    case 'descending_triangle':
      return 20;
    case 'symmetric_triangle':
      return 18;
    case 'falling_wedge':
    case 'rising_wedge':
      return 18;
    case 'ascending_channel':
    case 'descending_channel':
      return 10;
    case 'consolidation':
      return 6;
    default:
      return 0;
  }
}

function buildRejectionDiagnostics({
  bias,
  longScore,
  shortScore,
  finalScore = null,
  reasons = [],
  warnings = [],
  tags = [],
  analysis = null,
  riskReward = null,
  pricePosition = null,
  d1Trend = null,
  h4Trend = null,
  h1Trend = null,
  h1Structure = null,
  h1Stoch = null,
  h4Stoch = null,
  standbyBias = null,
  standbyReason = null,
}) {
  return {
    bias,
    longScore,
    shortScore,
    finalScore,
    reasons: [...reasons],
    warnings: [...warnings],
    tags: [...tags],
    pricePosition,
    analysis,
    riskReward: riskReward
      ? {
          entry: riskReward.entry,
          sl: riskReward.sl,
          tp: riskReward.tp,
          rr: riskReward.rr,
          isScaled: riskReward.isScaled,
        }
      : null,
    trends: {
      d1: d1Trend?.direction || null,
      h4: h4Trend?.direction || null,
      h1: h1Trend?.direction || null,
    },
    structure: h1Structure
      ? {
          structure: h1Structure.structure || null,
          bos: Boolean(h1Structure.bos),
          bosType: h1Structure.bosType || null,
          pendingBosType: h1Structure.pendingBosType || null,
        }
      : null,
    stochastic: {
      h1: h1Stoch ? { signal: h1Stoch.signal || null, k: h1Stoch.k, d: h1Stoch.d } : null,
      h4: h4Stoch ? { signal: h4Stoch.signal || null, k: h4Stoch.k, d: h4Stoch.d } : null,
    },
    standbyBias,
    standbyReason,
  };
}

/**
 * Evaluate a symbol with H4 support/resistance as the primary edge.
 * D1 is kept for diagnostics only, not as a hard directional gate.
 */
function evaluateSignal(symbol, data, options = {}) {
  const { D1, H4, H1, M15 } = data;
  const fundingRate = options.fundingRate || 0;
  const scoreWeights = options.scoreWeights || config.strategy.scoreWeights || {};
  const noStructurePenalty = scoreWeights.noStructurePenalty ?? 4;
  const lowVolPenalty = scoreWeights.lowVolPenalty ?? 6;
  const middleZonePenalty = scoreWeights.middleZonePenalty ?? 4;
  const nearLevelDirectionalBias = scoreWeights.nearLevelDirectionalBias ?? 9;
  const repeatedTouchBonus = scoreWeights.repeatedTouchBonus ?? 6;
  const strongRepeatedTouchBonus = scoreWeights.strongRepeatedTouchBonus ?? 8;
  const retestPendingPenalty = scoreWeights.retestPendingPenalty ?? 4;
  const rrBelowMinPenalty = scoreWeights.rrBelowMinPenalty ?? 10;
  const emaParams = config.indicators.ema;
  const stochParams = config.indicators.stochastic;

  // ─── 1. Technical Analysis ──────────────────────────────
  const d1Trend = analyzeTrend(D1, emaParams);
  const h4SR = findSupportResistance(H4, config.indicators.swingLookback);
  const h4Pattern = h4SR.pattern || { detected: false, breakout: false, breakoutDirection: null };
  const h4Trend = analyzeTrend(H4, emaParams);
  const h1Trend = analyzeTrend(H1, emaParams);
  const m15Trend = M15 ? analyzeTrend(M15, emaParams) : null;
  
  const bosConfirmationCandles = config.strategy.bosConfirmationCandles || 2;
  const h1Structure = analyzeStructure(H1, 3, { confirmationCandles: M15, confirmationCount: bosConfirmationCandles });
  const h1Stoch = calculateStochastic(H1, stochParams);
  const h4Stoch = calculateStochastic(H4, stochParams);
  const h1StochCross = detectStochCross(h1Stoch.kSeries, h1Stoch.dSeries);
  const h1Spike = detectAtSpike(H1, 14);
  const h1Compression = detectCompression(H1, {
    recentWindow: 12,
    compareWindow: 12,
    maxRangePct: 0.05,
    minContraction: 0.82,
    breakoutBufferPct: 0.0015,
  });
  const ema1321 = detectEma1321(H1);
  const h1OB = detectOrderBlocks(H1, { impulseMultiplier: 1.8, proximityPct: 0.025 });
  const h4OB = detectOrderBlocks(H4, { impulseMultiplier: 1.8, proximityPct: 0.03 });

  // Candlestick Analysis
  const { detectEngulfing, detectPinBar } = require('../indicators');
  const h1Engulfing = detectEngulfing(H1);
  const h1Pin = detectPinBar(H1);

  const supportLevel = pickKeyLevel(h4SR.currentPrice, [
    { value: h4SR.trend?.support?.currentValue, touches: h4SR.trend?.support?.touches || 0, source: 'trend_support' },
    { value: h4SR.wick.support, touches: h4SR.wick.supportTouches || 0, source: 'wick_support' },
    { value: h4SR.body.support, touches: h4SR.body.supportTouches || 0, source: 'body_support' },
    { value: h4Pattern.lower?.currentValue, touches: h4Pattern.lower?.touches || 0, source: 'pattern_lower' },
  ], 'support');
  const resistanceLevel = pickKeyLevel(h4SR.currentPrice, [
    { value: h4SR.trend?.resistance?.currentValue, touches: h4SR.trend?.resistance?.touches || 0, source: 'trend_resistance' },
    { value: h4SR.wick.resistance, touches: h4SR.wick.resistanceTouches || 0, source: 'wick_resistance' },
    { value: h4SR.body.resistance, touches: h4SR.body.resistanceTouches || 0, source: 'body_resistance' },
    { value: h4Pattern.upper?.currentValue, touches: h4Pattern.upper?.touches || 0, source: 'pattern_upper' },
  ], 'resistance');

  const distToSupport = supportLevel.value && supportLevel.value < h4SR.currentPrice
    ? ((h4SR.currentPrice - supportLevel.value) / h4SR.currentPrice) * 100
    : Infinity;
  const distToResistance = resistanceLevel.value !== Infinity && resistanceLevel.value > h4SR.currentPrice
    ? ((resistanceLevel.value - h4SR.currentPrice) / h4SR.currentPrice) * 100
    : Infinity;
  const pricePosition = classifyPricePosition(distToSupport, distToResistance, config.strategy.pricePositionThresholdPct || 4.0);
  const supportTouches = supportLevel.touches || 0;
  const resistanceTouches = resistanceLevel.touches || 0;
  const repeatedLevelTouches = config.strategy.repeatedLevelTouches || 3;
  const strongH4LevelSetup =
    (pricePosition === 'near_resistance' && resistanceTouches >= repeatedLevelTouches) ||
    (pricePosition === 'near_support' && supportTouches >= repeatedLevelTouches);

  const breakoutBias = h4Pattern.breakoutDirection === 'bullish'
    ? 'LONG'
    : h4Pattern.breakoutDirection === 'bearish'
      ? 'SHORT'
      : pricePosition === 'near_support'
        ? 'LONG'
        : pricePosition === 'near_resistance'
          ? 'SHORT'
          : h4Trend.direction === 'bullish'
            ? 'LONG'
            : 'SHORT';
  const breakoutLevel =
    h4Pattern.breakout && h4Pattern.breakoutDirection === 'bullish' && Number.isFinite(h4Pattern.upper?.currentValue)
      ? h4Pattern.upper.currentValue
      : h4Pattern.breakout && h4Pattern.breakoutDirection === 'bearish' && Number.isFinite(h4Pattern.lower?.currentValue)
        ? h4Pattern.lower.currentValue
        : breakoutBias === 'LONG'
          ? supportLevel.value
          : resistanceLevel.value;
  const retestStatus = detectRetest(H1, breakoutLevel, breakoutBias);

  const atr = h1Spike.atr;
  const atrPercent = (atr / h4SR.currentPrice) * 100;

  // ─── 2. Initialize Scores ──────────────────────────────
  let longScore = 0;
  let shortScore = 0;
  const longReasons = [];
  const shortReasons = [];
  const warnings = [];
  const tags = [];

  // ─── CATEGORY 1: H4 regime & timing (Max: 25 pts) ───
  if (h4Trend.direction === 'bullish') {
    longScore += 18;
    longReasons.push(`H4 trend bullish (+18)`);
  } else if (h4Trend.direction === 'bearish') {
    shortScore += 18;
    shortReasons.push(`H4 trend bearish (+18)`);
  }

  // MTA Timing (M15)
  if (m15Trend) {
    if (m15Trend.direction === 'bullish') {
      longScore += 3;
      longReasons.push(`M15 timing confirmation (bullish) (+3)`);
    } else if (m15Trend.direction === 'bearish') {
      shortScore += 3;
      shortReasons.push(`M15 timing confirmation (bearish) (+3)`);
    }
  }

  if (h1Compression.compressed) {
    tags.push('NARROW RANGE');
    warnings.push(`ℹ️ H1 range lagi sempit (${(h1Compression.rangePct * 100).toFixed(2)}%). Tunggu break yang valid, bukan entry di tengah compression.`);
  }

  if (h1Compression.breakout) {
    if (h1Compression.direction === 'bullish') {
      longScore += 12;
      longReasons.push(`H1 narrow-range breakout ke atas setelah compression (+12)`);
      tags.push('COMPRESSION BREAKOUT UP');
    } else if (h1Compression.direction === 'bearish') {
      shortScore += 12;
      shortReasons.push(`H1 narrow-range breakout ke bawah setelah compression (+12)`);
      tags.push('COMPRESSION BREAKOUT DOWN');
    }
  }

  if (h4Pattern.detected) {
    tags.push(h4Pattern.name.toUpperCase());
    const patternLabel = h4Pattern.name === 'range' && h4Pattern.rangeDetected ? 'range / box' : h4Pattern.name;
    warnings.push(`ℹ️ H4 pattern: ${patternLabel} (${(h4Pattern.gapPct * 100).toFixed(2)}% gap, contraction ${(h4Pattern.contractionRatio * 100).toFixed(0)}%).`);
    const patternWeight = getPatternScoreWeight(h4Pattern.name);

    if (h4Pattern.breakout) {
      const breakoutRetestStatus = detectRetest(H1, breakoutLevel, breakoutBias);
      const retestBonus = breakoutRetestStatus === 'CONFIRMED' ? 8 : breakoutRetestStatus === 'PENDING' ? -6 : 0;

      if (h4Pattern.breakoutDirection === 'bullish') {
        longScore += patternWeight + retestBonus;
        longReasons.push(`H4 ${patternLabel} bullish breakout (+${patternWeight}${retestBonus > 0 ? ` +${retestBonus}` : retestBonus < 0 ? ` ${retestBonus}` : ''})`);
        tags.push(h4Pattern.name === 'range' ? 'RANGE BREAKOUT UP' : 'PATTERN BREAKOUT UP');
        if (breakoutRetestStatus === 'CONFIRMED') tags.push('BREAKOUT_RETEST_CONTINUATION');
      } else if (h4Pattern.breakoutDirection === 'bearish') {
        shortScore += patternWeight + retestBonus;
        shortReasons.push(`H4 ${patternLabel} bearish breakout (+${patternWeight}${retestBonus > 0 ? ` +${retestBonus}` : retestBonus < 0 ? ` ${retestBonus}` : ''})`);
        tags.push(h4Pattern.name === 'range' ? 'RANGE BREAKOUT DOWN' : 'PATTERN BREAKOUT DOWN');
        if (breakoutRetestStatus === 'CONFIRMED') tags.push('BREAKOUT_RETEST_CONTINUATION');
      }
    } else if (h4Pattern.direction === 'bullish') {
      longScore += Math.max(4, Math.floor(patternWeight / 4));
      longReasons.push(`H4 ${h4Pattern.name} bullish bias (+${Math.max(4, Math.floor(patternWeight / 4))})`);
    } else if (h4Pattern.direction === 'bearish') {
      shortScore += Math.max(4, Math.floor(patternWeight / 4));
      shortReasons.push(`H4 ${h4Pattern.name} bearish bias (+${Math.max(4, Math.floor(patternWeight / 4))})`);
    }
  }

  // ─── CATEGORY 2: H1 Structure & Candles (Max: 20 pts) ───
  if (h1Structure.structure === 'bullish') {
    longScore += 10;
    longReasons.push(`H1 bullish structure (Higher Lows) (+10)`);
  } else if (h1Structure.structure === 'bearish') {
    shortScore += 10;
    shortReasons.push(`H1 bearish structure (Lower Highs) (+10)`);
  } else {
    // H1 no_structure = ranging/mixed. Untuk setup H4 yang sudah bolak-balik dites,
    // kita jangan bunuh terlalu keras karena edge-nya memang datang dari level H4.
    const appliedNoStructurePenalty = strongH4LevelSetup
      ? Math.max(1, Math.floor(noStructurePenalty / 2))
      : noStructurePenalty;
    longScore -= appliedNoStructurePenalty;
    shortScore -= appliedNoStructurePenalty;
    warnings.push('⚠️ H1 structure tidak terbentuk (ranging/mixed).');
    tags.push('NO_STRUCTURE');
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

  // Candlestick Bonus at Key Levels (H4-weighted fix)
  if (pricePosition !== 'middle') {
    if (longScore > shortScore && (h1Engulfing.bull || h1Pin.bullPin)) {
      const bonus = h4Trend.direction === 'bullish' ? 10 : 2;
      longScore += bonus;
      longReasons.push(`🕯️ Bullish PA (+${bonus}, H4-dictated)`);
      if (bonus === 10) tags.push('PA CONFIRMED');
    } else if (shortScore > longScore && (h1Engulfing.bear || h1Pin.bearPin)) {
      const bonus = h4Trend.direction === 'bearish' ? 10 : 2;
      shortScore += bonus;
      shortReasons.push(`🕯️ Bearish PA (+${bonus}, H4-dictated)`);
      if (bonus === 10) tags.push('PA CONFIRMED');
    }
  }

  // ─── CATEGORY 3: Indicators (Max: 15 pts) ───
  if (ema1321.ema13AboveEma21) {
    longScore += 6;
    longReasons.push(`H1 EMA13 > EMA21 alignment (+6)`);
  } else {
    shortScore += 6;
    shortReasons.push(`H1 EMA13 < EMA21 alignment (+6)`);
  }

  // Stochastic Momentum Scoring (H1 + H4)
  if (h1Stoch.signal === 'oversold') {
    longScore += 4;
    longReasons.push(`H1 Stochastic oversold (K=${h1Stoch.k.toFixed(1)}) — long momentum expected (+4)`);
  } else if (h1Stoch.signal === 'overbought') {
    shortScore += 4;
    shortReasons.push(`H1 Stochastic overbought (K=${h1Stoch.k.toFixed(1)}) — short momentum expected (+4)`);
  }

  if (h4Stoch.signal === 'oversold') {
    longScore += 3;
    longReasons.push(`H4 Stochastic oversold (K=${h4Stoch.k.toFixed(1)}) — bullish momentum building (+3)`);
  } else if (h4Stoch.signal === 'overbought') {
    shortScore += 3;
    shortReasons.push(`H4 Stochastic overbought (K=${h4Stoch.k.toFixed(1)}) — bearish momentum building (+3)`);
  }

  // Stochastic crossover in zone (higher conviction)
  if (h1StochCross.crossBullish && h1StochCross.crossInZone) {
    longScore += 3;
    longReasons.push(`H1 Stoch bullish cross in oversold zone (+3)`);
  } else if (h1StochCross.crossBearish && h1StochCross.crossInZone) {
    shortScore += 3;
    shortReasons.push(`H1 Stoch bearish cross in overbought zone (+3)`);
  }

  // Low Volatility Filter
  const minVol = config.filters.minAtrPercent || 0.5;
  if (atrPercent < minVol) {
    longScore -= lowVolPenalty;
    shortScore -= lowVolPenalty;
    warnings.push(`✋ Market flat/sideways (ATR: ${atrPercent.toFixed(2)}%). Avoid entries.`);
  } else {
    longScore += 5;
    shortScore += 5;
  }

  // Price location filter: treat resistance/support context as directional bias,
  // not just a label for charting.
  if (pricePosition === 'near_resistance') {
    shortScore += nearLevelDirectionalBias;
    longScore -= nearLevelDirectionalBias;
    shortReasons.push('H4 price dekat resistance — rejection/failed breakout lebih likely');
    warnings.push('⚠️ Price dekat resistance. Long butuh confluence ekstra dan retest yang bersih.');
  } else if (pricePosition === 'near_support') {
    longScore += nearLevelDirectionalBias;
    shortScore -= nearLevelDirectionalBias;
    longReasons.push('H4 price dekat support — bounce lebih likely');
    warnings.push('ℹ️ Price dekat support. Short butuh breakdown valid, bukan sekadar wick.');
  } else {
    const appliedMiddleZonePenalty = strongH4LevelSetup
      ? Math.max(0, middleZonePenalty - 1)
      : middleZonePenalty;
    longScore -= appliedMiddleZonePenalty;
    shortScore -= appliedMiddleZonePenalty;
    warnings.push('ℹ️ Price berada di middle zone. Edge menurun, tunggu area level yang lebih jelas.');
  }

  // Repeated-touch levels behave more like magnets for rejection/bounce until proven broken.
  if (pricePosition === 'near_resistance' && resistanceTouches >= repeatedLevelTouches) {
    const touchBonus = resistanceTouches >= 5 ? strongRepeatedTouchBonus : repeatedTouchBonus;
    shortScore += touchBonus;
    longScore -= Math.max(2, Math.floor(repeatedTouchBonus / 2));
    shortReasons.push(`Resistance H4 sudah dites ${resistanceTouches}x — standby SHORT saat rejection lebih valid (+${touchBonus})`);
    tags.push('REPEATED RESISTANCE');
  } else if (pricePosition === 'near_support' && supportTouches >= repeatedLevelTouches) {
    const touchBonus = supportTouches >= 5 ? strongRepeatedTouchBonus : repeatedTouchBonus;
    longScore += touchBonus;
    shortScore -= Math.max(2, Math.floor(repeatedTouchBonus / 2));
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
  const standbyLevel = standbyBias === 'SHORT' ? supportLevel.value : standbyBias === 'LONG' ? resistanceLevel.value : null;

  // ─── CATEGORY 4: Breakout & Retest (Max: 15 pts) ───
  if (retestStatus === 'CONFIRMED') {
    const patternBreakoutMatch =
      h4Pattern.breakout &&
      ((breakoutBias === 'LONG' && h4Pattern.breakoutDirection === 'bullish') ||
       (breakoutBias === 'SHORT' && h4Pattern.breakoutDirection === 'bearish'));
    const retestBonus = patternBreakoutMatch ? 8 : 15;
    if (breakoutBias === 'LONG') {
      longScore += retestBonus;
      longReasons.push(`H1 breakout retest confirmed (+${retestBonus})`);
    } else {
      shortScore += retestBonus;
      shortReasons.push(`H1 breakdown retest confirmed (+${retestBonus})`);
    }
    if (patternBreakoutMatch) tags.push('PATTERN_RETEST_CONTINUATION');
  } else if (retestStatus === 'PENDING') {
    // Retest ada tapi belum ada close confirmation — root cause dari banyak SL hit prematur
    const appliedRetestPendingPenalty = strongH4LevelSetup
      ? Math.max(0, Math.floor(retestPendingPenalty / 2))
      : retestPendingPenalty;
    longScore -= appliedRetestPendingPenalty;
    shortScore -= appliedRetestPendingPenalty;
    warnings.push('⏳ Retest belum terkonfirmasi (PENDING). Tunggu candle close di sisi yang benar sebelum entry.');
    tags.push('RETEST_PENDING');
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

  // ─── CATEGORY 5: R:R & Risk (Max: 10 pts) ───
  const bias = longScore > shortScore ? 'LONG' : 'SHORT';
  const compressionBreakoutContext =
    h1Compression.breakout && h1Compression.direction === 'bullish' && Number.isFinite(h1Compression.high)
      ? { type: 'bullish_bos', level: h1Compression.high }
      : h1Compression.breakout && h1Compression.direction === 'bearish' && Number.isFinite(h1Compression.low)
        ? { type: 'bearish_bos', level: h1Compression.low }
        : null;
  const patternBreakoutContext =
    h4Pattern.breakout && h4Pattern.breakoutDirection === 'bullish' && Number.isFinite(h4Pattern.upper?.currentValue)
      ? { type: 'bullish_bos', level: h4Pattern.upper.currentValue }
      : h4Pattern.breakout && h4Pattern.breakoutDirection === 'bearish' && Number.isFinite(h4Pattern.lower?.currentValue)
        ? { type: 'bearish_bos', level: h4Pattern.lower.currentValue }
        : null;
  const structuralBreakoutContext =
    bias === 'LONG' && h1Structure.bosType === 'bullish_bos' && Number.isFinite(h1Structure.lastSwingHigh)
      ? { type: 'bullish_bos', level: h1Structure.lastSwingHigh }
      : bias === 'SHORT' && h1Structure.bosType === 'bearish_bos' && Number.isFinite(h1Structure.lastSwingLow)
        ? { type: 'bearish_bos', level: h1Structure.lastSwingLow }
        : null;
  const breakoutContext = patternBreakoutContext || compressionBreakoutContext || structuralBreakoutContext;
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
        longScore -= rrBelowMinPenalty;
        shortScore -= rrBelowMinPenalty;
    }
  }

  const minFinalScore = Number.isFinite(options.minFinalScore) ? options.minFinalScore : (config.strategy.minFinalScore || 25);
  const minRrRatio = Number.isFinite(options.minRrRatio) ? options.minRrRatio : 2.0;
  const standbyMinRr = Number.isFinite(options.standbyMinRr) ? options.standbyMinRr : (config.strategy.standbyMinRr || minRrRatio);

  // ─── FINAL SELECTION ──────────────────────────────────
  let finalScore = longScore > shortScore ? longScore : shortScore;
  let reasons = longScore > shortScore ? longReasons : shortReasons;
  
  if (finalScore < minFinalScore) {
    return options.includeRejectionReason ? {
      signal: null,
      rejectionReason: `Weighted score too low (${finalScore}/100). Need min ${minFinalScore}.`,
      diagnostics: buildRejectionDiagnostics({
        bias,
        longScore,
        shortScore,
        finalScore,
        reasons,
        warnings,
        tags,
        analysis: {
          d1Trend, h4SR, h4Pattern, h4Trend, h1Trend, m15Trend, h1Structure, h1Compression, ema1321, h4OB, h1OB, h1Engulfing, h1Pin, h1Stoch, h4Stoch,
        },
        riskReward,
        pricePosition,
        d1Trend,
        h4Trend,
        h1Trend,
        h1Structure,
        h1Stoch,
        h4Stoch,
      }),
    } : null;
  }

  if (!riskReward || riskReward.rr < minRrRatio) {
      const rrLabel = riskReward?.rr != null ? riskReward.rr.toFixed(1) : 'N/A';
      const rrReason = riskReward?.failureReason
        ? `Invalid R:R setup (${riskReward.failureReason})`
        : `Poor R:R Ratio (${rrLabel}). Need min ${minRrRatio.toFixed(1)}.`;
      return options.includeRejectionReason ? {
        signal: null,
        rejectionReason: rrReason,
        diagnostics: buildRejectionDiagnostics({
          bias,
          longScore,
          shortScore,
          finalScore,
          reasons,
          warnings,
          tags,
          analysis: {
            d1Trend, h4SR, h4Pattern, h4Trend, h1Trend, m15Trend, h1Structure, h1Compression, ema1321, h4OB, h1OB, h1Engulfing, h1Pin, h1Stoch, h4Stoch,
          },
          riskReward,
          pricePosition,
          d1Trend,
          h4Trend,
          h1Trend,
          h1Structure,
          h1Stoch,
          h4Stoch,
        }),
      } : null;
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
        d1Trend, h4SR, h4Pattern, h4Trend, h1Trend, m15Trend, h1Structure, h1Compression, ema1321, h4OB, h1OB, h1Engulfing, h1Pin, h1Stoch, h4Stoch
      },
      riskReward,
      isStrict: false,
      lowConfidence: true,
      fundingRate: (fundingRate * 100).toFixed(4) + '%',
      trading_type: 'MONITORING',
      standbyOnly: true,
      standbyReason,
      standbyContext: {
        bias: standbyBias,
        touches: standbyTouches,
        targetLevel: standbyLevel,
      },
    };
  }

  // ─── POST-BIAS DIRECTIONAL BARRIERS ──────────────────────
  // H4 SR stays the primary edge. D1 disagreement is allowed, but weak
  // structure and unconfirmed retests still get filtered out.
  if (bias === 'LONG' && pricePosition === 'near_resistance' && retestStatus !== 'CONFIRMED') {
    finalScore -= strongH4LevelSetup ? 8 : 15;
    tags.push('RESISTANCE_ENTRY_UNCONFIRMED');
    warnings.push('🚫 LONG dekat resistance tanpa retest konfirmasi — tunggu breakout hold atau pullback ke support sebelum entry.');
  }
  if (bias === 'SHORT' && pricePosition === 'near_support' && retestStatus !== 'CONFIRMED') {
    finalScore -= strongH4LevelSetup ? 8 : 15;
    tags.push('SUPPORT_ENTRY_UNCONFIRMED');
    warnings.push('🚫 SHORT dekat support tanpa retest konfirmasi — tunggu breakdown valid atau bounce ke resistance sebelum entry.');
  }

  if (pricePosition === 'middle' && !h1Structure.bos && retestStatus !== 'CONFIRMED') {
    finalScore -= strongH4LevelSetup ? 6 : 12;
    tags.push('MIDDLE_ZONE_NO_EDGE');
    warnings.push('🚫 Price di middle zone, tidak ada BoS, dan retest belum konfirmasi. Tidak ada edge struktural — skip setup ini.');
  }

  // ─── VERTICAL ENTRY ───────────────────────────────────────
  const distFromLvl = bias === 'LONG' ? distToSupport : distToResistance;
  if (distFromLvl > 5.0) {
    finalScore -= strongH4LevelSetup ? 5 : 10;
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
      d1Trend, h4SR, h4Pattern, h4Trend, h1Trend, m15Trend, h1Structure, h1Compression, ema1321, h4OB, h1OB, h1Engulfing, h1Pin, h1Stoch, h4Stoch
    },
    riskReward,
    isStrict,
    lowConfidence: !isStrict,
    fundingRate: (fundingRate * 100).toFixed(4) + '%',
    trading_type: tradingType,
  };
}

module.exports = { evaluateSignal, classifyPricePosition, calculateRiskReward };
