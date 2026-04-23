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
    const signatureHeaders = { 'X-MBX-APIKEY': config.binance.apiKey };
    headers = { ...signatureHeaders }; // start fresh
    queryParams.timestamp = Date.now();
    queryParams.recvWindow = 60000;
    
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
            
            // SILENCE OPTIONAL DATA ERRORS
            // If it's a 404 or -2014 on optional data paths, log as WARN instead of scary ERROR
            const isOptionalData = path.includes('/futures/data/') || path.includes('/forceOrders');
            if (isOptionalData || status === 404) {
                logger.warn(`ℹ️ Binance Info (${path}): ${status === 404 ? 'Data not available for this symbol' : msg}`);
            } else {
                logger.error(`❌ Binance API Error (${path}): Code: ${code}, Msg: ${msg}`);
            }
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
async function fetchUserTrades(symbol, startTime = null, type = 'spot', fromId = null) {
    try {
        const params = { limit: 1000 };
        if (symbol) params.symbol = symbol.toUpperCase();
        if (startTime !== null && startTime !== undefined) params.startTime = startTime;
        if (fromId !== null && fromId !== undefined) params.fromId = fromId;
        
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
    const safeLimit = parseInt(limit, 10) || 100;
    const params = { symbol: futuresSymbol, interval, limit: safeLimit, ...options };
    
    // Try Futures first
    try {
      const data = await getWithFallback('/fapi/v1/klines', params, false, true);
      if (data && Array.isArray(data)) {
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
      }
    } catch (futuresErr) {
      // If it's an invalid symbol, it might be SPOT only
      if (futuresErr.message.includes('-1121')) {
        logger.info(`ℹ️ ${symbol} not found on Futures, falling back to Spot...`);
      } else {
        throw futuresErr; // rethrow other errors
      }
    }

    // Fallback to Spot
    const data = await getWithFallback('/api/v3/klines', { ...params, symbol: symbol.toUpperCase() }, false, false);
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
    logger.error(`❌ Failed to fetch ${symbol} ${interval}:`, err.message);
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
 * Fetch real-time Open Interest for a futures symbol.
 * @param {string} symbol
 * @returns {Promise<{openInterest: number, symbol: string}|null>}
 */
async function fetchOpenInterest(symbol) {
  try {
    const futuresSymbol = toFuturesSymbol(symbol);
    const data = await getWithFallback('/fapi/v1/openInterest', { symbol: futuresSymbol }, false, true);
    return {
      symbol: data.symbol,
      openInterest: parseFloat(data.openInterest),
    };
  } catch (err) {
    logger.debug(`fetchOpenInterest(${symbol}): ${err.message}`);
    return null;
  }
}

/**
 * Fetch historical Open Interest (trend) for a futures symbol.
 * Returns an array ordered oldest-first so you can detect rising/falling OI.
 * @param {string} symbol
 * @param {'5m'|'15m'|'30m'|'1h'|'2h'|'4h'|'6h'|'12h'|'1d'} period
 * @param {number} limit  Max 500
 * @returns {Promise<Array<{timestamp: number, sumOpenInterest: number}>>}
 */
async function fetchOpenInterestHistory(symbol, period = '1h', limit = 12) {
  try {
    const futuresSymbol = toFuturesSymbol(symbol);
    const data = await getWithFallback(
      '/futures/data/openInterestHist',
      { symbol: futuresSymbol, period, limit },
      false,
      true
    );
    if (!Array.isArray(data)) return [];
    return data.map(d => ({
      timestamp: d.timestamp,
      sumOpenInterest: parseFloat(d.sumOpenInterest),
      sumOpenInterestValue: parseFloat(d.sumOpenInterestValue),
    }));
  } catch (err) {
    logger.debug(`fetchOpenInterestHistory(${symbol}): ${err.message}`);
    return [];
  }
}

/**
 * Fetch Global Long/Short Account Ratio.
 * Measures overall retail crowd sentiment (Long accounts vs Short accounts).
 * @param {string} symbol
 * @param {'5m'|'15m'|'30m'|'1h'|'2h'|'4h'|'6h'|'12h'|'1d'} period
 * @param {number} limit
 * @returns {Promise<Array<{longShortRatio: number, longAccount: number, shortAccount: number}>>}
 */
async function fetchGlobalLongShortRatio(symbol, period = '1h', limit = 6) {
  try {
    const futuresSymbol = toFuturesSymbol(symbol);
    const data = await getWithFallback(
      '/futures/data/globalLongShortAccountRatio',
      { symbol: futuresSymbol, period, limit },
      false,
      true
    );
    if (!Array.isArray(data)) return [];
    return data.map(d => ({
      timestamp: d.timestamp,
      longShortRatio: parseFloat(d.longShortRatio),
      longAccount: parseFloat(d.longAccount),
      shortAccount: parseFloat(d.shortAccount),
    }));
  } catch (err) {
    logger.debug(`fetchGlobalLongShortRatio(${symbol}): ${err.message}`);
    return [];
  }
}

/**
 * Fetch Top Trader Long/Short Account Ratio (smart money).
 * These are institutional traders, more predictive than retail crowd.
 * @param {string} symbol
 * @param {'5m'|'15m'|'30m'|'1h'|'2h'|'4h'|'6h'|'12h'|'1d'} period
 * @param {number} limit
 * @returns {Promise<Array<{longShortRatio: number, longAccount: number, shortAccount: number}>>}
 */
async function fetchTopTraderLongShortRatio(symbol, period = '1h', limit = 6) {
  try {
    const futuresSymbol = toFuturesSymbol(symbol);
    const data = await getWithFallback(
      '/futures/data/topTraderLongShortAccountRatio',
      { symbol: futuresSymbol, period, limit },
      false,
      true
    );
    if (!Array.isArray(data)) return [];
    return data.map(d => ({
      timestamp: d.timestamp,
      longShortRatio: parseFloat(d.longShortRatio),
      longAccount: parseFloat(d.longAccount),
      shortAccount: parseFloat(d.shortAccount),
    }));
  } catch (err) {
    logger.debug(`fetchTopTraderLongShortRatio(${symbol}): ${err.message}`);
    return [];
  }
}

/**
 * Fetch L2 Order Book depth and compute bid/ask imbalance.
 * High bid wall → bullish pressure. High ask wall → bearish pressure.
 * @param {string} symbol
 * @param {number} limit  5, 10, 20, 50, 100, 500, 1000
 * @returns {Promise<{bidVolume: number, askVolume: number, imbalance: number, bias: 'BUY'|'SELL'|'NEUTRAL'}|null>}
 */
async function fetchOrderBookDepth(symbol, limit = 20) {
  try {
    const futuresSymbol = toFuturesSymbol(symbol);
    const data = await getWithFallback(
      '/fapi/v1/depth',
      { symbol: futuresSymbol, limit },
      false,
      true
    );
    if (!data || !data.bids || !data.asks) return null;

    const bidVolume = data.bids.reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
    const askVolume = data.asks.reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
    const total = bidVolume + askVolume;
    // imbalance = +1 (all bids), -1 (all asks), 0 (neutral)
    const imbalance = total > 0 ? (bidVolume - askVolume) / total : 0;
    const bias = imbalance > 0.1 ? 'BUY' : imbalance < -0.1 ? 'SELL' : 'NEUTRAL';

    return { bidVolume, askVolume, imbalance, bias };
  } catch (err) {
    logger.debug(`fetchOrderBookDepth(${symbol}): ${err.message}`);
    return null;
  }
}

/**
 * Fetch recent forced liquidation orders.
 * Clusters of liqidations near price = potential reversal zone.
 * @param {string} symbol
 * @param {'LONG'|'SHORT'} [side]  Filter by side (optional)
 * @param {number} limit  Max 100
 * @returns {Promise<Array<{side: string, price: number, origQty: number, executedQty: number, time: number}>>}
 */
async function fetchLiquidationOrders(symbol, limit = 50) {
  try {
    const futuresSymbol = toFuturesSymbol(symbol);
    const data = await getWithFallback(
      '/fapi/v1/forceOrders',
      { symbol: futuresSymbol, limit, autoCloseType: 'LIQUIDATION' },
      false,
      true
    );
    if (!Array.isArray(data)) return [];
    return data.map(o => ({
      side: o.side, // BUY=SHORT liquidated, SELL=LONG liquidated
      price: parseFloat(o.price),
      origQty: parseFloat(o.origQty),
      executedQty: parseFloat(o.executedQty),
      avgPrice: parseFloat(o.avgPrice || o.price),
      time: o.time,
    }));
  } catch (err) {
    logger.debug(`fetchLiquidationOrders(${symbol}): ${err.message}`);
    return [];
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
                const notionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
                specs[s.symbol] = {
                    symbol: s.symbol,
                    stepSize: lotFilter ? parseFloat(lotFilter.stepSize) : 0.001,
                    precision: s.quantityPrecision,
                    minNotional: notionalFilter ? parseFloat(notionalFilter.notional || notionalFilter.minNotional) : 5.0
                };
            });
        }
        return specs;
    } catch (err) {
        logger.error(`Failed to fetch exchange info: ${err.message}`);
        return {};
    }
}

/**
 * Fetch active Spot symbols from Binance exchange info.
 */
async function fetchSpotExchangeSymbols() {
    try {
        const data = await getWithFallback('/api/v3/exchangeInfo', {}, false, false);
        if (!data || !Array.isArray(data.symbols)) return [];

        return data.symbols
            .filter((s) => s.status === 'TRADING')
            .map((s) => s.symbol);
    } catch (err) {
        logger.error(`Failed to fetch spot exchange symbols: ${err.message}`);
        return [];
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
  fetchSpotExchangeSymbols,
  toFuturesSymbol,
  // Market Microstructure
  fetchOpenInterest,
  fetchOpenInterestHistory,
  fetchGlobalLongShortRatio,
  fetchTopTraderLongShortRatio,
  fetchOrderBookDepth,
  fetchLiquidationOrders,
};
