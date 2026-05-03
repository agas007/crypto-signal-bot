/**
 * Bybit API v5 Data Module
 * Drop-in replacement for binance.js — exports identical function signatures.
 *
 * Env vars (all optional for public endpoints):
 *   BYBIT_BASE_URL   - default: https://api.bybit.com
 *   BYBIT_API_KEY    - required only for private endpoints (balance, trades)
 *   BYBIT_API_SECRET - required only for private endpoints
 */

const axios = require('axios');
const crypto = require('crypto');
const config = require('../../config');
const logger = require('../../utils/logger');
const sleep = require('../../utils/sleep');
const binanceData = require('./binance');

const BASE_URL = process.env.BYBIT_BASE_URL || 'https://api.bybit.com';
const API_KEY = process.env.BYBIT_API_KEY || config.bybit?.apiKey;
const API_SECRET = process.env.BYBIT_API_SECRET || config.bybit?.apiSecret;
const DISABLE_PUBLIC_BYBIT = process.env.BYBIT_DISABLE_PUBLIC === '1';

let publicBybitBlocked = DISABLE_PUBLIC_BYBIT;
let publicBybitBlockLogged = false;

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
      `🛑 Bybit public endpoints blocked (${status}) on ${path}. Falling back to Binance market data for public requests.`
    );
  }
}

function shouldUseBinanceFallback() {
  return publicBybitBlocked;
}

async function withPublicFallback(path, fetchBybit, fetchBinance) {
  if (shouldUseBinanceFallback()) {
    return fetchBinance();
  }

  try {
    return await fetchBybit();
  } catch (err) {
    if (isBybitGeoBlockedError(err)) {
      markPublicBybitBlocked(err, path);
      return fetchBinance();
    }
    throw err;
  }
}

// ─── Request helpers ─────────────────────────────────────────────────────────

/**
 * Public GET request to Bybit API.
 */
async function bybitGet(path, params = {}) {
  try {
    const response = await axios.get(`${BASE_URL}${path}`, {
      params,
      timeout: 15_000,
    });
    const data = response.data;
    if (data.retCode !== 0) {
      throw new Error(`Bybit API error ${data.retCode}: ${data.retMsg}`);
    }
    return data.result;
  } catch (err) {
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

  const timestamp = Date.now().toString();
  const recvWindow = '20000';
  const queryString = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const preSign = `${timestamp}${API_KEY}${recvWindow}${queryString}`;
  const sign = crypto.createHmac('sha256', API_SECRET).update(preSign).digest('hex');

  try {
    const response = await axios.get(`${BASE_URL}${path}`, {
      params,
      headers: {
        'X-BAPI-API-KEY': API_KEY,
        'X-BAPI-SIGN': sign,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow,
      },
      timeout: 15_000,
    });
    const data = response.data;
    if (data.retCode !== 0) {
      throw new Error(`Bybit API error ${data.retCode}: ${data.retMsg}`);
    }
    return data.result;
  } catch (err) {
    if (isBybitGeoBlockedError(err)) {
      throw err;
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
  return withPublicFallback('/v5/market/kline', async () => {
    const futuresSymbol = toFuturesSymbol(symbol);
    const bybitInterval = toBybitInterval(interval);
    const params = { category: 'linear', symbol: futuresSymbol, interval: bybitInterval, limit };
    if (options.startTime) params.start = options.startTime;
    if (options.endTime)   params.end   = options.endTime;

    // Try linear (futures) first
    try {
      const result = await bybitGet('/v5/market/kline', params);
      if (result?.list?.length) {
        return result.list.reverse().map(c => ({
          openTime:    parseInt(c[0]),
          open:        parseFloat(c[1]),
          high:        parseFloat(c[2]),
          low:         parseFloat(c[3]),
          close:       parseFloat(c[4]),
          volume:      parseFloat(c[5]),
          closeTime:   parseInt(c[0]) + 60000,
          quoteVolume: parseFloat(c[6] || 0),
        }));
      }
    } catch (futuresErr) {
      if (!futuresErr.message?.includes('-1121') && !futuresErr.message?.includes('not supported')) {
        throw futuresErr;
      }
      logger.info(`ℹ️ ${symbol} not on Bybit linear, trying spot...`);
    }

    // Fallback to spot
    const spotResult = await bybitGet('/v5/market/kline', {
      category: 'spot', symbol: symbol.toUpperCase(), interval: bybitInterval, limit,
    });
    if (!spotResult?.list?.length) return [];
    return spotResult.list.reverse().map(c => ({
      openTime: parseInt(c[0]), open: parseFloat(c[1]), high: parseFloat(c[2]),
      low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5]),
      closeTime: parseInt(c[0]) + 60000, quoteVolume: parseFloat(c[6] || 0),
    }));
  }, () => binanceData.fetchOHLCV(symbol, interval, limit, options));
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
  return withPublicFallback('/v5/market/tickers', async () => {
    const result = await bybitGet('/v5/market/tickers', { category: 'linear' });
    if (!result?.list) return [];

    return result.list
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('UP') && !t.symbol.includes('DOWN'))
      .sort((a, b) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h))
      .slice(0, limit)
      .map(t => t.symbol);
  }, () => binanceData.fetchTopPairs(limit));
}

/**
 * Fetch 24h ticker stats for a single symbol.
 */
async function fetch24hTicker(symbol) {
  return withPublicFallback('/v5/market/tickers', async () => {
    const futuresSymbol = toFuturesSymbol(symbol);
    const result = await bybitGet('/v5/market/tickers', { category: 'linear', symbol: futuresSymbol });
    const t = result?.list?.[0];
    if (!t) return null;
    return {
      symbol:             t.symbol,
      priceChangePercent: parseFloat(t.price24hPcnt) * 100,
      volume:             parseFloat(t.volume24h),
      quoteVolume:        parseFloat(t.turnover24h),
      lastPrice:          parseFloat(t.lastPrice),
    };
  }, () => binanceData.fetch24hTicker(symbol));
}

/**
 * Fetch current funding rate for a linear perpetual symbol.
 */
async function fetchFundingRate(symbol) {
  return withPublicFallback('/v5/market/tickers', async () => {
    const futuresSymbol = toFuturesSymbol(symbol);
    const result = await bybitGet('/v5/market/tickers', { category: 'linear', symbol: futuresSymbol });
    const t = result?.list?.[0];
    return t ? parseFloat(t.fundingRate) : 0;
  }, () => binanceData.fetchFundingRate(symbol));
}

/**
 * Fetch current Open Interest.
 */
async function fetchOpenInterest(symbol) {
  return withPublicFallback('/v5/market/open-interest', async () => {
    const futuresSymbol = toFuturesSymbol(symbol);
    const result = await bybitGet('/v5/market/open-interest', {
      category: 'linear', symbol: futuresSymbol, intervalTime: '1h', limit: 1,
    });
    const item = result?.list?.[0];
    if (!item) return null;
    return { symbol: futuresSymbol, openInterest: parseFloat(item.openInterest) };
  }, () => binanceData.fetchOpenInterest(symbol));
}

/**
 * Fetch historical Open Interest (oldest-first).
 */
async function fetchOpenInterestHistory(symbol, period = '1h', limit = 12) {
  return withPublicFallback('/v5/market/open-interest', async () => {
    const futuresSymbol = toFuturesSymbol(symbol);
    const result = await bybitGet('/v5/market/open-interest', {
      category: 'linear', symbol: futuresSymbol, intervalTime: period, limit,
    });
    if (!result?.list) return [];
    return result.list.reverse().map(d => ({
      timestamp:           parseInt(d.timestamp),
      sumOpenInterest:     parseFloat(d.openInterest),
      sumOpenInterestValue: parseFloat(d.openInterestValue || 0),
    }));
  }, () => binanceData.fetchOpenInterestHistory(symbol, period, limit));
}

/**
 * Fetch Long/Short account ratio (global).
 * Note: Bybit does not have a separate "top trader" endpoint.
 *       fetchTopTraderLongShortRatio is aliased to this function.
 */
async function fetchGlobalLongShortRatio(symbol, period = '1h', limit = 6) {
  return withPublicFallback('/v5/market/account-ratio', async () => {
    const futuresSymbol = toFuturesSymbol(symbol);
    // Bybit period format: 5min, 15min, 30min, 1h, 4h, 1d
    const bybitPeriod = period.replace('m', 'min');
    const result = await bybitGet('/v5/market/account-ratio', {
      category: 'linear', symbol: futuresSymbol, period: bybitPeriod, limit,
    });
    if (!result?.list) return [];
    return result.list.reverse().map(d => ({
      timestamp:      parseInt(d.timestamp),
      longShortRatio: parseFloat(d.buyRatio) / (parseFloat(d.sellRatio) || 1),
      longAccount:    parseFloat(d.buyRatio),
      shortAccount:   parseFloat(d.sellRatio),
    }));
  }, () => binanceData.fetchGlobalLongShortRatio(symbol, period, limit));
}

/**
 * Bybit has no separate "top trader" L/S ratio.
 * Falls back to global account ratio (same quality signal).
 */
async function fetchTopTraderLongShortRatio(symbol, period = '1h', limit = 6) {
  return fetchGlobalLongShortRatio(symbol, period, limit);
}

/**
 * Fetch L2 order book and compute bid/ask imbalance.
 */
async function fetchOrderBookDepth(symbol, limit = 20) {
  return withPublicFallback('/v5/market/orderbook', async () => {
    const futuresSymbol = toFuturesSymbol(symbol);
    const result = await bybitGet('/v5/market/orderbook', {
      category: 'linear', symbol: futuresSymbol, limit,
    });
    if (!result?.b || !result?.a) return null;

    const bidVolume = result.b.reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
    const askVolume = result.a.reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
    const total = bidVolume + askVolume;
    const imbalance = total > 0 ? (bidVolume - askVolume) / total : 0;
    const bias = imbalance > 0.1 ? 'BUY' : imbalance < -0.1 ? 'SELL' : 'NEUTRAL';
    return { bidVolume, askVolume, imbalance, bias };
  }, () => binanceData.fetchOrderBookDepth(symbol, limit));
}

/**
 * Fetch recent liquidation orders.
 */
async function fetchLiquidationOrders(symbol, limit = 50) {
  return withPublicFallback('/v5/market/liquidation', async () => {
    const futuresSymbol = toFuturesSymbol(symbol);
    const result = await bybitGet('/v5/market/liquidation', {
      category: 'linear', symbol: futuresSymbol, limit,
    });
    if (!result?.list) return [];
    return result.list.map(o => ({
      side:        o.side,              // 'Buy' or 'Sell'
      price:       parseFloat(o.price),
      origQty:     parseFloat(o.qty),
      executedQty: parseFloat(o.qty),
      avgPrice:    parseFloat(o.price),
      time:        parseInt(o.updatedTime),
    }));
  }, () => binanceData.fetchLiquidationOrders(symbol, limit));
}

/**
 * Fetch exchange/instrument specs (LOT_SIZE, precision) for all linear symbols.
 */
async function fetchExchangeSpecs() {
  return withPublicFallback('/v5/market/instruments-info', async () => {
    const result = await bybitGet('/v5/market/instruments-info', { category: 'linear' });
    const specs = {};
    if (result?.list) {
      result.list.forEach(s => {
        const lot = s.lotSizeFilter;
        specs[s.symbol] = {
          symbol:      s.symbol,
          stepSize:    parseFloat(lot?.qtyStep || lot?.basePrecision || 0.001),
          precision:   s.priceScale ? parseInt(s.priceScale) : 3,
          minNotional: parseFloat(lot?.minOrderAmt || lot?.minNotionalValue || 5.0),
        };
      });
    }
    return specs;
  }, () => binanceData.fetchExchangeSpecs());
}

/**
 * Fetch active spot symbols.
 */
async function fetchSpotExchangeSymbols() {
  return withPublicFallback('/v5/market/instruments-info', async () => {
    const result = await bybitGet('/v5/market/instruments-info', { category: 'spot' });
    if (!result?.list) return [];
    return result.list
      .filter(s => s.status === 'Trading')
      .map(s => s.symbol);
  }, () => binanceData.fetchSpotExchangeSymbols());
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
  try {
    const result = await bybitGetSigned('/v5/account/wallet-balance', { accountType: 'UNIFIED' });
    const usdtCoin = result?.list?.[0]?.coin?.find(c => c.coin === 'USDT');
    return usdtCoin ? parseFloat(usdtCoin.walletBalance) : 0;
  } catch (err) {
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
