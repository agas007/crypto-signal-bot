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

module.exports = { calculateATR, detectAtSpike };
