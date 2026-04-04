const axios = require('axios');
const crypto = require('crypto');
const config = require('../../config');
const logger = require('../../utils/logger');
const sleep = require('../../utils/sleep');

const FALLBACK_ENDPOINTS = [
  'https://data-api.binance.vision',
  'https://api.binance.me',
  'https://api-gcp.binance.com',
  'https://api.binance.me',
];

const FUTURES_URL = 'https://fapi.binance.com';
const FUTURES_FALLBACK_URLS = [
  'https://fapi1.binance.com',
  'https://fapi2.binance.com',
  'https://fapi3.binance.com',
];

let currentWorkingUrl = config.binance.baseUrl;
let currentWorkingFuturesUrl = FUTURES_URL;
let isIpBlocked = false;
let blockResetTime = 0;

function checkIpBlock() {
    if (isIpBlocked && Date.now() > blockResetTime) isIpBlocked = false;
    return isIpBlocked;
}

/**
 * Map assets to their Futures-specific symbols (e.g. PEPE -> 1000PEPE).
 */
function toFuturesSymbol(symbol) {
    const sym = symbol.toUpperCase();
    const mapping = {
        'PEPEUSDT': '1000PEPEUSDT',
        'SHIBUSDT': '1000SHIBUSDT',
        'FLOKIUSDT': '1000FLOKIUSDT',
        'BONKUSDT': '1000BONKUSDT',
        'LUNCUSDT': '1000LUNCUSDT',
        'XECUSDT': '1000XECUSDT',
        'SATSUSDT': '1000SATSUSDT',
        'RATSUSDT': '1000RATSUSDT',
    };
    return mapping[sym] || sym;
}

/**
 * Perform a GET request with fallback or signed security.
 */
async function getWithFallback(path, params = {}, isSigned = false, isFutures = false) {
  if (checkIpBlock()) throw new Error('BINANCE_IP_BLOCK_451');

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
    if (err.response) {
        const bErr = err.response.data;
        const status = err.response.status;

        if (status === 451) {
            isIpBlocked = true;
            blockResetTime = Date.now() + 15 * 60 * 1000;
            logger.warn(`🛑 Binance Restricted Location (451) for ${path}. IP marked as blocked for 15 mins.`);
            throw new Error('BINANCE_RESTRICTED_LOCATION_451');
        } else {
            const code = bErr?.code ?? 'N/A';
            const msg = bErr?.msg ?? err.message ?? 'Unknown';
            logger.error(`❌ Binance API Error (${path}): Code: ${code}, Msg: ${msg}`);
        }
    } else {
        logger.error(`❌ Binance Network Error (${path}): ${err.message}`);
    }
    
    if (err.response?.status === 451) {
        throw new Error('BINANCE_RESTRICTED_LOCATION_451');
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
                if (e.response?.status === 451) throw new Error('BINANCE_RESTRICTED_LOCATION_451');
                continue;
            }
        }
        throw err;
    }
    
    // For spot
    const urls = [
      currentWorkingUrl,
      'https://api.binance.me',
      'https://data-api.binance.vision',
      config.binance.baseUrl,
      ...FALLBACK_ENDPOINTS,
    ].filter(Boolean);
    
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
        if (e.response?.status === 451) {
            isIpBlocked = true;
            blockResetTime = Date.now() + 15 * 60 * 1000;
            throw new Error('BINANCE_RESTRICTED_LOCATION_451');
        }
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

        if (data === '' || !data) {
            return [];
        }

        if (!Array.isArray(data)) {
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
        throw err; // Re-throw so caller can detect 451
    }
}

/**
 * Fetch OHLCV candlestick data from Binance.
 */
async function fetchOHLCV(symbol, interval, limit = 100, options = {}) {
  try {
    const futuresSymbol = toFuturesSymbol(symbol);
    const params = { symbol: futuresSymbol, interval, limit, ...options };
    // Use Futures candles for bot accuracy
    const data = await getWithFallback('/fapi/v1/klines', params, false, true);
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
    const data = await getWithFallback('/fapi/v1/ticker/24hr', {}, false, true);
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
    const futuresSymbol = toFuturesSymbol(symbol);
    const data = await getWithFallback('/fapi/v1/ticker/24hr', { symbol: futuresSymbol }, false, true);
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

/**
 * Fetch current funding rate for a futures symbol.
 *
 * @param {string} symbol
 * @returns {Promise<number|null>} Funding rate as float (e.g. 0.0001 = 0.01%)
 */
async function fetchFundingRate(symbol) {
  try {
    const futuresSymbol = toFuturesSymbol(symbol);
    const data = await getWithFallback('/fapi/v1/premiumIndex', { symbol: futuresSymbol }, false, true);
    return parseFloat(data.lastFundingRate);
  } catch (err) {
    // If it's a 400 error (Invalid Symbol), we probably can't fetch it
    if (err.message.includes('400') || err.message.includes('-1121')) {
        logger.debug(`No futures market found for ${symbol}, skipping funding check.`);
        return 0;
    }
    logger.error(`Failed to fetch funding rate for ${symbol}:`, err.message);
    return null;
  }
}
/**
 * Fetch total USDT balance from Binance Futures (PRIVATE).
 */
async function fetchFuturesBalance() {
    try {
        const data = await getWithFallback('/fapi/v2/balance', {}, true, true);
        if (!data || !Array.isArray(data)) return 0;

        const usdtAsset = data.find(asset => asset.asset === 'USDT');
        return usdtAsset ? parseFloat(usdtAsset.balance) : 0;
    } catch (err) {
        logger.error(`Failed to fetch futures balance: ${err.message}`);
        return 0;
    }
}

/**
 * Fetch trading constraints (LOT_SIZE) for all futures symbols.
 */
async function fetchExchangeSpecs() {
    try {
        const data = await getWithFallback('/fapi/v1/exchangeInfo', {}, false, true);
        const specs = {};
        if (data && data.symbols) {
            data.symbols.forEach(s => {
                const lotFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
                specs[s.symbol] = {
                    stepSize: lotFilter ? parseFloat(lotFilter.stepSize) : 0.001,
                    precision: s.quantityPrecision
                };
            });
        }
        return specs;
    } catch (err) {
        logger.error(`Failed to fetch exchange info: ${err.message}`);
        return {};
    }
}

module.exports = {
  fetchOHLCV,
  fetchMultiTimeframe,
  fetchTopPairs,
  fetch24hTicker,
  fetchUserTrades,
  fetchFundingRate,
  fetchFuturesBalance,
  fetchExchangeSpecs,
};
