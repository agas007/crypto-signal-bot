const config = require('../../config');
const logger = require('../../utils/logger');

/**
 * Calculate Average True Range (ATR) as percentage of price.
 *
 * @param {Array<{high: number, low: number, close: number}>} candles
 * @param {number} [period=14]
 * @returns {number} ATR as percentage of latest close
 */
function atrPercent(candles, period = 14) {
  if (candles.length < period + 1) return 0;

  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    atrSum += tr;
  }

  const atr = atrSum / period;
  const lastClose = candles[candles.length - 1].close;
  return (atr / lastClose) * 100;
}

/**
 * Apply pre-filters to determine if a symbol is worth analyzing.
 *
 * Checks:
 *   1. 24h quote volume above minimum
 *   2. Sufficient volatility (ATR %)
 *   3. Clear trend (EMA strength)
 *
 * @param {{
 *   symbol: string,
 *   ticker: { quoteVolume: number },
 *   trend: { direction: string, strength: number },
 *   candles: Array<{high: number, low: number, close: number}>
 * }} input
 * @returns {{ pass: boolean, reasons: string[] }}
 */
function applyFilters(input) {
  const { symbol, ticker, trend, candles } = input;
  const reasons = [];
  let pass = true;

  // 1. Volume check
  if (ticker.quoteVolume < config.filters.minVolume24hUsd) {
    reasons.push(`Low volume: $${(ticker.quoteVolume / 1e6).toFixed(1)}M < $${(config.filters.minVolume24hUsd / 1e6).toFixed(0)}M`);
    pass = false;
  }

  // 2. Volatility check (ATR %)
  const volatility = atrPercent(candles);
  if (volatility < config.filters.minAtrPercent) {
    reasons.push(`Low volatility: ATR ${volatility.toFixed(2)}% < ${config.filters.minAtrPercent}%`);
    pass = false;
  }

  // 3. Trend clarity check
  if (trend.direction === 'neutral' || trend.strength < config.filters.minTrendStrength) {
    reasons.push(`Weak trend: ${trend.direction} (strength ${trend.strength.toFixed(2)} < ${config.filters.minTrendStrength})`);
    pass = false;
  }

  if (!pass) {
    logger.debug(`${symbol} filtered out: ${reasons.join('; ')}`);
  }

  return { pass, reasons };
}

module.exports = { applyFilters, atrPercent };
