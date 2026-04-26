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
 * @param {{
 *   confirmationCandles?: Array<{close: number, low: number, high: number, closeTime?: number}>,
 *   confirmationCount?: number,
 *   now?: number
 * }} [options]
 * @returns {{
 *   structure: 'bullish'|'bearish'|'no_structure',
 *   bos: boolean,
 *   bosType: 'bullish_bos'|'bearish_bos'|null,
 *   pendingBosType: 'bullish_bos'|'bearish_bos'|null,
 *   lastSwingHigh: number|null,
 *   lastSwingLow: number|null,
 *   currentPrice: number,
 *   detail: string
 * }}
 */
function analyzeStructure(candles, swingWidth = 3, options = {}) {
  const { swingHighs, swingLows } = findSwingPoints(candles, swingWidth);
  const currentPrice = candles[candles.length - 1].close;
  const now = options.now || Date.now();
  const confirmationCount = Math.max(1, options.confirmationCount || 2);
  const confirmationCandles = Array.isArray(options.confirmationCandles)
    ? options.confirmationCandles.filter((c) => !c.closeTime || c.closeTime <= now)
    : candles.filter((c) => !c.closeTime || c.closeTime <= now);

  let structure = 'no_structure';
  let bos = false;
  let bosType = null;
  let pendingBosType = null;
  let detail = 'Insufficient swing points for structure analysis';
  let lastSwingHigh = null;
  let lastSwingLow = null;

  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { structure, bos, bosType, pendingBosType, lastSwingHigh, lastSwingLow, currentPrice, detail };
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

  // BOS must be confirmed by closed candles and follow-through on M15.
  const bosMarginPct = 0.0025; // 0.25% confirmation buffer
  const holdMarginPct = 0.0010; // allow tiny noise around the level after break
  const findBosCandidate = (level, direction) => {
    if (!Number.isFinite(level) || !confirmationCandles.length) return null;

    const crossed = (candle) => direction === 'bullish'
      ? candle.close > level * (1 + bosMarginPct)
      : candle.close < level * (1 - bosMarginPct);
    const held = (candle) => direction === 'bullish'
      ? candle.close >= level * (1 - holdMarginPct) && candle.low >= level * (1 - holdMarginPct)
      : candle.close <= level * (1 + holdMarginPct) && candle.high <= level * (1 + holdMarginPct);

    for (let i = 0; i < confirmationCandles.length; i++) {
      if (!crossed(confirmationCandles[i])) continue;
      const followThrough = confirmationCandles.slice(i + 1, i + 1 + confirmationCount);
      if (followThrough.length < confirmationCount) {
        return { confirmed: false, pending: true, breakoutIndex: i };
      }
      if (followThrough.every(held)) {
        return { confirmed: true, pending: false, breakoutIndex: i };
      }
      return { confirmed: false, pending: false, breakoutIndex: i };
    }

    return null;
  };

  const bullishCandidate = lastSwingHigh !== null ? findBosCandidate(lastSwingHigh, 'bullish') : null;
  if (bullishCandidate?.confirmed) {
    bos = true;
    bosType = 'bullish_bos';
    detail += ` | BoS confirmed above swing high ${lastSwingHigh.toFixed(4)} after ${confirmationCount} closed M15 candles`;
  } else if (bullishCandidate?.pending) {
    pendingBosType = 'bullish_bos';
    detail += ` | Break above ${lastSwingHigh.toFixed(4)} exists but still waiting ${confirmationCount} closed M15 candles`;
  }

  if (!bos) {
    const bearishCandidate = lastSwingLow !== null ? findBosCandidate(lastSwingLow, 'bearish') : null;
    if (bearishCandidate?.confirmed) {
      bos = true;
      bosType = 'bearish_bos';
      detail += ` | BoS confirmed below swing low ${lastSwingLow.toFixed(4)} after ${confirmationCount} closed M15 candles`;
    } else if (bearishCandidate?.pending && !pendingBosType) {
      pendingBosType = 'bearish_bos';
      detail += ` | Break below ${lastSwingLow.toFixed(4)} exists but still waiting ${confirmationCount} closed M15 candles`;
    }
  }

  return {
    structure,
    bos,
    bosType,
    pendingBosType,
    lastSwingHigh,
    lastSwingLow,
    currentPrice,
    detail,
  };
}

module.exports = { analyzeStructure, findSwingPoints };
