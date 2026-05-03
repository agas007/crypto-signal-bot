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
function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (const p of points) {
    sumX += p.index;
    sumY += p.price;
    sumXY += p.index * p.price;
    sumXX += p.index * p.index;
  }

  const denom = (n * sumXX) - (sumX * sumX);
  if (denom === 0) return null;

  const slope = ((n * sumXY) - (sumX * sumY)) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

function buildTrendline(points, currentIndex, side) {
  if (!Array.isArray(points) || points.length < 2) return null;

  const recent = points.slice(-Math.min(points.length, 5));
  const fit = linearRegression(recent);
  if (!fit) return null;

  const { slope, intercept } = fit;
  const currentValue = slope * currentIndex + intercept;
  const firstValue = slope * recent[0].index + intercept;
  const lastValue = slope * recent[recent.length - 1].index + intercept;

  let fitErrorPct = 0;
  for (const p of recent) {
    const projected = slope * p.index + intercept;
    fitErrorPct += Math.abs(p.price - projected) / p.price;
  }
  fitErrorPct /= recent.length;

  const direction = slope > 0 ? 'up' : slope < 0 ? 'down' : 'flat';
  const strength = recent.length >= 4 ? 'major' : recent.length >= 3 ? 'confirmed' : 'fresh';

  return {
    side,
    slope,
    intercept,
    direction,
    strength,
    touches: recent.length,
    currentValue,
    firstValue,
    lastValue,
    fitErrorPct,
    active: true,
    points: recent,
  };
}

function detectChartPattern(highPoints, lowPoints, currentIndex, currentPrice, options = {}) {
  const recentCount = options.recentCount || 5;
  const breakoutBufferPct = options.breakoutBufferPct || 0.0015;
  const minContraction = options.minContraction || 0.9;
  const flatSlopePct = options.flatSlopePct || 0.0015;

  const highs = Array.isArray(highPoints) ? highPoints.slice(-recentCount) : [];
  const lows = Array.isArray(lowPoints) ? lowPoints.slice(-recentCount) : [];

  if (highs.length < 2 || lows.length < 2) {
    return {
      detected: false,
      name: 'none',
      direction: 'neutral',
      breakout: false,
      breakoutDirection: null,
      currentUpper: null,
      currentLower: null,
      gapPct: 0,
      contractionRatio: 1,
      upper: null,
      lower: null,
      reason: 'Insufficient swing points',
      strength: 'none',
    };
  }

  const upperFit = linearRegression(highs);
  const lowerFit = linearRegression(lows);
  if (!upperFit || !lowerFit) {
    return {
      detected: false,
      name: 'none',
      direction: 'neutral',
      breakout: false,
      breakoutDirection: null,
      currentUpper: null,
      currentLower: null,
      gapPct: 0,
      contractionRatio: 1,
      upper: null,
      lower: null,
      reason: 'Unable to fit trendlines',
      strength: 'none',
    };
  }

  const upperNow = (upperFit.slope * currentIndex) + upperFit.intercept;
  const lowerNow = (lowerFit.slope * currentIndex) + lowerFit.intercept;
  const firstIndex = Math.min(highs[0].index, lows[0].index);
  const upperThen = (upperFit.slope * firstIndex) + upperFit.intercept;
  const lowerThen = (lowerFit.slope * firstIndex) + lowerFit.intercept;
  const widthNow = upperNow - lowerNow;
  const widthThen = upperThen - lowerThen;
  const contractionRatio = widthThen > 0 ? widthNow / widthThen : 1;
  const gapPct = currentPrice > 0 ? widthNow / currentPrice : 0;

  if (!Number.isFinite(upperNow) || !Number.isFinite(lowerNow) || widthNow <= 0) {
    return {
      detected: false,
      name: 'none',
      direction: 'neutral',
      breakout: false,
      breakoutDirection: null,
      currentUpper: upperNow,
      currentLower: lowerNow,
      gapPct,
      contractionRatio,
      upper: null,
      lower: null,
      reason: 'Invalid channel geometry',
      strength: 'none',
    };
  }

  const upperSlopePct = currentPrice > 0 ? upperFit.slope / currentPrice : 0;
  const lowerSlopePct = currentPrice > 0 ? lowerFit.slope / currentPrice : 0;
  const upperFlat = Math.abs(upperSlopePct) <= flatSlopePct;
  const lowerFlat = Math.abs(lowerSlopePct) <= flatSlopePct;
  const compressed = contractionRatio <= minContraction;
  const breakoutUp = currentPrice > upperNow * (1 + breakoutBufferPct);
  const breakoutDown = currentPrice < lowerNow * (1 - breakoutBufferPct);

  let name = 'range';
  let direction = 'neutral';

  if (upperFit.slope < 0 && lowerFit.slope > 0 && compressed) {
    name = 'symmetric_triangle';
    direction = 'bullish';
  } else if (upperFlat && lowerFit.slope > 0 && compressed) {
    name = 'ascending_triangle';
    direction = 'bullish';
  } else if (lowerFlat && upperFit.slope < 0 && compressed) {
    name = 'descending_triangle';
    direction = 'bearish';
  } else if (upperFit.slope > 0 && lowerFit.slope > 0 && upperFit.slope > lowerFit.slope && compressed) {
    name = 'rising_wedge';
    direction = 'bearish';
  } else if (upperFit.slope < 0 && lowerFit.slope < 0 && upperFit.slope < lowerFit.slope && compressed) {
    name = 'falling_wedge';
    direction = 'bullish';
  } else if (upperFit.slope > 0 && lowerFit.slope > 0) {
    name = 'ascending_channel';
    direction = 'bullish';
  } else if (upperFit.slope < 0 && lowerFit.slope < 0) {
    name = 'descending_channel';
    direction = 'bearish';
  } else if (compressed) {
    name = 'consolidation';
    direction = 'neutral';
  }

  const breakoutDirection = breakoutUp ? 'bullish' : breakoutDown ? 'bearish' : null;
  const detected = name !== 'range' || breakoutUp || breakoutDown;
  const strength = highs.length >= 4 && lows.length >= 4 ? 'major' : highs.length >= 3 && lows.length >= 3 ? 'confirmed' : 'fresh';

  let reason = `${name} detected`;
  if (breakoutUp) reason = `${name} with bullish breakout above upper trendline`;
  if (breakoutDown) reason = `${name} with bearish breakout below lower trendline`;

  return {
    detected,
    name,
    direction: breakoutDirection || direction,
    breakout: Boolean(breakoutDirection),
    breakoutDirection,
    currentUpper: upperNow,
    currentLower: lowerNow,
    gapPct,
    contractionRatio,
    upper: {
      slope: upperFit.slope,
      intercept: upperFit.intercept,
      direction: upperFit.slope > 0 ? 'up' : upperFit.slope < 0 ? 'down' : 'flat',
      strength: highs.length >= 4 ? 'major' : highs.length >= 3 ? 'confirmed' : 'fresh',
      touches: highs.length,
      currentValue: upperNow,
      fitErrorPct: (() => {
        let total = 0;
        for (const p of highs) {
          const projected = (upperFit.slope * p.index) + upperFit.intercept;
          total += Math.abs(p.price - projected) / p.price;
        }
        return total / highs.length;
      })(),
      points: highs,
    },
    lower: {
      slope: lowerFit.slope,
      intercept: lowerFit.intercept,
      direction: lowerFit.slope > 0 ? 'up' : lowerFit.slope < 0 ? 'down' : 'flat',
      strength: lows.length >= 4 ? 'major' : lows.length >= 3 ? 'confirmed' : 'fresh',
      touches: lows.length,
      currentValue: lowerNow,
      fitErrorPct: (() => {
        let total = 0;
        for (const p of lows) {
          const projected = (lowerFit.slope * p.index) + lowerFit.intercept;
          total += Math.abs(p.price - projected) / p.price;
        }
        return total / lows.length;
      })(),
      points: lows,
    },
    reason,
    strength,
  };
}

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

    if (isWickHigh) wickHighs.push({ index: i, price: candles[i].high });
    if (isWickLow) wickLows.push({ index: i, price: candles[i].low });
    if (isBodyHigh) bodyHighs.push({ index: i, price: currentBodyMax });
    if (isBodyLow) bodyLows.push({ index: i, price: currentBodyMin });
  }

  const currentPrice = candles[candles.length - 1].close;

  const clusterLevels = (levels, mode) => {
    if (!levels.length) return [];
    const sorted = [...levels].sort((a, b) => a.price - b.price);
    const clusters = [[sorted[0]]];

    for (let i = 1; i < sorted.length; i++) {
      const lastCluster = clusters[clusters.length - 1];
      const clusterMean = lastCluster.reduce((s, v) => s + v.price, 0) / lastCluster.length;
      if (Math.abs(sorted[i].price - clusterMean) / clusterMean < 0.005) {
        lastCluster.push(sorted[i]);
      } else {
        clusters.push([sorted[i]]);
      }
    }

    return clusters.map((c) => {
        let price;
        if (mode === 'MIN') price = Math.min(...c.map((v) => v.price));
        else if (mode === 'MAX') price = Math.max(...c.map((v) => v.price));
        else price = c.reduce((s, v) => s + v.price, 0) / c.length;

        return {
          price,
          touches: c.length,
          strength: c.length >= 4 ? 'major' : c.length >= 2 ? 'confirmed' : 'fresh',
          points: c,
        };
    });
  };

  const supportWick = clusterLevels(wickLows, 'MIN');
  const resistanceWick = clusterLevels(wickHighs, 'MAX');
  const supportBody = clusterLevels(bodyLows, 'MAX'); // Conservative Support for Short TP
  const resistanceBody = clusterLevels(bodyHighs, 'MIN'); // Conservative Resistance for Long TP

  const findNearest = (levels, type) => {
      if (type === 'SUPPORT') {
          return levels.filter(l => l.price < currentPrice).sort((a,b) => b.price - a.price)[0] || null;
      }
      return levels.filter(l => l.price > currentPrice).sort((a,b) => a.price - b.price)[0] || null;
  };

  const nearestWickSupport = findNearest(supportWick, 'SUPPORT');
  const nearestWickResistance = findNearest(resistanceWick, 'RESISTANCE');
  const nearestBodySupport = findNearest(supportBody, 'SUPPORT');
  const nearestBodyResistance = findNearest(resistanceBody, 'RESISTANCE');
  const trendSupport = buildTrendline(wickLows, candles.length - 1, 'support');
  const trendResistance = buildTrendline(wickHighs, candles.length - 1, 'resistance');
  const pattern = detectChartPattern(wickHighs, wickLows, candles.length - 1, currentPrice);

  return {
    currentPrice,
    wick: {
        support: nearestWickSupport ? nearestWickSupport.price : 0,
        supportTouches: nearestWickSupport ? nearestWickSupport.touches : 0,
        supportStrength: nearestWickSupport ? nearestWickSupport.strength : 'none',
        resistance: nearestWickResistance ? nearestWickResistance.price : Infinity,
        resistanceTouches: nearestWickResistance ? nearestWickResistance.touches : 0,
        resistanceStrength: nearestWickResistance ? nearestWickResistance.strength : 'none',
    },
    body: {
        support: nearestBodySupport ? nearestBodySupport.price : 0,
        supportTouches: nearestBodySupport ? nearestBodySupport.touches : 0,
        supportStrength: nearestBodySupport ? nearestBodySupport.strength : 'none',
        resistance: nearestBodyResistance ? nearestBodyResistance.price : Infinity,
        resistanceTouches: nearestBodyResistance ? nearestBodyResistance.touches : 0,
        resistanceStrength: nearestBodyResistance ? nearestBodyResistance.strength : 'none',
    },
    trend: {
      support: trendSupport,
      resistance: trendResistance,
    },
    pattern,
    levels: {
      wickSupports: supportWick,
      wickResistances: resistanceWick,
      bodySupports: supportBody,
      bodyResistances: resistanceBody,
    },
  };
}

module.exports = { findSupportResistance };
