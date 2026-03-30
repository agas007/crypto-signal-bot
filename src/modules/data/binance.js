const axios = require('axios');
const config = require('../../config');
const logger = require('../../utils/logger');
const sleep = require('../../utils/sleep');

const FALLBACK_ENDPOINTS = [
  'https://data-api.binance.vision', // Most accessible for public data
  'https://api.binance.me',          // Often works where .com is blocked
  'https://api-gcp.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com',
];

// Cache the working endpoint to avoid spamming blocked ones
let currentWorkingUrl = config.binance.baseUrl;

/**
 * Perform a GET request with fallback support for regional blocks (451).
 *
 * @param {string} path - API path (e.g. '/api/v3/klines')
 * @param {Object} params - Query params
 * @returns {Promise<any>}
 */
async function getWithFallback(path, params = {}) {
  // Most resilient endpoints first
  const urls = [
    currentWorkingUrl,
    'https://data-api.binance.vision',
    'https://api.binance.me',
    config.binance.baseUrl,
    ...FALLBACK_ENDPOINTS,
  ];
  
  // Filter unique URLs to avoid redundant attempts
  const uniqueUrls = [...new Set(urls)];
  let lastError;

  for (const baseUrl of uniqueUrls) {
    try {
      const response = await axios.get(`${baseUrl}${path}`, {
        params,
        timeout: 10_000,
      });
      
      // Success! Update our sticky endpoint
      if (currentWorkingUrl !== baseUrl) {
        logger.info(`✨ Successfully connected via ${baseUrl}`);
        currentWorkingUrl = baseUrl;
      }
      
      return response.data;
    } catch (err) {
      lastError = err;
      const status = err.response?.status;

      // Rate limit (429) is a hard stop
      if (status === 429) {
        logger.error(`⚠️ Rate limited at ${baseUrl}, aborting...`);
        throw err;
      }

      // For any other error (regional block, network issue, 403, 451 etc), try next
      const code = status || 'NETWORK_ERR';
      logger.warn(`⚠️ Endpoint ${baseUrl} failed (${code}), trying next fallback...`);
      continue;
    }
  }

  throw lastError;
}

/**
 * Fetch OHLCV candlestick data from Binance.
 *
 * @param {string} symbol    - Trading pair, e.g. "BTCUSDT"
 * @param {string} interval  - Binance interval code: "1d", "4h", "15m"
 * @param {number} [limit=100] - Number of candles to fetch
 * @returns {Promise<Array<{
 *   openTime: number, open: number, high: number, low: number,
 *   close: number, volume: number, closeTime: number, quoteVolume: number
 * }>>}
 */
async function fetchOHLCV(symbol, interval, limit = 100) {
  try {
    const data = await getWithFallback('/api/v3/klines', { symbol, interval, limit });

    return data.map((candle) => ({
      openTime: candle[0],
      open: parseFloat(candle[1]),
      high: parseFloat(candle[2]),
      low: parseFloat(candle[3]),
      close: parseFloat(candle[4]),
      volume: parseFloat(candle[5]),
      closeTime: candle[6],
      quoteVolume: parseFloat(candle[7]),
    }));
  } catch (err) {
    logger.error(`Failed to fetch ${symbol} ${interval}:`, err.message);
    return [];
  }
}

/**
 * Fetch multi-timeframe data for a symbol with rate-limit handling.
 *
 * @param {string} symbol
 * @returns {Promise<{ D1: Array, H4: Array, M15: Array } | null>}
 */
async function fetchMultiTimeframe(symbol) {
  const result = {};

  for (const [tfName, tfCode] of Object.entries(config.timeframes)) {
    const candles = await fetchOHLCV(symbol, tfCode);
    if (!candles.length) {
      logger.warn(`No ${tfName} data for ${symbol}, skipping`);
      return null;
    }
    result[tfName] = candles;
    await sleep(config.binance.rateLimitMs);
  }

  return result;
}

/**
 * Fetch top trading pairs by 24h quote volume.
 *
 * @param {number} [limit=30] - Max pairs to return
 * @returns {Promise<string[]>}  - e.g. ["BTCUSDT", "ETHUSDT", ...]
 */
async function fetchTopPairs(limit = config.scanner.maxPairs) {
  try {
    const data = await getWithFallback('/api/v3/ticker/24hr');

    const usdtPairs = data
      .filter((t) => t.symbol.endsWith('USDT') && !t.symbol.includes('UP') && !t.symbol.includes('DOWN'))
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, limit)
      .map((t) => t.symbol);

    logger.info(`Fetched top ${usdtPairs.length} USDT pairs by volume`);
    return usdtPairs;
  } catch (err) {
    logger.error('Failed to fetch top pairs:', err.message);
    return [];
  }
}

/**
 * Get 24h ticker stats for a symbol (volume, price change, etc.)
 *
 * @param {string} symbol
 * @returns {Promise<Object|null>}
 */
async function fetch24hTicker(symbol) {
  try {
    const data = await getWithFallback('/api/v3/ticker/24hr', { symbol });

    return {
      symbol: data.symbol,
      priceChangePercent: parseFloat(data.priceChangePercent),
      volume: parseFloat(data.volume),
      quoteVolume: parseFloat(data.quoteVolume),
      lastPrice: parseFloat(data.lastPrice),
      highPrice: parseFloat(data.highPrice),
      lowPrice: parseFloat(data.lowPrice),
    };
  } catch (err) {
    logger.error(`Failed to fetch ticker for ${symbol}:`, err.message);
    return null;
  }
}

module.exports = {
  fetchOHLCV,
  fetchMultiTimeframe,
  fetchTopPairs,
  fetch24hTicker,
};
