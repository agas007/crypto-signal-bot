/**
 * Order Block Detection
 *
 * Mentor's rule: If price is APPROACHING an Order Block, that's a buy/sell consideration.
 *
 * What is an Order Block (OB)?
 *   - The LAST bearish candle before a strong bullish impulse (Bullish OB)
 *   - The LAST bullish candle before a strong bearish impulse (Bearish OB)
 *   - Institutionals leave unmitigated OBs — price often retraces to fill them
 *
 * Detection Logic:
 *  1. Find strong impulse moves (candle body > ATR × impulseMultiplier)
 *  2. The candle BEFORE that impulse = Order Block
 *  3. OB zones = [candle.low .. candle.high] (or body: [open..close])
 *  4. "Approaching" = current price within proximityPct % of OB zone
 *  5. "Mitigated" = price already traded through the OB (it's "filled", skip)
 */

/**
 * Detect Order Blocks and check if current price is approaching one.
 *
 * @param {Array<{open: number, high: number, low: number, close: number}>} candles
 * @param {object} opts
 * @param {number}  [opts.impulseMultiplier=2.0]  - How many × ATR makes an impulse
 * @param {number}  [opts.proximityPct=0.03]       - 3% threshold for "approaching"
 * @param {number}  [opts.lookback=50]             - How far back to scan for OBs
 * @param {number}  [opts.maxObs=3]                - Max OBs to track per side
 * @returns {{
 *   bullishOBs: Array<OB>,
 *   bearishOBs: Array<OB>,
 *   approachingBullishOB: OB|null,
 *   approachingBearishOB: OB|null,
 *   inBullishOB: boolean,
 *   inBearishOB: boolean,
 *   currentPrice: number,
 * }}
 *
 * @typedef {{ top: number, bottom: number, mid: number, index: number, strength: number, mitigated: boolean }} OB
 */
function detectOrderBlocks(candles, opts = {}) {
  const {
    impulseMultiplier = 2.0,
    proximityPct = 0.03,
    lookback = 50,
    maxObs = 3,
  } = opts;

  const currentPrice = candles[candles.length - 1].close;

  // ── Calculate ATR for impulse threshold ─────────────────────────────────
  const atrWindow = Math.min(14, candles.length - 1);
  let atrSum = 0;
  for (let i = candles.length - atrWindow; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
    atrSum += tr;
  }
  const atr = atrSum / atrWindow;
  const impulseThreshold = atr * impulseMultiplier;

  const bullishOBs = [];
  const bearishOBs = [];

  const scanStart = Math.max(1, candles.length - lookback);

  for (let i = scanStart; i < candles.length - 1; i++) {
    const curr = candles[i];
    const next = candles[i + 1];
    const nextBody = Math.abs(next.close - next.open);
    const currBody = Math.abs(curr.close - curr.open);

    // ── Bullish OB: last bearish candle before bullish impulse ──────────
    // - Current candle is bearish (close < open)
    // - Next candle is a strong bullish impulse (body > threshold AND close > prev high)
    if (
      curr.close < curr.open &&   // bearish candle
      next.close > next.open &&   // next is bullish
      nextBody > impulseThreshold // it's a strong impulse
    ) {
      // OB zone = the body of the bearish candle (wick included for buffer)
      const ob = {
        type: 'bullish',
        top: curr.open,       // body top of bearish candle
        bottom: curr.close,   // body bottom of bearish candle
        wickTop: curr.high,
        wickBottom: curr.low,
        mid: (curr.open + curr.close) / 2,
        index: i,
        strength: nextBody / atr,  // how strong was the impulse?
        mitigated: false,
      };

      // Check if already mitigated (price traded through the OB body)
      const candlesAfter = candles.slice(i + 1);
      ob.mitigated = candlesAfter.some(c => c.low <= ob.bottom);

      if (!ob.mitigated) {
        bullishOBs.push(ob);
      }
    }

    // ── Bearish OB: last bullish candle before bearish impulse ──────────
    // - Current candle is bullish
    // - Next candle is a strong bearish impulse
    if (
      curr.close > curr.open &&   // bullish candle
      next.close < next.open &&   // next is bearish
      nextBody > impulseThreshold // strong impulse
    ) {
      const ob = {
        type: 'bearish',
        top: curr.close,      // body top of bullish candle
        bottom: curr.open,    // body bottom of bullish candle
        wickTop: curr.high,
        wickBottom: curr.low,
        mid: (curr.open + curr.close) / 2,
        index: i,
        strength: nextBody / atr,
        mitigated: false,
      };

      const candlesAfter = candles.slice(i + 1);
      ob.mitigated = candlesAfter.some(c => c.high >= ob.top);

      if (!ob.mitigated) {
        bearishOBs.push(ob);
      }
    }
  }

  // Sort by recency (most recent first) and cap at maxObs
  bullishOBs.sort((a, b) => b.index - a.index);
  bearishOBs.sort((a, b) => b.index - a.index);

  const topBullishOBs = bullishOBs.slice(0, maxObs);
  const topBearishOBs = bearishOBs.slice(0, maxObs);

  // ── Proximity Check ──────────────────────────────────────────────────────
  // "Approaching" Bullish OB = price is above the OB zone but within proximityPct above it
  // "In" Bullish OB = price is inside the OB zone range
  let approachingBullishOB = null;
  let inBullishOB = false;

  for (const ob of topBullishOBs) {
    // In OB: price between wickBottom and top (buffered)
    if (currentPrice >= ob.wickBottom && currentPrice <= ob.top * 1.005) {
      inBullishOB = true;
      approachingBullishOB = ob;
      break;
    }
    // Approaching: price is above OB but within proximityPct
    const distFromTop = (currentPrice - ob.top) / currentPrice;
    if (distFromTop >= 0 && distFromTop < proximityPct) {
      approachingBullishOB = ob;
      break;
    }
  }

  // "Approaching" Bearish OB = price is below OB zone but within proximityPct below it
  let approachingBearishOB = null;
  let inBearishOB = false;

  for (const ob of topBearishOBs) {
    // In OB: price between bottom and wickTop
    if (currentPrice >= ob.bottom * 0.995 && currentPrice <= ob.wickTop) {
      inBearishOB = true;
      approachingBearishOB = ob;
      break;
    }
    // Approaching from below
    const distFromBottom = (ob.bottom - currentPrice) / currentPrice;
    if (distFromBottom >= 0 && distFromBottom < proximityPct) {
      approachingBearishOB = ob;
      break;
    }
  }

  return {
    bullishOBs: topBullishOBs,
    bearishOBs: topBearishOBs,
    approachingBullishOB,
    approachingBearishOB,
    inBullishOB,
    inBearishOB,
    currentPrice,
    atr,
  };
}

module.exports = { detectOrderBlocks };
