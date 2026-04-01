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

const FUTURES_URL = 'https://fapi.binance.com';

let currentWorkingUrl = config.binance.baseUrl;

/**
 * Perform a GET request with fallback or signed security.
 */
async function getWithFallback(path, params = {}, isSigned = false, isFutures = false) {
  const queryParams = { ...params };
  let headers = {};
  const actualBaseUrl = isFutures ? FUTURES_URL : currentWorkingUrl;

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

  // Use simple request for futures if it's the target, or fallback chain for public spot
  try {
    const response = await axios.get(`${actualBaseUrl}${path}`, {
      params: queryParams,
      headers,
      timeout: 10_000,
    });
    return response.data;
  } catch (err) {
    if (isFutures) throw err; // Futures is less prone to local blocks than spot
    
    // For spot, keep checking uniqueUrls
    const urls = [
      currentWorkingUrl,
      'https://api.binance.me',
      'https://data-api.binance.vision',
      config.binance.baseUrl,
      ...FALLBACK_ENDPOINTS,
    ];
    
    const uniqueUrls = [...new Set(urls)];
    let lastError = err;

    for (const baseUrl of uniqueUrls) {
      if (baseUrl === actualBaseUrl) continue;
      try {
        const response = await axios.get(`${baseUrl}${path}`, {
          params: queryParams,
          headers,
          timeout: 10_000,
        });
        if (currentWorkingUrl !== baseUrl) currentWorkingUrl = baseUrl;
        return response.data;
      } catch (e) {
        lastError = e;
        if (e.response?.status === 429) throw e;
        logger.warn(`⚠️ Endpoint ${baseUrl} failed (${e.response?.status || 'NETWORK_ERR'})`);
        continue;
      }
    }
    throw lastError;
  }
}

/**
 * Fetch personal trade history (PRIVATE).
 * Supports both SPOT and FUTURES.
 */
async function fetchUserTrades(symbol, startTime = null, type = 'spot') {
    try {
        const params = { limit: 1000 }; // Increased from 500 to 1000 (Max allowed by Binance)
        if (symbol) params.symbol = symbol.toUpperCase();
        if (startTime) params.startTime = startTime;
        
        const path = type === 'futures' ? '/fapi/v1/userTrades' : '/api/v3/myTrades';
        const data = await getWithFallback(path, params, true, type === 'futures');
        
        return data.map(t => ({
            symbol: t.symbol,
            price: parseFloat(t.price),
            qty: parseFloat(t.qty),
            quoteQty: type === 'futures' ? (parseFloat(t.price) * parseFloat(t.qty)) : parseFloat(t.quoteQty),
            commission: parseFloat(t.commission),
            isBuyer: type === 'futures' ? (parseFloat(t.realizedPnl) === 0 ? true : false) : t.isBuyer, // Simple heuristic for futures pnl matching
            realizedPnl: parseFloat(t.realizedPnl || 0),
            time: t.time,
        }));
    } catch (err) {
        logger.error(`Failed to fetch ${type} trades for ${symbol}:`, err.message);
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
