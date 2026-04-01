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
const FUTURES_FALLBACK_URLS = [
  'https://fapi1.binance.com',
  'https://fapi2.binance.com',
  'https://fapi3.binance.com',
];

let currentWorkingUrl = config.binance.baseUrl;
let currentWorkingFuturesUrl = FUTURES_URL;

/**
 * Perform a GET request with fallback or signed security.
 */
async function getWithFallback(path, params = {}, isSigned = false, isFutures = false) {
  const queryParams = { ...params };
  let headers = {};
  const actualBaseUrl = isFutures ? currentWorkingFuturesUrl : currentWorkingUrl;

  if (isSigned) {
    if (!config.binance.apiKey || !config.binance.apiSecret) {
        throw new Error('BINANCE_API_KEY and BINANCE_API_SECRET are required for private requests');
    }
    queryParams.timestamp = Date.now();
    queryParams.recvWindow = 60000; // Increased tolerance for server time skew (60s)
    
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
      timeout: 15_000, // Slightly longer timeout for production stability
    });
    return response.data;
  } catch (err) {
    if (err.response && err.response.data) {
        const bErr = err.response.data;
        logger.error(`❌ Binance API Error (${path}): Code: ${bErr.code}, Msg: ${bErr.msg}`);
        // Handle specific error: Timestamp outside recvWindow
        if (bErr.code === -1021) {
            logger.warn('⚠️ Server time is out of sync. Trying to adjust timestamp...');
        }
    }
    
    if (isFutures) {
        const fUrls = [
            FUTURES_URL,
            ...FUTURES_FALLBACK_URLS
        ];
        
        for (const baseUrl of fUrls) {
            if (baseUrl === actualBaseUrl) continue;
            try {
                const response = await axios.get(`${baseUrl}${path}`, {
                    params: queryParams,
                    headers,
                    timeout: 15_000,
                });
                currentWorkingFuturesUrl = baseUrl;
                return response.data;
            } catch (e) {
                if (e.response?.status === 429) throw e;
                continue;
            }
        }
        throw err; // If all fallbacks failed, throw original
    }
    
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
        const params = { limit: 1000 };
        if (symbol) params.symbol = symbol.toUpperCase();
        if (startTime) params.startTime = startTime;
        
        const path = type === 'futures' ? '/fapi/v1/userTrades' : '/api/v3/myTrades';
        const data = await getWithFallback(path, params, true, type === 'futures');

        if (!data || !Array.isArray(data)) {
            logger.warn(`⚠️ Binance returned non-array for ${type} ${symbol}: ${JSON.stringify(data)}`);
            return [];
        }

        return data.map(t => ({
            symbol: t.symbol,
            id: t.id,
            orderId: t.orderId,
            price: parseFloat(t.price),
            qty: parseFloat(t.qty),
            quoteQty: parseFloat(t.quoteQty),
            commission: parseFloat(t.commission),
            commissionAsset: t.commissionAsset,
            time: t.time,
            isBuyer: t.isBuyer,
            isMaker: t.isMaker,
            realizedPnl: parseFloat(t.realizedPnl || 0)
        }));
    } catch (err) {
        logger.error(`Failed to fetch ${type} trades for ${symbol}: ${err.message}`);
        return []; 
    }
}

/**
 * Fetch OHLCV candlestick data from Binance.
 */
async function fetchOHLCV(symbol, interval, limit = 100) {
  try {
    const data = await getWithFallback('/api/v3/klines', { symbol, interval, limit });
    if (!data || !Array.isArray(data)) return [];

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
    if (!data || !Array.isArray(data)) return [];

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
