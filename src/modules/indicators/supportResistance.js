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
  const swingWidth = 3; 
  const wickHighs = [];
  const wickLows = [];
  const bodyHighs = [];
  const bodyLows = [];

  for (let i = swingWidth; i < candles.length - swingWidth; i++) {
    let isWickHigh = true;
    let isWickLow = true;
    let isBodyHigh = true;
    let isBodyLow = true;

    const currentBodyMax = Math.max(candles[i].open, candles[i].close);
    const currentBodyMin = Math.min(candles[i].open, candles[i].close);

    for (let j = 1; j <= swingWidth; j++) {
      const prevBodyMax = Math.max(candles[i-j].open, candles[i-j].close);
      const prevBodyMin = Math.min(candles[i-j].open, candles[i-j].close);
      const nextBodyMax = Math.max(candles[i+j].open, candles[i+j].close);
      const nextBodyMin = Math.min(candles[i+j].open, candles[i+j].close);

      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isWickHigh = false;
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) isWickLow = false;
      
      if (currentBodyMax <= prevBodyMax || currentBodyMax <= nextBodyMax) isBodyHigh = false;
      if (currentBodyMin >= prevBodyMin || currentBodyMin >= nextBodyMin) isBodyLow = false;
    }

    if (isWickHigh) wickHighs.push(candles[i].high);
    if (isWickLow) wickLows.push(candles[i].low);
    if (isBodyHigh) bodyHighs.push(currentBodyMax);
    if (isBodyLow) bodyLows.push(currentBodyMin);
  }

  const currentPrice = candles[candles.length - 1].close;

  const clusterLevels = (levels, mode) => {
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

    return clusters.map((c) => {
        if (mode === 'MIN') return Math.min(...c);
        if (mode === 'MAX') return Math.max(...c);
        return c.reduce((s, v) => s + v, 0) / c.length; // Default to mean
    });
  };

  const supportWick = clusterLevels(wickLows, 'MIN');
  const resistanceWick = clusterLevels(wickHighs, 'MAX');
  const supportBody = clusterLevels(bodyLows, 'MAX'); // Conservative Support for Short TP
  const resistanceBody = clusterLevels(bodyHighs, 'MIN'); // Conservative Resistance for Long TP

  const findNearest = (levels, type) => {
      if (type === 'SUPPORT') {
          return levels.filter(l => l < currentPrice).sort((a,b) => b - a)[0] || 0;
      }
      return levels.filter(l => l > currentPrice).sort((a,b) => a - b)[0] || Infinity;
  };

  return {
    currentPrice,
    wick: {
        support: findNearest(supportWick, 'SUPPORT'),
        resistance: findNearest(resistanceWick, 'RESISTANCE')
    },
    body: {
        support: findNearest(supportBody, 'SUPPORT'),
        resistance: findNearest(resistanceBody, 'RESISTANCE')
    }
  };
}

module.exports = { findSupportResistance };
