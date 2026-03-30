/**
 * Market Structure Analysis — Break of Structure (BoS) Detection.
 *
 * Break of Structure (BoS):
 *   - Bullish BoS: Price breaks above the most recent swing high
 *   - Bearish BoS: Price breaks below the most recent swing low
 *
 * Market Structure:
 *   - Bullish: Higher highs + higher lows
 *   - Bearish: Lower highs + lower lows
 *   - No structure: Mixed / ranging
 */

const { findSupportResistance } = require('./supportResistance');

/**
 * Find swing highs and lows from candle data.
 *
 * @param {Array<{high: number, low: number, close: number, open: number}>} candles
 * @param {number} [swingWidth=3] - Candles on each side to confirm swing
 * @returns {{ swingHighs: Array<{index: number, price: number}>, swingLows: Array<{index: number, price: number}> }}
 */
function findSwingPoints(candles, swingWidth = 3) {
  const swingHighs = [];
  const swingLows = [];

  for (let i = swingWidth; i < candles.length - swingWidth; i++) {
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = 1; j <= swingWidth; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) {
        isSwingHigh = false;
      }
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) {
        isSwingLow = false;
      }
    }

    if (isSwingHigh) swingHighs.push({ index: i, price: candles[i].high });
    if (isSwingLow) swingLows.push({ index: i, price: candles[i].low });
  }

  return { swingHighs, swingLows };
}

/**
 * Analyze market structure and detect Break of Structure.
 *
 * @param {Array<{high: number, low: number, close: number, open: number}>} candles
 * @param {number} [swingWidth=3]
 * @returns {{
 *   structure: 'bullish'|'bearish'|'no_structure',
 *   bos: boolean,
 *   bosType: 'bullish_bos'|'bearish_bos'|null,
 *   lastSwingHigh: number|null,
 *   lastSwingLow: number|null,
 *   currentPrice: number,
 *   detail: string
 * }}
 */
function analyzeStructure(candles, swingWidth = 3) {
  const { swingHighs, swingLows } = findSwingPoints(candles, swingWidth);
  const currentPrice = candles[candles.length - 1].close;
  const recentHigh = candles[candles.length - 1].high;
  const recentLow = candles[candles.length - 1].low;

  let structure = 'no_structure';
  let bos = false;
  let bosType = null;
  let detail = 'Insufficient swing points for structure analysis';
  let lastSwingHigh = null;
  let lastSwingLow = null;

  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { structure, bos, bosType, lastSwingHigh, lastSwingLow, currentPrice, detail };
  }

  // Get the last 3 swing points (or fewer if not available)
  const recentSwingHighs = swingHighs.slice(-3);
  const recentSwingLows = swingLows.slice(-3);

  lastSwingHigh = recentSwingHighs[recentSwingHighs.length - 1].price;
  lastSwingLow = recentSwingLows[recentSwingLows.length - 1].price;

  // Determine structure: HH+HL = bullish, LH+LL = bearish
  if (recentSwingHighs.length >= 2 && recentSwingLows.length >= 2) {
    const h1 = recentSwingHighs[recentSwingHighs.length - 2].price;
    const h2 = recentSwingHighs[recentSwingHighs.length - 1].price;
    const l1 = recentSwingLows[recentSwingLows.length - 2].price;
    const l2 = recentSwingLows[recentSwingLows.length - 1].price;

    const higherHigh = h2 > h1;
    const higherLow = l2 > l1;
    const lowerHigh = h2 < h1;
    const lowerLow = l2 < l1;

    if (higherHigh && higherLow) {
      structure = 'bullish';
      detail = `HH: ${h1.toFixed(4)} → ${h2.toFixed(4)}, HL: ${l1.toFixed(4)} → ${l2.toFixed(4)}`;
    } else if (lowerHigh && lowerLow) {
      structure = 'bearish';
      detail = `LH: ${h1.toFixed(4)} → ${h2.toFixed(4)}, LL: ${l1.toFixed(4)} → ${l2.toFixed(4)}`;
    } else {
      structure = 'no_structure';
      detail = `Mixed: H(${h1.toFixed(4)}→${h2.toFixed(4)}), L(${l1.toFixed(4)}→${l2.toFixed(4)})`;
    }
  }

  // Detect Break of Structure:
  // Check if recent candles (last 3) broke above the last swing high or below the last swing low
  const lookbackForBos = candles.slice(-3);

  // Bullish BoS: any recent candle closed above the last swing high
  if (lastSwingHigh !== null) {
    const brokeAbove = lookbackForBos.some((c) => c.close > lastSwingHigh);
    if (brokeAbove) {
      bos = true;
      bosType = 'bullish_bos';
      detail += ` | BoS: price broke above swing high ${lastSwingHigh.toFixed(4)}`;
    }
  }

  // Bearish BoS: any recent candle closed below the last swing low
  if (!bos && lastSwingLow !== null) {
    const brokeBelow = lookbackForBos.some((c) => c.close < lastSwingLow);
    if (brokeBelow) {
      bos = true;
      bosType = 'bearish_bos';
      detail += ` | BoS: price broke below swing low ${lastSwingLow.toFixed(4)}`;
    }
  }

  return {
    structure,
    bos,
    bosType,
    lastSwingHigh,
    lastSwingLow,
    currentPrice,
    detail,
  };
}

module.exports = { analyzeStructure, findSwingPoints };
