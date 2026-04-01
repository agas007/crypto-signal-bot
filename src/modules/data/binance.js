const axios = require('axios');
const crypto = require('crypto');
const config = require('../../config');
const logger = require('../../utils/logger');
const sleep = require('../../utils/sleep');

const FALLBACK_ENDPOINTS = [
  'https://data-api.binance.vision',
  'https://api.binance.me',
  'https://api-gcp.binance.com',
];

let currentWorkingUrl = config.binance.baseUrl;

/**
 * Perform a GET request with fallback or signed security.
 */
async function getWithFallback(path, params = {}, isSigned = false) {
  const queryParams = { ...params };
  let headers = {};

  if (isSigned) {
    if (!config.binance.apiKey || !config.binance.apiSecret) {
        throw new Error('BINANCE_API_KEY and BINANCE_API_SECRET are required for private requests');
    }
    queryParams.timestamp = Date.now();
    const queryString = Object.entries(queryParams)
      .map(([key, val]) => `${key}=${encodeURIComponent(val)}`)
      .join('&');
    
    const signature = crypto
      .createHmac('sha256', config.binance.apiSecret)
      .update(queryString)
      .digest('hex');
    
    queryParams.signature = signature;
    headers['X-MBX-APIKEY'] = config.binance.apiKey;
  }

  const urls = [
    currentWorkingUrl,
    'https://api.binance.me',
    'https://data-api.binance.vision',
    config.binance.baseUrl,
    ...FALLBACK_ENDPOINTS,
  ];
  
  const uniqueUrls = [...new Set(urls)];
  let lastError;

  for (const baseUrl of uniqueUrls) {
    try {
      const response = await axios.get(`${baseUrl}${path}`, {
        params: queryParams,
        headers,
        timeout: 10_000,
      });
      
      if (currentWorkingUrl !== baseUrl) currentWorkingUrl = baseUrl;
      return response.data;
    } catch (err) {
      lastError = err;
      if (err.response?.status === 429) throw err;
      logger.warn(`⚠️ Endpoint ${baseUrl} failed (${err.response?.status || 'NETWORK_ERR'})`);
      continue;
    }
  }

  throw lastError;
}

/**
 * Fetch personal trade history (PRIVATE).
 */
async function fetchUserTrades(symbol, startTime = null) {
    try {
        const params = { symbol: symbol.toUpperCase(), limit: 100 };
        if (startTime) params.startTime = startTime;
        
        const data = await getWithFallback('/api/v3/myTrades', params, true);
        return data.map(t => ({
            symbol: t.symbol,
            price: parseFloat(t.price),
            qty: parseFloat(t.qty),
            quoteQty: parseFloat(t.quoteQty),
            commission: parseFloat(t.commission),
            isBuyer: t.isBuyer,
            time: t.time,
        }));
    } catch (err) {
        logger.error(`Failed to fetch trades for ${symbol}:`, err.message);
        return [];
    }
}

/**
 * Fetch OHLCV candlestick data from Binance.
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

async function fetchMultiTimeframe(symbol) {
  const result = {};
  for (const [tfName, tfCode] of Object.entries(config.timeframes)) {
    const candles = await fetchOHLCV(symbol, tfCode);
    if (!candles.length) return null;
    result[tfName] = candles;
    await sleep(config.binance.rateLimitMs);
  }
  return result;
}

async function fetchTopPairs(limit = config.scanner.maxPairs) {
  try {
    const data = await getWithFallback('/api/v3/ticker/24hr');
    return data
      .filter((t) => t.symbol.endsWith('USDT') && !t.symbol.includes('UP') && !t.symbol.includes('DOWN'))
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, limit)
      .map((t) => t.symbol);
  } catch (err) {
    logger.error('Failed to fetch top pairs:', err.message);
    return [];
  }
}

async function fetch24hTicker(symbol) {
  try {
    const data = await getWithFallback('/api/v3/ticker/24hr', { symbol });
    return {
      symbol: data.symbol,
      priceChangePercent: parseFloat(data.priceChangePercent),
      volume: parseFloat(data.volume),
      quoteVolume: parseFloat(data.quoteVolume),
      lastPrice: parseFloat(data.lastPrice),
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
  fetchUserTrades,
};
