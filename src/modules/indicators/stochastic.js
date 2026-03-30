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

module.exports = { calculateStochastic, sma };
