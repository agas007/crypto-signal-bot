/**
 * Volatility indicators like ATR and Spike Detection.
 */

/**
 * Calculate Average True Range (ATR).
 */
function calculateATR(candles, period = 14) {
  if (candles.length <= period) return null;

  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
  }

  // Calculate Average (SMA of TRs)
  const atrValues = [];
  for (let i = period; i <= trs.length; i++) {
    const slice = trs.slice(i - period, i);
    const avg = slice.reduce((a, b) => a + b, 0) / period;
    atrValues.push(avg);
  }

  return {
    current: atrValues[atrValues.length - 1],
    history: atrValues,
    lastTr: trs[trs.length - 1]
  };
}

/**
 * Check if the current candle is a "God-Candle" (Spike > 2x ATR).
 */
function detectAtSpike(candles, period = 14) {
  const atrData = calculateATR(candles, period);
  if (!atrData) return { spike: false, ratio: 1 };

  const ratio = atrData.lastTr / atrData.current;
  return {
    spike: ratio > 2.0,
    ratio: ratio,
    atr: atrData.current, // Added this
  };
}

/**
 * Detect a narrow consolidation followed by a breakout.
 *
 * @param {Array<{high:number, low:number, close:number, open:number}>} candles
 * @param {{
 *   recentWindow?: number,
 *   compareWindow?: number,
 *   maxRangePct?: number,
 *   minContraction?: number,
 *   breakoutBufferPct?: number,
 * }} [options]
 * @returns {{
 *   compressed: boolean,
 *   breakout: boolean,
 *   direction: 'bullish'|'bearish'|null,
 *   rangePct: number,
 *   recentAvgRangePct: number,
 *   previousAvgRangePct: number,
 *   contractionRatio: number,
 *   high: number|null,
 *   low: number|null,
 * }}
 */
function detectCompression(candles, options = {}) {
  const recentWindow = options.recentWindow || 12;
  const compareWindow = options.compareWindow || 12;
  const maxRangePct = options.maxRangePct || 0.04;
  const minContraction = options.minContraction || 0.8;
  const breakoutBufferPct = options.breakoutBufferPct || 0.0015;

  if (!Array.isArray(candles) || candles.length < recentWindow + compareWindow) {
    return {
      compressed: false,
      breakout: false,
      direction: null,
      rangePct: 0,
      recentAvgRangePct: 0,
      previousAvgRangePct: 0,
      contractionRatio: 1,
      high: null,
      low: null,
    };
  }

  const recent = candles.slice(-recentWindow);
  const previous = candles.slice(-(recentWindow + compareWindow), -recentWindow);
  const high = Math.max(...recent.map((c) => c.high));
  const low = Math.min(...recent.map((c) => c.low));
  const close = recent[recent.length - 1].close;
  const rangePct = close > 0 ? (high - low) / close : 0;

  const avgRangePct = (slice) => slice.reduce((sum, c) => sum + ((c.high - c.low) / c.close), 0) / slice.length;
  const recentAvgRangePct = avgRangePct(recent);
  const previousAvgRangePct = avgRangePct(previous);
  const contractionRatio = previousAvgRangePct > 0 ? recentAvgRangePct / previousAvgRangePct : 1;

  const compressed = rangePct <= maxRangePct && contractionRatio <= minContraction;

  const bullishBreakout = compressed && close > high * (1 + breakoutBufferPct);
  const bearishBreakout = compressed && close < low * (1 - breakoutBufferPct);

  return {
    compressed,
    breakout: bullishBreakout || bearishBreakout,
    direction: bullishBreakout ? 'bullish' : bearishBreakout ? 'bearish' : null,
    rangePct,
    recentAvgRangePct,
    previousAvgRangePct,
    contractionRatio,
    high,
    low,
  };
}

module.exports = { calculateATR, detectAtSpike, detectCompression };
