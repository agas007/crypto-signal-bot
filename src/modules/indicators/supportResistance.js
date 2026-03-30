/**
 * Support & Resistance detection using swing highs/lows.
 *
 * A swing high is a candle whose high is greater than the N candles on both sides.
 * A swing low is a candle whose low is less than the N candles on both sides.
 */

/**
 * Find swing highs and lows.
 *
 * @param {Array<{high: number, low: number, close: number}>} candles
 * @param {number} [lookback=20] - Number of candles to consider for swing points
 * @returns {{
 *   support: number[],
 *   resistance: number[],
 *   nearestSupport: number,
 *   nearestResistance: number,
 *   currentPrice: number,
 *   distToSupport: number,
 *   distToResistance: number
 * }}
 */
function findSupportResistance(candles, lookback = 20) {
  const swingWidth = 3; // candles on each side to confirm a swing point
  const resistanceLevels = [];
  const supportLevels = [];

  // Scan for swing points (skip edges that can't have full window)
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

    if (isSwingHigh) resistanceLevels.push(candles[i].high);
    if (isSwingLow) supportLevels.push(candles[i].low);
  }

  const currentPrice = candles[candles.length - 1].close;

  // Cluster nearby levels (within 0.5% of each other)
  const clusterLevels = (levels) => {
    if (!levels.length) return [];
    const sorted = [...levels].sort((a, b) => a - b);
    const clusters = [[sorted[0]]];

    for (let i = 1; i < sorted.length; i++) {
      const lastCluster = clusters[clusters.length - 1];
      const clusterMean = lastCluster.reduce((s, v) => s + v, 0) / lastCluster.length;

      if (Math.abs(sorted[i] - clusterMean) / clusterMean < 0.005) {
        lastCluster.push(sorted[i]);
      } else {
        clusters.push([sorted[i]]);
      }
    }

    return clusters.map((c) => c.reduce((s, v) => s + v, 0) / c.length);
  };

  const clusteredSupport = clusterLevels(supportLevels);
  const clusteredResistance = clusterLevels(resistanceLevels);

  // Find nearest levels to current price
  const nearestSupport = clusteredSupport
    .filter((s) => s < currentPrice)
    .sort((a, b) => b - a)[0] || 0;

  const nearestResistance = clusteredResistance
    .filter((r) => r > currentPrice)
    .sort((a, b) => a - b)[0] || Infinity;

  const distToSupport = nearestSupport ? ((currentPrice - nearestSupport) / currentPrice) * 100 : Infinity;
  const distToResistance = nearestResistance !== Infinity
    ? ((nearestResistance - currentPrice) / currentPrice) * 100
    : Infinity;

  return {
    support: clusteredSupport,
    resistance: clusteredResistance,
    nearestSupport,
    nearestResistance,
    currentPrice,
    distToSupport,
    distToResistance,
  };
}

module.exports = { findSupportResistance };
