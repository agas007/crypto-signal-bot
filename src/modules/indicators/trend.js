/**
 * Trend analysis using EMA crossover and higher-high / lower-low structure.
 */

/**
 * Calculate Exponential Moving Average.
 *
 * @param {number[]} values - Array of close prices
 * @param {number} period  - EMA period
 * @returns {number[]}     - EMA values (same length, NaN-padded at start)
 */
function ema(values, period) {
  const k = 2 / (period + 1);
  const result = new Array(values.length).fill(NaN);

  // Seed with SMA
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i];
  }
  result[period - 1] = sum / period;

  for (let i = period; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }

  return result;
}

/**
 * Classify trend strength into weak / moderate / strong.
 *
 * Based on EMA spread (fast-slow distance as % of price):
 *   - strong:   spread > 1.5%  (clear momentum)
 *   - moderate: spread 0.5% - 1.5% (trending but not explosive)
 *   - weak:     spread < 0.5%  (barely trending, almost sideways)
 *
 * @param {number} rawStrength - Normalized strength 0..1
 * @param {number} spreadPercent - Raw EMA spread as % of price
 * @returns {'weak'|'moderate'|'strong'}
 */
function classifyStrength(rawStrength, spreadPercent) {
  const absSpread = Math.abs(spreadPercent);
  if (absSpread >= 1.5 && rawStrength >= 0.5) return 'strong';
  if (absSpread >= 0.5 && rawStrength >= 0.2) return 'moderate';
  return 'weak';
}

/**
 * Determine trend direction using EMA crossover + price structure.
 *
 * @param {Array<{high: number, low: number, close: number}>} candles
 * @param {{ fast: number, slow: number }} params - EMA periods
 * @returns {{
 *   direction: 'bullish'|'bearish'|'neutral',
 *   emaFast: number,
 *   emaSlow: number,
 *   strength: number,
 *   strengthLabel: 'weak'|'moderate'|'strong',
 *   spreadPercent: number,
 *   hhCount: number,
 *   llCount: number
 * }}
 */
function analyzeTrend(candles, params = { fast: 9, slow: 21 }) {
  const closes = candles.map((c) => c.close);
  const fastEma = ema(closes, params.fast);
  const slowEma = ema(closes, params.slow);

  const lastFast = fastEma[fastEma.length - 1];
  const lastSlow = slowEma[slowEma.length - 1];

  if (isNaN(lastFast) || isNaN(lastSlow)) {
    return {
      direction: 'neutral',
      emaFast: lastFast,
      emaSlow: lastSlow,
      strength: 0,
      strengthLabel: 'weak',
      spreadPercent: 0,
      hhCount: 0,
      llCount: 0,
    };
  }

  // Strength: how far fast EMA is from slow, as percentage
  const spreadPercent = ((lastFast - lastSlow) / lastSlow) * 100;
  const strength = Math.min(Math.abs(spreadPercent) / 3, 1); // normalize 0..1

  // Higher-high / lower-low confirmation (last 10 candles)
  const recentHighs = candles.slice(-10).map((c) => c.high);
  const recentLows = candles.slice(-10).map((c) => c.low);
  const hhCount = recentHighs.filter((h, i) => i > 0 && h > recentHighs[i - 1]).length;
  const llCount = recentLows.filter((l, i) => i > 0 && l < recentLows[i - 1]).length;

  let direction = 'neutral';

  if (lastFast > lastSlow && spreadPercent > 0) {
    direction = 'bullish';
  } else if (lastFast < lastSlow && spreadPercent < 0) {
    direction = 'bearish';
  }

  const strengthLabel = classifyStrength(strength, spreadPercent);

  return {
    direction,
    emaFast: lastFast,
    emaSlow: lastSlow,
    strength,
    strengthLabel,
    spreadPercent,
    hhCount,
    llCount,
  };
}

/**
 * Detect EMA 13 & 21 signals as per mentor's strategy.
 *
 * Signals:
 *  1. Price ABOVE both EMA13 & EMA21           → bullish bias
 *  2. EMA13 crosses ABOVE EMA21 (Golden Cross)  → bullish entry trigger
 *  3. Price BELOW both EMA13 & EMA21           → bearish bias
 *  4. EMA13 crosses BELOW EMA21 (Death Cross)   → bearish entry trigger
 *
 * @param {Array<{close: number}>} candles
 * @returns {{
 *   ema13: number,
 *   ema21: number,
 *   priceAboveBoth: boolean,
 *   priceBelowBoth: boolean,
 *   priceBetween: boolean,
 *   goldenCross: boolean,   EMA13 just crossed above EMA21
 *   deathCross: boolean,    EMA13 just crossed below EMA21
 *   ema13AboveEma21: boolean,  ongoing bullish ema alignment
 *   bias: 'bullish'|'bearish'|'neutral'
 * }}
 */
function detectEma1321(candles) {
  const closes = candles.map(c => c.close);

  if (closes.length < 21) {
    return {
      ema13: NaN, ema21: NaN,
      priceAboveBoth: false, priceBelowBoth: false, priceBetween: false,
      goldenCross: false, deathCross: false, ema13AboveEma21: false,
      bias: 'neutral',
    };
  }

  const ema13Series = ema(closes, 13);
  const ema21Series = ema(closes, 21);

  const lastIdx = closes.length - 1;
  const currEma13 = ema13Series[lastIdx];
  const currEma21 = ema21Series[lastIdx];
  const prevEma13 = ema13Series[lastIdx - 1];
  const prevEma21 = ema21Series[lastIdx - 1];
  const currentPrice = closes[lastIdx];

  const priceAboveBoth = currentPrice > currEma13 && currentPrice > currEma21;
  const priceBelowBoth = currentPrice < currEma13 && currentPrice < currEma21;
  const priceBetween = !priceAboveBoth && !priceBelowBoth;
  const ema13AboveEma21 = currEma13 > currEma21;

  // Cross detection: previous bar had opposite relationship
  const goldenCross = prevEma13 <= prevEma21 && currEma13 > currEma21; // 13 crossed above 21
  const deathCross = prevEma13 >= prevEma21 && currEma13 < currEma21;  // 13 crossed below 21

  let bias = 'neutral';
  if (priceAboveBoth && ema13AboveEma21) bias = 'bullish';
  else if (priceBelowBoth && !ema13AboveEma21) bias = 'bearish';

  return {
    ema13: currEma13,
    ema21: currEma21,
    priceAboveBoth,
    priceBelowBoth,
    priceBetween,
    goldenCross,
    deathCross,
    ema13AboveEma21,
    bias,
  };
}

module.exports = { ema, analyzeTrend, classifyStrength, detectEma1321 };
