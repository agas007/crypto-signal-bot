/**
 * Bybit API v5 Data Module
 * Drop-in replacement for binance.js — exports identical function signatures.
 *
 * Env vars (all optional for public endpoints):
 *   BYBIT_BASE_URL   - default: https://api.bybit.com
 *   BYBIT_API_KEY    - required only for private endpoints (balance, trades)
 *   BYBIT_API_SECRET - required only for private endpoints
 */

const crypto = require('crypto');
const config = require('../../config');
const logger = require('../../utils/logger');
const sleep = require('../../utils/sleep');
const http = require('../../utils/http_client');
const binanceData = require('./binance');
const futuresRouter = require('./futures_router');

const DEFAULT_BYBIT_BASE_URLS = ['https://api.bytick.com', 'https://api.bybit.id', 'https://api.bybit.com'];
const BASE_URLS = (() => {
  const rawList = process.env.BYBIT_BASE_URLS || process.env.BYBIT_BASE_URL || DEFAULT_BYBIT_BASE_URLS.join(',');
  return rawList
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/\/+$/, ''));
})();
const API_KEY = process.env.BYBIT_API_KEY || config.bybit?.apiKey;
const API_SECRET = process.env.BYBIT_API_SECRET || config.bybit?.apiSecret;
const DISABLE_PUBLIC_BYBIT = process.env.BYBIT_DISABLE_PUBLIC === '1';

let publicBybitBlocked = DISABLE_PUBLIC_BYBIT;
let publicBybitBlockLogged = false;
const loggedBybitErrors = new Set();

// ─── Interval Mapping: Binance format → Bybit format ────────────────────────
const INTERVAL_MAP = {
  '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
  '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720',
  '1d': 'D', '1w': 'W', '1M': 'M',
};

function toBybitInterval(binanceInterval) {
  return INTERVAL_MAP[binanceInterval] || binanceInterval;
}

// ─── Symbol helpers ──────────────────────────────────────────────────────────

// Bybit also uses 1000x multiplied symbols for low-price coins
const SYMBOL_MAP = {
  'PEPEUSDT':  '1000PEPEUSDT',
  'SHIBUSDT':  '1000SHIBUSDT',
  'FLOKIUSDT': '1000FLOKIUSDT',
  'BONKUSDT':  '1000BONKUSDT',
  'LUNCUSDT':  '1000LUNCUSDT',
  'XECUSDT':   '1000XECUSDT',
  'SATSUSDT':  '1000SATSUSDT',
};

function toFuturesSymbol(symbol) {
  const sym = symbol.toUpperCase();
  return SYMBOL_MAP[sym] || sym;
}

function normalizeBybitKlineRow(row) {
  if (!Array.isArray(row)) return null;
  return {
    openTime: Number(row[0]),
    open: parseFloat(row[1]),
    high: parseFloat(row[2]),
    low: parseFloat(row[3]),
    close: parseFloat(row[4]),
    volume: parseFloat(row[5]),
    turnover: parseFloat(row[6]),
  };
}

function normalizeBybitTicker(item, symbol) {
  if (!item) return null;
  return {
    symbol: item.symbol || toFuturesSymbol(symbol),
    priceChangePercent: parseFloat(item.price24hPcnt || item.priceChangePercent || 0),
    volume: parseFloat(item.volume24h || item.volume || 0),
    quoteVolume: parseFloat(item.turnover24h || item.quoteVolume || 0),
    lastPrice: parseFloat(item.lastPrice || item.last || 0),
    fundingRate: parseFloat(item.fundingRate || item.fundingRatePct || item.fundingRatePercentage || 0),
    openInterest: parseFloat(item.openInterest || item.oi || 0),
  };
}

async function fetchBybitPublicOHLCV(symbol, interval, limit = 100, options = {}) {
  const intervalCode = toBybitInterval(interval);
  const result = await bybitGet('/v5/market/kline', {
    category: 'linear',
    symbol: toFuturesSymbol(symbol),
    interval: intervalCode,
    limit,
    ...(options.startTime ? { start: Math.floor(options.startTime / 1000) } : {}),
    ...(options.endTime ? { end: Math.floor(options.endTime / 1000) } : {}),
  });

  const rows = Array.isArray(result?.list) ? result.list : [];
  return rows
    .map(normalizeBybitKlineRow)
    .filter(Boolean)
    .sort((a, b) => a.openTime - b.openTime);
}

async function fetchBybitPublicTopPairs(limit = config.scanner.maxPairs) {
  const result = await bybitGet('/v5/market/tickers', {
    category: 'linear',
  });
  const rows = Array.isArray(result?.list) ? result.list : [];
  return rows
    .filter((item) => item?.symbol && item.symbol.endsWith('USDT'))
    .sort((a, b) => parseFloat(b.turnover24h || b.volume24h || 0) - parseFloat(a.turnover24h || a.volume24h || 0))
    .slice(0, limit)
    .map((item) => item.symbol);
}

async function fetchBybitPublicTicker(symbol) {
  const result = await bybitGet('/v5/market/tickers', {
    category: 'linear',
    symbol: toFuturesSymbol(symbol),
  });
  const item = Array.isArray(result?.list) ? result.list[0] : null;
  return normalizeBybitTicker(item, symbol);
}

async function fetchBybitPublicExchangeSpecs() {
  const result = await bybitGet('/v5/market/instruments-info', {
    category: 'linear',
  });
  const rows = Array.isArray(result?.list) ? result.list : [];
  const specs = {};
  for (const row of rows) {
    if (!row?.symbol) continue;
    specs[row.symbol] = {
      symbol: row.symbol,
      stepSize: parseFloat(row.lotSizeFilter?.qtyStep || row.lotSizeFilter?.minOrderQty || 0.001) || 0.001,
      precision: Number.parseInt(row.priceFilter?.tickSize ? String(row.priceFilter.tickSize).split('.')[1]?.length || '3' : '3', 10) || 3,
      minNotional: parseFloat(row.lotSizeFilter?.minNotionalValue || row.minNotional || 5.0) || 5.0,
    };
  }
  return specs;
}

function isBybitGeoBlockedError(err) {
  const status = err?.response?.status;
  const payload = err?.response?.data;
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
  const message = `${err?.message || ''} ${body}`.toLowerCase();

  return status === 403 || status === 451 || message.includes('block access from your country');
}

function markPublicBybitBlocked(err, path) {
  publicBybitBlocked = true;
  if (!publicBybitBlockLogged) {
    publicBybitBlockLogged = true;
    const status = err?.response?.status || 'N/A';
    logger.warn(
      `🛑 Bybit public endpoints blocked (${status}) on ${path}. Falling back to other market-data providers.`
    );
  }
}

function shouldUseBybitPrimary() {
  return !publicBybitBlocked && !DISABLE_PUBLIC_BYBIT;
}

function isTransientBybitUrlError(err) {
  if (!err) return false;
  if (isBybitGeoBlockedError(err)) return true;
  const status = err?.response?.status;
  return !status || status >= 500 || status === 403 || status === 451;
}

function logBybitOnce(kind, baseUrl, path, err) {
  const key = `${kind}:${baseUrl}:${path}:${err?.response?.status || err?.code || err?.message || 'unknown'}`;
  if (loggedBybitErrors.has(key)) return;
  loggedBybitErrors.add(key);
  if (loggedBybitErrors.size > 20) {
    const first = loggedBybitErrors.values().next().value;
    if (first) loggedBybitErrors.delete(first);
  }

  const status = err?.response?.status;
  const detail = isBybitGeoBlockedError(err)
    ? 'geo-blocked by Bybit region policy'
    : (err?.message || 'unknown error');
  logger.warn(`[Bybit] ${kind} failed on ${baseUrl}${path}${status ? ` (${status})` : ''}: ${detail}`);
}

function createBybitRegionBlockedError(path, baseUrl) {
  const error = new Error('BYBIT_REGION_BLOCKED');
  error.isBybitRegionBlocked = true;
  error.path = path;
  error.baseUrl = baseUrl;
  return error;
}

async function requestBybitAcrossBases(kind, path, params = {}, signer = null) {
  const errors = [];

  for (const baseUrl of BASE_URLS) {
    try {
      const response = await http.get(`${baseUrl}${path}`, {
        params,
        headers: signer ? signer() : undefined,
        timeout: 15_000,
      });
      const data = response.data;
      if (data.retCode !== 0) {
        throw new Error(`Bybit API error ${data.retCode}: ${data.retMsg}`);
      }
      return data.result;
    } catch (err) {
      errors.push(err);
      if (isTransientBybitUrlError(err)) {
        if (isBybitGeoBlockedError(err)) {
          markPublicBybitBlocked(err, path);
          throw createBybitRegionBlockedError(path, baseUrl);
        }
        logBybitOnce(kind, baseUrl, path, err);
        continue;
      }
      throw err;
    }
  }

  const lastErr = errors[errors.length - 1];
  if (lastErr) throw lastErr;
  throw new Error(`Bybit request failed for ${path}`);
}

// ─── Request helpers ─────────────────────────────────────────────────────────

/**
 * Public GET request to Bybit API.
 */
async function bybitGet(path, params = {}) {
  try {
    return await requestBybitAcrossBases('Public API', path, params);
  } catch (err) {
    if (err?.isBybitRegionBlocked) {
      return null;
    }
    if (isBybitGeoBlockedError(err)) {
      throw err;
    }
    if (err.response) {
      logger.error(`❌ Bybit API Error (${path}): ${err.response.status} ${JSON.stringify(err.response.data)}`);
    } else {
      logger.error(`❌ Bybit Network Error (${path}): ${err.message}`);
    }
    throw err;
  }
}

/**
 * Private signed GET request to Bybit API.
 * Bybit v5 auth: headers X-BAPI-API-KEY, X-BAPI-SIGN, X-BAPI-TIMESTAMP, X-BAPI-RECV-WINDOW
 */
async function bybitGetSigned(path, params = {}) {
  if (!API_KEY || !API_SECRET) {
    logger.warn(`[Bybit] Private endpoint ${path} called but BYBIT_API_KEY/SECRET not set. Returning null.`);
    return null;
  }
  if (publicBybitBlocked) {
    return null;
  }

  const timestamp = Date.now().toString();
  const recvWindow = '20000';
  const queryString = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const preSign = `${timestamp}${API_KEY}${recvWindow}${queryString}`;
  const sign = crypto.createHmac('sha256', API_SECRET).update(preSign).digest('hex');

  try {
    return await requestBybitAcrossBases('Private API', path, params, () => ({
      'X-BAPI-API-KEY': API_KEY,
      'X-BAPI-SIGN': sign,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': recvWindow,
    }));
  } catch (err) {
    if (err?.isBybitRegionBlocked) {
      return null;
    }
    if (isBybitGeoBlockedError(err)) {
      publicBybitBlocked = true;
      return null;
    }
    if (err.response) {
      logger.error(`❌ Bybit Private API Error (${path}): ${err.response.status} ${JSON.stringify(err.response.data)}`);
    } else {
      logger.error(`❌ Bybit Private Network Error (${path}): ${err.message}`);
    }
    throw err;
  }
}

// ─── Public Endpoints ────────────────────────────────────────────────────────

/**
 * Fetch OHLCV candlestick data.
 * Bybit returns newest-first → reversed to oldest-first (matching Binance behavior).
 */
async function fetchOHLCV(symbol, interval, limit = 100, options = {}) {
  if (!shouldUseBybitPrimary()) {
    return futuresRouter.fetchOHLCV(symbol, interval, limit, options);
  }
  try {
    return await fetchBybitPublicOHLCV(symbol, interval, limit, options);
  } catch (err) {
    logger.warn(`⚠️ Bybit primary fetchOHLCV failed for ${symbol}: ${err.message}. Falling back to alt providers.`);
    return futuresRouter.fetchOHLCV(symbol, interval, limit, options);
  }
}

/**
 * Fetch OHLCV for all configured timeframes.
 */
async function fetchMultiTimeframe(symbol) {
  const result = {};
  for (const [tfName, tfCode] of Object.entries(config.timeframes)) {
    const candles = await fetchOHLCV(symbol, tfCode);
    if (!candles.length) return null;
    result[tfName] = candles;
    await sleep(config.binance?.rateLimitMs || 200);
  }
  return result;
}

/**
 * Fetch top USDT perpetual pairs sorted by 24h turnover.
 */
async function fetchTopPairs(limit = config.scanner.maxPairs) {
  if (!shouldUseBybitPrimary()) {
    return futuresRouter.fetchTopPairs(limit);
  }
  try {
    return await fetchBybitPublicTopPairs(limit);
  } catch (err) {
    logger.warn(`⚠️ Bybit primary fetchTopPairs failed: ${err.message}. Falling back to alt providers.`);
    return futuresRouter.fetchTopPairs(limit);
  }
}

/**
 * Fetch 24h ticker stats for a single symbol.
 */
async function fetch24hTicker(symbol) {
  if (!shouldUseBybitPrimary()) {
    return futuresRouter.fetch24hTicker(symbol);
  }
  try {
    return await fetchBybitPublicTicker(symbol);
  } catch (err) {
    logger.warn(`⚠️ Bybit primary fetch24hTicker failed for ${symbol}: ${err.message}. Falling back to alt providers.`);
    return futuresRouter.fetch24hTicker(symbol);
  }
}

/**
 * Fetch current funding rate for a linear perpetual symbol.
 */
async function fetchFundingRate(symbol) {
  if (!shouldUseBybitPrimary()) {
    return futuresRouter.fetchFundingRate(symbol);
  }
  try {
    const ticker = await fetchBybitPublicTicker(symbol);
    if (ticker && Number.isFinite(ticker.fundingRate)) return ticker.fundingRate;
  } catch (err) {
    logger.warn(`⚠️ Bybit primary fetchFundingRate failed for ${symbol}: ${err.message}. Falling back to alt providers.`);
  }
  return futuresRouter.fetchFundingRate(symbol);
}

/**
 * Fetch current Open Interest.
 */
async function fetchOpenInterest(symbol) {
  if (!shouldUseBybitPrimary()) {
    return futuresRouter.fetchOpenInterest(symbol);
  }
  try {
    const result = await bybitGet('/v5/market/open-interest', {
      category: 'linear',
      symbol: toFuturesSymbol(symbol),
    });
    const item = Array.isArray(result?.list) ? result.list[0] : result?.list?.[0] || result;
    if (!item) return null;
    return {
      symbol: item.symbol || toFuturesSymbol(symbol),
      openInterest: parseFloat(item.openInterest || item.oi || item.value || 0),
    };
  } catch (err) {
    logger.warn(`⚠️ Bybit primary fetchOpenInterest failed for ${symbol}: ${err.message}. Falling back to alt providers.`);
    return futuresRouter.fetchOpenInterest(symbol);
  }
}

/**
 * Fetch historical Open Interest (oldest-first).
 */
async function fetchOpenInterestHistory(symbol, period = '1h', limit = 12) {
  if (!shouldUseBybitPrimary()) {
    return futuresRouter.fetchOpenInterestHistory(symbol, period, limit);
  }
  try {
    const result = await bybitGet('/v5/market/open-interest', {
      category: 'linear',
      symbol: toFuturesSymbol(symbol),
      intervalTime: period,
      limit,
    });
    const rows = Array.isArray(result?.list) ? result.list : [];
    if (rows.length) {
      return rows
        .map((item) => ({
          timestamp: parseInt(item.timestamp || item.ts || item.time || 0, 10),
          sumOpenInterest: parseFloat(item.openInterest || item.oi || item.value || 0),
          sumOpenInterestValue: parseFloat(item.openInterestValue || item.value || 0),
        }))
        .filter((row) => row.timestamp > 0);
    }
  } catch (err) {
    logger.warn(`⚠️ Bybit primary fetchOpenInterestHistory failed for ${symbol}: ${err.message}. Falling back to alt providers.`);
  }
  return futuresRouter.fetchOpenInterestHistory(symbol, period, limit);
}

/**
 * Fetch Long/Short account ratio (global).
 * Note: Bybit does not have a separate "top trader" endpoint.
 *       fetchTopTraderLongShortRatio is aliased to this function.
 */
async function fetchGlobalLongShortRatio(symbol, period = '1h', limit = 6) {
  return futuresRouter.fetchGlobalLongShortRatio(symbol, period, limit);
}

/**
 * Bybit has no separate "top trader" L/S ratio.
 * Falls back to global account ratio (same quality signal).
 */
async function fetchTopTraderLongShortRatio(symbol, period = '1h', limit = 6) {
  return futuresRouter.fetchTopTraderLongShortRatio(symbol, period, limit);
}

/**
 * Fetch L2 order book and compute bid/ask imbalance.
 */
async function fetchOrderBookDepth(symbol, limit = 20) {
  return futuresRouter.fetchOrderBookDepth(symbol, limit);
}

/**
 * Fetch recent liquidation orders.
 */
async function fetchLiquidationOrders(symbol, limit = 50) {
  return futuresRouter.fetchLiquidationOrders(symbol, limit);
}

/**
 * Fetch exchange/instrument specs (LOT_SIZE, precision) for all linear symbols.
 */
async function fetchExchangeSpecs() {
  if (!shouldUseBybitPrimary()) {
    return futuresRouter.fetchExchangeSpecs();
  }
  try {
    return await fetchBybitPublicExchangeSpecs();
  } catch (err) {
    logger.warn(`⚠️ Bybit primary fetchExchangeSpecs failed: ${err.message}. Falling back to alt providers.`);
    return futuresRouter.fetchExchangeSpecs();
  }
}

/**
 * Fetch active spot symbols.
 */
async function fetchSpotExchangeSymbols() {
  return futuresRouter.fetchSpotExchangeSymbols();
}

// ─── Private Endpoints ───────────────────────────────────────────────────────

/**
 * Fetch USDT balance from Bybit Unified account.
 * Returns 0 if no API key configured — scanner will use ACCOUNT_BALANCE env var.
 */
async function fetchFuturesBalance() {
  if (!API_KEY || !API_SECRET) {
    logger.warn('⚠️ No Bybit API key — using ACCOUNT_BALANCE env var for position sizing.');
    return 0;
  }
  if (publicBybitBlocked) {
    logger.warn('⚠️ Bybit region blocked — using ACCOUNT_BALANCE env var for position sizing.');
    return 0;
  }
  try {
    const result = await bybitGetSigned('/v5/account/wallet-balance', { accountType: 'UNIFIED' });
    const usdtCoin = result?.list?.[0]?.coin?.find(c => c.coin === 'USDT');
    return usdtCoin ? parseFloat(usdtCoin.walletBalance) : 0;
  } catch (err) {
    if (isBybitGeoBlockedError(err)) {
      publicBybitBlocked = true;
      logger.warn('⚠️ Bybit region blocked — using ACCOUNT_BALANCE env var for position sizing.');
      return 0;
    }
    logger.error(`Failed to fetch Bybit balance: ${err.message}`);
    return 0;
  }
}

/**
 * Fetch user trade history from Bybit.
 */
async function fetchUserTrades(symbol, startTime = null, type = 'futures', fromId = null) {
  try {
    const params = { category: 'linear', limit: 100 };
    if (symbol) params.symbol = toFuturesSymbol(symbol).toUpperCase();
    if (startTime) params.startTime = startTime;
    if (fromId) params.cursor = fromId;

    const result = await bybitGetSigned('/v5/execution/list', params);
    if (!result?.list) return [];

    return result.list.map(t => ({
      symbol:          t.symbol,
      id:              t.execId,
      orderId:         t.orderId,
      price:           parseFloat(t.execPrice),
      qty:             parseFloat(t.execQty),
      quoteQty:        parseFloat(t.execValue),
      commission:      parseFloat(t.execFee),
      commissionAsset: t.feeCurrency || 'USDT',
      time:            parseInt(t.execTime),
      isBuyer:         t.side === 'Buy',
      isMaker:         t.isMaker,
      realizedPnl:     parseFloat(t.closedPnl || 0),
    }));
  } catch (err) {
    logger.error(`Failed to fetch Bybit trades for ${symbol}: ${err.message}`);
    return [];
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────
module.exports = {
  primePublicProviderChain: futuresRouter.primePublicProviderChain,
  getProviderHealth: futuresRouter.getProviderHealth,
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
