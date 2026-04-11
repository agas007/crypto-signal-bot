/**
 * Stochastic Oscillator (%K and %D).
 *
 * Formula:
 *   %K = 100 × (Close - Lowest Low) / (Highest High - Lowest Low)
 *   %D = SMA(%K, dPeriod)
 */

/**
 * Simple Moving Average helper.
 * @param {number[]} values
 * @param {number} period
 * @returns {number[]}
 */
function sma(values, period) {
  const result = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += values[j];
    }
    result.push(sum / period);
  }
  return result;
}

/**
 * Calculate Stochastic Oscillator.
 *
 * @param {Array<{high: number, low: number, close: number}>} candles
 * @param {{ kPeriod: number, dPeriod: number, smooth: number }} params
 * @returns {{
 *   k: number,
 *   d: number,
 *   signal: 'oversold'|'overbought'|'neutral',
 *   kSeries: number[],
 *   dSeries: number[]
 * }}
 */
function calculateStochastic(candles, params = { kPeriod: 14, dPeriod: 3, smooth: 3 }) {
  const { kPeriod, dPeriod, smooth } = params;
  const rawK = [];

  for (let i = 0; i < candles.length; i++) {
    if (i < kPeriod - 1) {
      rawK.push(NaN);
      continue;
    }

    const window = candles.slice(i - kPeriod + 1, i + 1);
    const highestHigh = Math.max(...window.map((c) => c.high));
    const lowestLow = Math.min(...window.map((c) => c.low));

    const range = highestHigh - lowestLow;
    if (range === 0) {
      rawK.push(50); // no range = neutral
    } else {
      rawK.push(((candles[i].close - lowestLow) / range) * 100);
    }
  }

  // Smooth %K with SMA
  const kSmoothed = smooth > 1 ? sma(rawK, smooth) : rawK;

  // %D = SMA of smoothed %K
  const dSeries = sma(kSmoothed, dPeriod);

  const k = kSmoothed[kSmoothed.length - 1];
  const d = dSeries[dSeries.length - 1];

  let signal = 'neutral';
  if (k < 20 && d < 20) signal = 'oversold';
  else if (k > 80 && d > 80) signal = 'overbought';

  return { k, d, signal, kSeries: kSmoothed, dSeries };
}

/**
 * Detect Stochastic %K / %D crossover.
 * Per mentor's slide: Stochastic Cross = BUY/LONG trigger.
 *
 * Rules:
 *  - Bullish cross: %K crosses ABOVE %D (preferably in oversold zone < 30)
 *  - Bearish cross: %K crosses BELOW %D (preferably in overbought zone > 70)
 *
 * @param {number[]} kSeries  - Smoothed %K values
 * @param {number[]} dSeries  - %D values
 * @param {{ oversold?: number, overbought?: number }} opts
 * @returns {{
 *   crossBullish: boolean,
 *   crossBearish: boolean,
 *   crossInZone: boolean,  - true if cross happened in oversold/overbought zone
 *   prevK: number,
 *   prevD: number,
 *   currK: number,
 *   currD: number,
 * }}
 */
function detectStochCross(kSeries, dSeries, opts = {}) {
  const { oversold = 30, overbought = 70 } = opts;

  // Need at least 2 valid data points
  const validKIdx = kSeries.reduce((acc, v, i) => (!isNaN(v) ? i : acc), -1);
  const validDIdx = dSeries.reduce((acc, v, i) => (!isNaN(v) ? i : acc), -1);

  if (validKIdx < 1 || validDIdx < 1) {
    return { crossBullish: false, crossBearish: false, crossInZone: false, prevK: NaN, prevD: NaN, currK: NaN, currD: NaN };
  }

  const currK = kSeries[validKIdx];
  const prevK = kSeries[validKIdx - 1];
  const currD = dSeries[validDIdx];
  const prevD = dSeries[validDIdx - 1];

  if (isNaN(prevK) || isNaN(prevD) || isNaN(currK) || isNaN(currD)) {
    return { crossBullish: false, crossBearish: false, crossInZone: false, prevK, prevD, currK, currD };
  }

  // Bullish: was K below D, now K above D
  const crossBullish = prevK < prevD && currK > currD;
  // Bearish: was K above D, now K below D
  const crossBearish = prevK > prevD && currK < currD;

  // Zone check: cross happened in meaningful zone
  const crossInZone = (crossBullish && currK < oversold) ||
                      (crossBearish && currK > overbought);

  return { crossBullish, crossBearish, crossInZone, prevK, prevD, currK, currD };
}

/**
 * Detect Bullish or Bearish Divergence between price and stochastic.
 * Per mentor's slide: Bullish Divergence = BUY trigger.
 *
 * Classic Bullish Divergence: Price makes LOWER LOW, Stoch makes HIGHER LOW
 * Classic Bearish Divergence: Price makes HIGHER HIGH, Stoch makes LOWER HIGH
 *
 * @param {Array<{high: number, low: number, close: number}>} candles
 * @param {number[]} kSeries  - Smoothed %K from calculateStochastic
 * @param {number} lookback   - How many candles to compare (default 10)
 * @returns {{
 *   bullishDiv: boolean,
 *   bearishDiv: boolean,
 *   hiddenBullishDiv: boolean,  - Price HL, Stoch LL (trend continuation)
 *   hiddenBearishDiv: boolean,  - Price LH, Stoch HH (trend continuation)
 *   detail: string
 * }}
 */
function detectDivergence(candles, kSeries, lookback = 14) {
  const result = {
    bullishDiv: false,
    bearishDiv: false,
    hiddenBullishDiv: false,
    hiddenBearishDiv: false,
    detail: ''
  };

  if (candles.length < lookback + 2 || kSeries.length < lookback + 2) return result;

  const recentCandles = candles.slice(-lookback);
  const recentK = kSeries.slice(-lookback);

  // Get start vs end comparisons
  const priceStart = recentCandles[0].close;
  const priceEnd = recentCandles[recentCandles.length - 1].close;
  const highStart = Math.max(...recentCandles.slice(0, Math.floor(lookback / 2)).map(c => c.high));
  const highEnd = Math.max(...recentCandles.slice(Math.floor(lookback / 2)).map(c => c.high));
  const lowStart = Math.min(...recentCandles.slice(0, Math.floor(lookback / 2)).map(c => c.low));
  const lowEnd = Math.min(...recentCandles.slice(Math.floor(lookback / 2)).map(c => c.low));

  const validK = recentK.filter(v => !isNaN(v));
  if (validK.length < 4) return result;

  const kStart = validK.slice(0, Math.floor(validK.length / 2)).reduce((a, b) => Math.min(a, b), Infinity);
  const kEnd = validK.slice(Math.floor(validK.length / 2)).reduce((a, b) => Math.min(a, b), Infinity);
  const kHighStart = validK.slice(0, Math.floor(validK.length / 2)).reduce((a, b) => Math.max(a, b), -Infinity);
  const kHighEnd = validK.slice(Math.floor(validK.length / 2)).reduce((a, b) => Math.max(a, b), -Infinity);

  // Classic Bullish: Price LL, Stoch HL (momentum declining less than price)
  if (lowEnd < lowStart && kEnd > kStart && kEnd < 40) {
    result.bullishDiv = true;
    result.detail = `Bullish Div: Price Low ${lowStart.toFixed(4)}→${lowEnd.toFixed(4)}, Stoch Low ${kStart.toFixed(1)}→${kEnd.toFixed(1)}`;
  }

  // Classic Bearish: Price HH, Stoch LH (momentum waning at top)
  if (highEnd > highStart && kHighEnd < kHighStart && kHighEnd > 60) {
    result.bearishDiv = true;
    result.detail = `Bearish Div: Price High ${highStart.toFixed(4)}→${highEnd.toFixed(4)}, Stoch High ${kHighStart.toFixed(1)}→${kHighEnd.toFixed(1)}`;
  }

  // Hidden Bullish: Price HL, Stoch LL (continuation of uptrend)
  if (lowEnd > lowStart && kEnd < kStart && kEnd < 35) {
    result.hiddenBullishDiv = true;
    result.detail += ` | Hidden Bull Div: Price HL, Stoch LL`;
  }

  // Hidden Bearish: Price LH, Stoch HH (continuation of downtrend)
  if (highEnd < highStart && kHighEnd > kHighStart && kHighEnd > 65) {
    result.hiddenBearishDiv = true;
    result.detail += ` | Hidden Bear Div: Price LH, Stoch HH`;
  }

  return result;
}

module.exports = { calculateStochastic, detectStochCross, detectDivergence, sma };
