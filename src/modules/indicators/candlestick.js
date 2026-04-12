/**
 * Candlestick Pattern Detector
 * Detects key price action patterns for extra confluence.
 */

/**
 * Detect Engulfing Pattern
 * @param {Array} candles - Array of OHLCV candles [t, o, h, l, c, v]
 * @returns {{ bull: boolean, bear: boolean }}
 */
function detectEngulfing(candles) {
  if (candles.length < 2) return { bull: false, bear: false };
  
  const current = {
    o: parseFloat(candles[candles.length - 1][1]),
    c: parseFloat(candles[candles.length - 1][4])
  };
  const prev = {
    o: parseFloat(candles[candles.length - 2][1]),
    c: parseFloat(candles[candles.length - 2][4])
  };

  const isPrevBear = prev.c < prev.o;
  const isPrevBull = prev.c > prev.o;
  const isCurrBear = current.c < current.o;
  const isCurrBull = current.c > current.o;

  // Bullish Engulfing: Current Bull body "eats" Prev Bear body
  const bull = isPrevBear && isCurrBull && current.c > prev.o && current.o < prev.c;
  
  // Bearish Engulfing: Current Bear body "eats" Prev Bull body
  const bear = isPrevBull && isCurrBear && current.c < prev.o && current.o > prev.c;

  return { bull, bear };
}

/**
 * Detect Pin Bar (Hammer/Shooting Star)
 * @param {Array} candles 
 * @returns {{ bullPin: boolean, bearPin: boolean }}
 */
function detectPinBar(candles) {
  if (candles.length < 1) return { bullPin: false, bearPin: false };
  
  const c = candles[candles.length - 1]; // Current candle
  const o = parseFloat(c[1]);
  const h = parseFloat(c[2]);
  const l = parseFloat(c[3]);
  const cl = parseFloat(c[4]);

  const bodySize = Math.abs(cl - o);
  const totalRange = h - l;
  if (totalRange === 0) return { bullPin: false, bearPin: false };

  const upperWick = h - Math.max(o, cl);
  const lowerWick = Math.min(o, cl) - l;

  // Criteria: Wick is at least 2x the body, and 60% of total range
  const bullPin = lowerWick > (bodySize * 2) && lowerWick > (totalRange * 0.6);
  const bearPin = upperWick > (bodySize * 2) && upperWick > (totalRange * 0.6);

  return { bullPin, bearPin };
}

/**
 * Detect Doji (Indecision)
 */
function detectDoji(candles) {
  if (candles.length < 1) return false;
  const c = candles[candles.length - 1];
  const o = parseFloat(c[1]);
  const cl = parseFloat(c[4]);
  const h = parseFloat(c[2]);
  const l = parseFloat(c[3]);

  const bodySize = Math.abs(cl - o);
  const totalRange = h - l;
  
  // Body is less than 10% of total range
  return totalRange > 0 && bodySize < (totalRange * 0.1);
}

module.exports = { detectEngulfing, detectPinBar, detectDoji };
