const axios = require('axios');
const config = require('../../config');
const logger = require('../../utils/logger');
const binanceData = require('./binance');

const DEFAULT_PROVIDER_ORDER = ['bitget', 'okx', 'kucoin', 'binance'];
const DEFAULT_TIMEOUT = 15_000;

function parseProviderOrder() {
  const raw = process.env.FUTURES_DATA_PROVIDER_ORDER || config.futuresData?.providerOrder || DEFAULT_PROVIDER_ORDER.join(',');
  return raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function toFloat(value, fallback = 0) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function unwrapData(payload) {
  if (!payload) return null;
  if (Array.isArray(payload)) return payload;
  if (payload.data !== undefined) return payload.data;
  if (payload.result !== undefined) return payload.result;
  if (payload.list !== undefined) return payload.list;
  return payload;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.list)) return value.list;
  if (Array.isArray(value?.openInterestList)) return value.openInterestList;
  if (Array.isArray(value?.ticker)) return value.ticker;
  if (Array.isArray(value?.rows)) return value.rows;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.resultList)) return value.resultList;
  return [];
}

function httpBaseUrl(provider) {
  switch (provider) {
    case 'bitget':
      return process.env.BITGET_BASE_URL || config.futuresData?.bitgetBaseUrl || 'https://api.bitget.com';
    case 'okx':
      return process.env.OKX_BASE_URL || config.futuresData?.okxBaseUrl || 'https://www.okx.com';
    case 'kucoin':
      return process.env.KUCOIN_BASE_URL || config.futuresData?.kucoinBaseUrl || 'https://api-futures.kucoin.com';
    default:
      return null;
  }
}

function mapIntervalForProvider(provider, interval) {
  const value = String(interval || '').trim();
  if (!value) return value;

  const bitgetMap = {
    '1m': '1m',
    '3m': '3m',
    '5m': '5m',
    '15m': '15m',
    '30m': '30m',
    '1h': '1H',
    '2h': '2H',
    '4h': '4H',
    '6h': '6H',
    '12h': '12H',
    '1d': '1D',
    '3d': '3D',
    '1w': '1W',
    '1M': '1M',
  };

  const okxMap = {
    '1m': '1m',
    '3m': '3m',
    '5m': '5m',
    '15m': '15m',
    '30m': '30m',
    '1h': '1H',
    '2h': '2H',
    '4h': '4H',
    '6h': '6H',
    '12h': '12H',
    '1d': '1D',
    '1w': '1W',
    '1M': '1M',
  };

  const kucoinMap = {
    '1m': '1min',
    '3m': '3min',
    '5m': '5min',
    '15m': '15min',
    '30m': '30min',
    '1h': '1hour',
    '2h': '2hour',
    '4h': '4hour',
    '6h': '6hour',
    '12h': '12hour',
    '1d': '1day',
    '1w': '1week',
    '1M': '1month',
  };

  if (provider === 'bitget') return bitgetMap[value] || value;
  if (provider === 'okx') return okxMap[value] || value;
  if (provider === 'kucoin') return kucoinMap[value] || value;
  return value;
}

function mapFuturesSymbol(provider, symbol) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return sym;

  const lowPriceMap = {
    PEPEUSDT: '1000PEPEUSDT',
    SHIBUSDT: '1000SHIBUSDT',
    FLOKIUSDT: '1000FLOKIUSDT',
    BONKUSDT: '1000BONKUSDT',
    LUNCUSDT: '1000LUNCUSDT',
    XECUSDT: '1000XECUSDT',
    SATSUSDT: '1000SATSUSDT',
    RATSUSDT: '1000RATSUSDT',
  };

  if (provider === 'okx') {
    const base = sym.endsWith('USDT') ? sym.slice(0, -4) : sym;
    return `${base}-USDT-SWAP`;
  }

  if (provider === 'kucoin') {
    const base = lowPriceMap[sym] || sym.replace(/USDT$/, '');
    const kucoinBase = base === 'BTC' ? 'XBT' : base;
    return `${kucoinBase}USDTM`;
  }

  return lowPriceMap[sym] || sym;
}

function normalizeCandleRows(rows, provider) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      if (!Array.isArray(row)) return null;

      if (provider === 'kucoin') {
        return {
          openTime: Number(row[0]) * 1000,
          open: toFloat(row[1]),
          high: toFloat(row[3]),
          low: toFloat(row[4]),
          close: toFloat(row[2]),
          volume: toFloat(row[5]),
          closeTime: Number(row[0]) * 1000 + 60_000,
          quoteVolume: toFloat(row[6]),
        };
      }

      return {
        openTime: Number(row[0]),
        open: toFloat(row[1]),
        high: toFloat(row[2]),
        low: toFloat(row[3]),
        close: toFloat(row[4]),
        volume: toFloat(row[5]),
        closeTime: Number(row[0]) + 60_000,
        quoteVolume: toFloat(row[6]),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.openTime - b.openTime);
}

function normalizeOrderBook(provider, payload) {
  const data = unwrapData(payload);
  if (!data) return null;

  const source = Array.isArray(data) ? data[0] : data;
  const bids = source?.b || source?.bids || [];
  const asks = source?.a || source?.asks || [];
  if (!Array.isArray(bids) || !Array.isArray(asks)) return null;

  const bidVolume = bids.reduce((sum, [, qty]) => sum + toFloat(qty), 0);
  const askVolume = asks.reduce((sum, [, qty]) => sum + toFloat(qty), 0);
  const total = bidVolume + askVolume;
  const imbalance = total > 0 ? (bidVolume - askVolume) / total : 0;
  const bias = imbalance > 0.1 ? 'BUY' : imbalance < -0.1 ? 'SELL' : 'NEUTRAL';

  return { bidVolume, askVolume, imbalance, bias, provider };
}

function normalizeLongShortRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      timestamp: Number(row.timestamp || row.ts || row.time || 0),
      longShortRatio: toFloat(row.longShortRatio ?? row.longRatio ?? row.longShortAccountRatio ?? row.longShortPositionRatio, null),
      longAccount: toFloat(row.longAccount ?? row.longAccountRatio ?? row.longPositionRatio ?? row.longRatio, null),
      shortAccount: toFloat(row.shortAccount ?? row.shortAccountRatio ?? row.shortPositionRatio ?? row.shortRatio, null),
    }))
    .filter((row) => Number.isFinite(row.timestamp));
}

function isNonEmpty(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return !!value;
}

function createProviderState() {
  return {
    preferredByMethod: new Map(),
    blockedProviders: new Set(),
    probeCache: new Map(),
    recentEvents: [],
  };
}

const state = createProviderState();

async function httpGet(provider, path, params = {}) {
  const baseUrl = httpBaseUrl(provider);
  if (!baseUrl) throw new Error(`Provider ${provider} has no base URL`);

  const response = await axios.get(`${baseUrl}${path}`, {
    params,
    timeout: DEFAULT_TIMEOUT,
  });

  const body = response.data;
  if (provider === 'okx') {
    if (body?.code && body.code !== '0') {
      throw new Error(`OKX API error ${body.code}: ${body.msg || body.message || 'unknown error'}`);
    }
    return body;
  }

  if (provider === 'kucoin') {
    if (body?.code && body.code !== '200000') {
      throw new Error(`KuCoin API error ${body.code}: ${body.msg || 'unknown error'}`);
    }
    return body;
  }

  if (provider === 'bitget') {
    if (body?.code && body.code !== '00000') {
      throw new Error(`Bitget API error ${body.code}: ${body.msg || 'unknown error'}`);
    }
    return body;
  }

  return body;
}

function providerListForMethod(method) {
  const order = parseProviderOrder();
  const preferred = state.preferredByMethod.get(method);
  return unique([preferred, ...order, 'binance']);
}

function markProviderBlocked(provider, method, err) {
  if (provider === 'binance') return;
  const status = err?.response?.status;
  const body = JSON.stringify(err?.response?.data || {});
  const message = `${err?.message || ''} ${body}`.toLowerCase();
  const isBlocked = status === 403 || status === 451 || message.includes('block access from your country');

  if (isBlocked) {
    state.blockedProviders.add(provider);
    logger.warn(`🛑 ${provider.toUpperCase()} blocked for ${method}. Falling through to next provider.`);
  }

  state.recentEvents.push({
    ts: Date.now(),
    provider,
    method,
    status: isBlocked ? 'blocked' : 'error',
    message: err?.message || 'Unknown error',
  });
  if (state.recentEvents.length > 30) state.recentEvents = state.recentEvents.slice(-30);
}

function maybeRememberPreferred(method, provider, value) {
  if (!isNonEmpty(value)) return;
  state.preferredByMethod.set(method, provider);
}

function recordSuccess(method, provider) {
  state.recentEvents.push({
    ts: Date.now(),
    provider,
    method,
    status: 'ok',
    message: 'Provider returned data',
  });
  if (state.recentEvents.length > 30) state.recentEvents = state.recentEvents.slice(-30);
}

async function callProviderChain(method, invoker, options = {}) {
  const providers = providerListForMethod(method).filter((provider) => !state.blockedProviders.has(provider));
  const errors = [];

  for (const provider of providers) {
    try {
      const result = await invoker(provider);
      if (isNonEmpty(result)) {
        maybeRememberPreferred(method, provider, result);
        recordSuccess(method, provider);
        return result;
      }
    } catch (err) {
      errors.push({ provider, err });
      markProviderBlocked(provider, method, err);
      if (options.stopOnFatal && options.stopOnFatal(err, provider)) {
        throw err;
      }
    }
  }

  if (options.silentEmpty) {
    if (Array.isArray(options.emptyFallback)) return options.emptyFallback;
    if (options.objectFallback) return options.objectFallback;
    return null;
  }

  const detail = errors.length
    ? errors.map(({ provider, err }) => `${provider}: ${err.message}`).join(' | ')
    : 'no provider returned data';
  logger.warn(`⚠️ Futures data chain exhausted for ${method}: ${detail}`);

  if (Array.isArray(options.emptyFallback)) return options.emptyFallback;
  if (options.objectFallback) return options.objectFallback;
  return null;
}

function normalizeTopPairsRows(rows, limit) {
  const filtered = Array.isArray(rows) ? rows : [];
  return filtered
    .filter((item) => item && item.symbol && String(item.symbol).includes('USDT'))
    .sort((a, b) => {
      const aVol = toFloat(a.quoteVolume ?? a.turnover24h ?? a.volCcy24h ?? a.volValue ?? a.vol, 0);
      const bVol = toFloat(b.quoteVolume ?? b.turnover24h ?? b.volCcy24h ?? b.volValue ?? b.vol, 0);
      return bVol - aVol;
    })
    .slice(0, limit)
    .map((item) => item.symbol);
}

async function bitgetRequest(path, params = {}) {
  return httpGet('bitget', path, params);
}

async function okxRequest(path, params = {}) {
  return httpGet('okx', path, params);
}

async function kucoinRequest(path, params = {}) {
  return httpGet('kucoin', path, params);
}

const providers = {
  bitget: {
    async probe() {
      const payload = await bitgetRequest('/api/v3/market/ticker', {
        category: 'USDT-FUTURES',
        symbol: 'BTCUSDT',
      });
      return unwrapData(payload);
    },
    async fetchOHLCV(symbol, interval, limit = 100, options = {}) {
      const payload = await bitgetRequest('/api/v3/market/candles', {
        category: 'USDT-FUTURES',
        symbol: mapFuturesSymbol('bitget', symbol),
        interval: mapIntervalForProvider('bitget', interval),
        type: 'MARKET',
        limit,
        ...(options.startTime ? { startTime: options.startTime } : {}),
        ...(options.endTime ? { endTime: options.endTime } : {}),
      });
      return normalizeCandleRows(asArray(unwrapData(payload)), 'bitget');
    },
    async fetchTopPairs(limit = config.scanner.maxPairs) {
      const payload = await bitgetRequest('/api/v3/market/tickers', {
        category: 'USDT-FUTURES',
      });
      return normalizeTopPairsRows(asArray(unwrapData(payload)), limit);
    },
    async fetch24hTicker(symbol) {
      const payload = await bitgetRequest('/api/v3/market/ticker', {
        category: 'USDT-FUTURES',
        symbol: mapFuturesSymbol('bitget', symbol),
      });
      const data = unwrapData(payload);
      const item = Array.isArray(data) ? data[0] : data;
      if (!item) return null;
      return {
        symbol: item.symbol || mapFuturesSymbol('bitget', symbol),
        priceChangePercent: toFloat(item.priceChangePercent ?? item.change24h ?? item.changeRate, 0),
        volume: toFloat(item.volume ?? item.baseVolume ?? item.vol, 0),
        quoteVolume: toFloat(item.quoteVolume ?? item.turnover24h ?? item.volCcy24h ?? item.volValue, 0),
        lastPrice: toFloat(item.lastPr ?? item.lastPrice ?? item.price, 0),
      };
    },
    async fetchFundingRate(symbol) {
      const payload = await bitgetRequest('/api/v3/market/current-fund-rate', {
        symbol: mapFuturesSymbol('bitget', symbol),
      });
      const data = unwrapData(payload);
      const item = Array.isArray(data) ? data[0] : data;
      return item ? toFloat(item.fundingRate ?? item.nextFundingRate, 0) : 0;
    },
    async fetchOpenInterest(symbol) {
      const payload = await bitgetRequest('/api/v3/market/open-interest', {
        category: 'USDT-FUTURES',
        symbol: mapFuturesSymbol('bitget', symbol),
      });
      const data = unwrapData(payload);
      const item = Array.isArray(data) ? data[0] : data?.openInterestList?.[0] || data?.list?.[0] || data;
      if (!item) return null;
      return { symbol: item.symbol || mapFuturesSymbol('bitget', symbol), openInterest: toFloat(item.openInterest ?? item.size, 0) };
    },
    async fetchOpenInterestHistory(symbol, period = '1h', limit = 12) {
      try {
        const payload = await bitgetRequest('/api/v3/market/open-interest', {
          category: 'USDT-FUTURES',
          symbol: mapFuturesSymbol('bitget', symbol),
          interval: mapIntervalForProvider('bitget', period),
          limit,
        });
        const data = unwrapData(payload);
        const rows = asArray(data);
        return rows
          .map((item) => ({
            timestamp: Number(item.timestamp || item.ts || 0),
            sumOpenInterest: toFloat(item.openInterest ?? item.size, 0),
            sumOpenInterestValue: toFloat(item.openInterestValue ?? item.value ?? 0, 0),
          }))
          .filter((row) => row.timestamp > 0);
      } catch (err) {
        return [];
      }
    },
    async fetchGlobalLongShortRatio(symbol, period = '1h', limit = 6) {
      try {
        const payload = await bitgetRequest('/api/v2/mix/market/account-long-short', {
          symbol: mapFuturesSymbol('bitget', symbol),
          period: mapIntervalForProvider('bitget', period),
        });
        const rows = asArray(unwrapData(payload));
        return normalizeLongShortRows(rows).slice(-limit);
      } catch (err) {
        return [];
      }
    },
    async fetchTopTraderLongShortRatio(symbol, period = '1h', limit = 6) {
      try {
        const payload = await bitgetRequest('/api/v2/mix/market/position-long-short', {
          symbol: mapFuturesSymbol('bitget', symbol),
          period: mapIntervalForProvider('bitget', period),
        });
        const rows = asArray(unwrapData(payload));
        return normalizeLongShortRows(rows).slice(-limit);
      } catch (err) {
        return [];
      }
    },
    async fetchOrderBookDepth(symbol, limit = 20) {
      const payload = await bitgetRequest('/api/v3/market/orderbook', {
        category: 'USDT-FUTURES',
        symbol: mapFuturesSymbol('bitget', symbol),
        limit,
      });
      return normalizeOrderBook('bitget', unwrapData(payload));
    },
    async fetchLiquidationOrders() {
      return [];
    },
    async fetchExchangeSpecs() {
      const payload = await bitgetRequest('/api/v3/market/instruments', {
        category: 'USDT-FUTURES',
      });
      const rows = asArray(unwrapData(payload));
      const specs = {};
      for (const row of rows) {
        if (!row?.symbol) continue;
        specs[row.symbol] = {
          symbol: row.symbol,
          stepSize: toFloat(row.qtyStep ?? row.sizeMultiplier ?? row.minTradeNum ?? row.basePrecision ?? row.minTradeSize, 0.001) || 0.001,
          precision: Number.parseInt(row.pricePlace ?? row.pricePrecision ?? row.priceScale ?? row.quotePrecision ?? 3, 10) || 3,
          minNotional: toFloat(row.minTradeUSDT ?? row.minTradeAmt ?? row.minTradeAmount ?? row.minNotional ?? 5.0, 5.0) || 5.0,
        };
      }
      return specs;
    },
    async fetchSpotExchangeSymbols() {
      return binanceData.fetchSpotExchangeSymbols();
    },
  },
  okx: {
    async probe() {
      const payload = await okxRequest('/api/v5/market/ticker', {
        instId: 'BTC-USDT-SWAP',
      });
      return unwrapData(payload);
    },
    async fetchOHLCV(symbol, interval, limit = 100, options = {}) {
      const payload = await okxRequest('/api/v5/market/candles', {
        instId: mapFuturesSymbol('okx', symbol),
        bar: mapIntervalForProvider('okx', interval),
        limit,
        ...(options.startTime ? { before: options.startTime } : {}),
        ...(options.endTime ? { after: options.endTime } : {}),
      });
      return normalizeCandleRows(unwrapData(payload), 'okx');
    },
    async fetchTopPairs(limit = config.scanner.maxPairs) {
      const payload = await okxRequest('/api/v5/market/tickers', {
        instType: 'SWAP',
      });
      const rows = asArray(unwrapData(payload));
      return rows
        .filter((item) => item?.instId?.endsWith('-SWAP'))
        .sort((a, b) => toFloat(b.volCcy24h ?? b.vol24h ?? b.vol, 0) - toFloat(a.volCcy24h ?? a.vol24h ?? a.vol, 0))
        .slice(0, limit)
        .map((item) => item.instId.replace(/-USDT-SWAP$/, 'USDT').replace(/-SWAP$/, 'USDT'));
    },
    async fetch24hTicker(symbol) {
      const payload = await okxRequest('/api/v5/market/ticker', {
        instId: mapFuturesSymbol('okx', symbol),
      });
      const item = unwrapData(payload);
      if (!item) return null;
      return {
        symbol: item.instId || mapFuturesSymbol('okx', symbol),
        priceChangePercent: toFloat(item.changePct ?? item.chgPct ?? item.change24h, 0),
        volume: toFloat(item.vol24h ?? item.volCcy24h ?? item.vol, 0),
        quoteVolume: toFloat(item.volCcy24h ?? item.vol24h ?? item.vol, 0),
        lastPrice: toFloat(item.last ?? item.lastPx ?? item.lastPrice, 0),
      };
    },
    async fetchFundingRate(symbol) {
      const payload = await okxRequest('/api/v5/public/funding-rate', {
        instId: mapFuturesSymbol('okx', symbol),
      });
      const item = unwrapData(payload);
      return item ? toFloat(item.fundingRate ?? item.fundingRateNext ?? item.nextFundingRate, 0) : 0;
    },
    async fetchOpenInterest(symbol) {
      const payload = await okxRequest('/api/v5/public/open-interest', {
        instId: mapFuturesSymbol('okx', symbol),
      });
      const item = unwrapData(payload);
      if (!item) return null;
      return {
        symbol: item.instId || mapFuturesSymbol('okx', symbol),
        openInterest: toFloat(item.oi ?? item.openInterest, 0),
      };
    },
    async fetchOpenInterestHistory() {
      return [];
    },
    async fetchGlobalLongShortRatio() {
      return [];
    },
    async fetchTopTraderLongShortRatio() {
      return [];
    },
    async fetchOrderBookDepth(symbol, limit = 20) {
      const payload = await okxRequest('/api/v5/market/books', {
        instId: mapFuturesSymbol('okx', symbol),
        sz: limit,
      });
      return normalizeOrderBook('okx', unwrapData(payload));
    },
    async fetchLiquidationOrders() {
      return [];
    },
    async fetchExchangeSpecs() {
      const payload = await okxRequest('/api/v5/public/instruments', {
        instType: 'SWAP',
      });
      const rows = asArray(unwrapData(payload));
      const specs = {};
      for (const row of rows) {
        if (!row?.instId || row.state !== 'live') continue;
        specs[row.instId.replace(/-SWAP$/, 'USDT')] = {
          symbol: row.instId.replace(/-SWAP$/, 'USDT'),
          stepSize: toFloat(row.lotSz ?? row.minSz ?? row.ctVal ?? 0.001, 0.001) || 0.001,
          precision: Number.parseInt(row.tickSz ? String(row.tickSz).split('.')[1]?.length || '3' : row.uly ? 3 : 3, 10) || 3,
          minNotional: toFloat(row.minSz ?? 5.0, 5.0) || 5.0,
        };
      }
      return specs;
    },
    async fetchSpotExchangeSymbols() {
      return binanceData.fetchSpotExchangeSymbols();
    },
  },
  kucoin: {
    async probe() {
      const payload = await kucoinRequest('/api/v1/ticker', {
        symbol: 'XBTUSDTM',
      });
      return unwrapData(payload);
    },
    async fetchOHLCV(symbol, interval, limit = 100, options = {}) {
      const payload = await kucoinRequest('/api/ua/v1/market/kline', {
        tradeType: 'FUTURES',
        symbol: mapFuturesSymbol('kucoin', symbol),
        interval: mapIntervalForProvider('kucoin', interval),
        ...(options.startTime ? { startAt: Math.floor(options.startTime / 1000) } : {}),
        ...(options.endTime ? { endAt: Math.floor(options.endTime / 1000) } : {}),
      });
      return normalizeCandleRows(unwrapData(payload), 'kucoin').slice(-limit);
    },
    async fetchTopPairs(limit = config.scanner.maxPairs) {
      const payload = await kucoinRequest('/api/v1/allTickers');
      const rows = asArray(unwrapData(payload));
      return rows
        .filter((item) => item?.symbol && item.symbol.endsWith('M'))
        .sort((a, b) => toFloat(b.volValue ?? b.vol ?? 0, 0) - toFloat(a.volValue ?? a.vol ?? 0, 0))
        .slice(0, limit)
        .map((item) => item.symbol.replace(/^XBT/, 'BTC').replace(/USDTM$/, 'USDT'));
    },
    async fetch24hTicker(symbol) {
      const payload = await kucoinRequest('/api/v1/ticker', {
        symbol: mapFuturesSymbol('kucoin', symbol),
      });
      const item = unwrapData(payload);
      if (!item) return null;
      return {
        symbol: item.symbol || mapFuturesSymbol('kucoin', symbol),
        priceChangePercent: 0,
        volume: toFloat(item.baseVolume ?? item.size ?? 0, 0),
        quoteVolume: toFloat(item.quoteVolume ?? item.volValue ?? item.vol ?? 0, 0),
        lastPrice: toFloat(item.price ?? item.lastPrice, 0),
      };
    },
    async fetchFundingRate(symbol) {
      const payload = await kucoinRequest(`/api/v1/funding-rate/${mapFuturesSymbol('kucoin', symbol)}/current`);
      const item = unwrapData(payload);
      return item ? toFloat(item.value ?? item.nextFundingRate, 0) : 0;
    },
    async fetchOpenInterest(symbol) {
      const payload = await kucoinRequest('/api/ua/v1/market/open-interest', {
        symbol: mapFuturesSymbol('kucoin', symbol),
      });
      const item = unwrapData(payload);
      if (!item) return null;
      const first = asArray(item?.list ? { list: item.list } : item).at(0) || item?.openInterestList?.[0] || item;
      return {
        symbol: first.symbol || mapFuturesSymbol('kucoin', symbol),
        openInterest: toFloat(first.size ?? first.openInterest, 0),
      };
    },
    async fetchOpenInterestHistory(symbol, period = '1h', limit = 12) {
      const payload = await kucoinRequest('/api/ua/v1/market/open-interest', {
        symbol: mapFuturesSymbol('kucoin', symbol),
        interval: mapIntervalForProvider('kucoin', period),
        pageSize: limit,
      });
      const data = unwrapData(payload);
      const rows = asArray(data);
      return rows
        .map((item) => ({
          timestamp: Number(item.ts || item.timestamp || item.timepoint || 0),
          sumOpenInterest: toFloat(item.sumOpenInterest ?? item.size ?? item.openInterest, 0),
          sumOpenInterestValue: toFloat(item.sumOpenInterestValue ?? 0, 0),
        }))
        .filter((row) => row.timestamp > 0);
    },
    async fetchGlobalLongShortRatio() {
      return [];
    },
    async fetchTopTraderLongShortRatio() {
      return [];
    },
    async fetchOrderBookDepth(symbol, limit = 20) {
      const payload = await kucoinRequest('/api/v1/level2/snapshot', {
        symbol: mapFuturesSymbol('kucoin', symbol),
      });
      const item = unwrapData(payload);
      if (!item) return null;
      return normalizeOrderBook('kucoin', item);
    },
    async fetchLiquidationOrders() {
      return [];
    },
    async fetchExchangeSpecs() {
      return binanceData.fetchExchangeSpecs();
    },
    async fetchSpotExchangeSymbols() {
      return binanceData.fetchSpotExchangeSymbols();
    },
  },
  binance: {
    async probe() {
      return binanceData.fetchTopPairs(1);
    },
    async fetchOHLCV(symbol, interval, limit = 100, options = {}) {
      return binanceData.fetchOHLCV(symbol, interval, limit, options);
    },
    async fetchTopPairs(limit = config.scanner.maxPairs) {
      return binanceData.fetchTopPairs(limit);
    },
    async fetch24hTicker(symbol) {
      return binanceData.fetch24hTicker(symbol);
    },
    async fetchFundingRate(symbol) {
      return binanceData.fetchFundingRate(symbol);
    },
    async fetchOpenInterest(symbol) {
      return binanceData.fetchOpenInterest(symbol);
    },
    async fetchOpenInterestHistory(symbol, period = '1h', limit = 12) {
      return binanceData.fetchOpenInterestHistory(symbol, period, limit);
    },
    async fetchGlobalLongShortRatio(symbol, period = '1h', limit = 6) {
      return binanceData.fetchGlobalLongShortRatio(symbol, period, limit);
    },
    async fetchTopTraderLongShortRatio(symbol, period = '1h', limit = 6) {
      return binanceData.fetchTopTraderLongShortRatio(symbol, period, limit);
    },
    async fetchOrderBookDepth(symbol, limit = 20) {
      return binanceData.fetchOrderBookDepth(symbol, limit);
    },
    async fetchLiquidationOrders(symbol, limit = 50) {
      return binanceData.fetchLiquidationOrders(symbol, limit);
    },
    async fetchExchangeSpecs() {
      return binanceData.fetchExchangeSpecs();
    },
    async fetchSpotExchangeSymbols() {
      return binanceData.fetchSpotExchangeSymbols();
    },
  },
};

async function probeProvider(provider) {
  if (state.probeCache.has(provider)) return state.probeCache.get(provider);
  const fn = providers[provider]?.probe;
  if (!fn) {
    state.probeCache.set(provider, false);
    return false;
  }

  try {
    const result = await fn();
    const ok = isNonEmpty(result);
    state.probeCache.set(provider, ok);
    return ok;
  } catch (err) {
    state.probeCache.set(provider, false);
    markProviderBlocked(provider, 'probe', err);
    return false;
  }
}

async function primePublicProviderChain() {
  const order = parseProviderOrder();
  for (const provider of order) {
    const ok = await probeProvider(provider);
    if (ok) {
      logger.info(`🛰️ Futures public provider primed: ${provider.toUpperCase()}`);
      return provider;
    }
  }

  const ok = await probeProvider('binance');
  if (ok) {
    logger.info('🛰️ Futures public provider primed: BINANCE');
    return 'binance';
  }

  logger.warn('⚠️ No futures public provider responded during priming. Scanner will use live fallback calls.');
  return null;
}

function getProviderHealth() {
  return {
    blockedProviders: [...state.blockedProviders],
    preferredByMethod: Object.fromEntries(state.preferredByMethod.entries()),
    recentEvents: state.recentEvents.slice(-12).map((event) => ({
      ...event,
      time: new Date(event.ts).toISOString(),
    })),
  };
}

async function fetchOHLCV(symbol, interval, limit = 100, options = {}) {
  return callProviderChain('fetchOHLCV', async (provider) => providers[provider]?.fetchOHLCV?.(symbol, interval, limit, options), {
    binanceArgs: [symbol, interval, limit, options],
  });
}

async function fetchTopPairs(limit = config.scanner.maxPairs) {
  return callProviderChain('fetchTopPairs', async (provider) => providers[provider]?.fetchTopPairs?.(limit), {
    binanceArgs: [limit],
    emptyFallback: [],
  });
}

async function fetch24hTicker(symbol) {
  return callProviderChain('fetch24hTicker', async (provider) => providers[provider]?.fetch24hTicker?.(symbol), {
    binanceArgs: [symbol],
    objectFallback: null,
  });
}

async function fetchFundingRate(symbol) {
  return callProviderChain('fetchFundingRate', async (provider) => providers[provider]?.fetchFundingRate?.(symbol), {
    binanceArgs: [symbol],
  });
}

async function fetchOpenInterest(symbol) {
  return callProviderChain('fetchOpenInterest', async (provider) => providers[provider]?.fetchOpenInterest?.(symbol), {
    binanceArgs: [symbol],
    objectFallback: null,
  });
}

async function fetchOpenInterestHistory(symbol, period = '1h', limit = 12) {
  return callProviderChain('fetchOpenInterestHistory', async (provider) => providers[provider]?.fetchOpenInterestHistory?.(symbol, period, limit), {
    binanceArgs: [symbol, period, limit],
    emptyFallback: [],
    silentEmpty: true,
  });
}

async function fetchGlobalLongShortRatio(symbol, period = '1h', limit = 6) {
  return callProviderChain('fetchGlobalLongShortRatio', async (provider) => providers[provider]?.fetchGlobalLongShortRatio?.(symbol, period, limit), {
    binanceArgs: [symbol, period, limit],
    emptyFallback: [],
    silentEmpty: true,
  });
}

async function fetchTopTraderLongShortRatio(symbol, period = '1h', limit = 6) {
  return callProviderChain('fetchTopTraderLongShortRatio', async (provider) => providers[provider]?.fetchTopTraderLongShortRatio?.(symbol, period, limit), {
    binanceArgs: [symbol, period, limit],
    emptyFallback: [],
    silentEmpty: true,
  });
}

async function fetchOrderBookDepth(symbol, limit = 20) {
  return callProviderChain('fetchOrderBookDepth', async (provider) => providers[provider]?.fetchOrderBookDepth?.(symbol, limit), {
    binanceArgs: [symbol, limit],
    objectFallback: null,
    silentEmpty: true,
  });
}

async function fetchLiquidationOrders(symbol, limit = 50) {
  return callProviderChain('fetchLiquidationOrders', async (provider) => providers[provider]?.fetchLiquidationOrders?.(symbol, limit), {
    binanceArgs: [symbol, limit],
    emptyFallback: [],
    silentEmpty: true,
  });
}

async function fetchExchangeSpecs() {
  return callProviderChain('fetchExchangeSpecs', async (provider) => providers[provider]?.fetchExchangeSpecs?.(), {
    binanceArgs: [],
    objectFallback: {},
  });
}

async function fetchSpotExchangeSymbols() {
  return callProviderChain('fetchSpotExchangeSymbols', async (provider) => providers[provider]?.fetchSpotExchangeSymbols?.(), {
    binanceArgs: [],
    emptyFallback: [],
  });
}

module.exports = {
  primePublicProviderChain,
  getProviderHealth,
  fetchOHLCV,
  fetchTopPairs,
  fetch24hTicker,
  fetchFundingRate,
  fetchOpenInterest,
  fetchOpenInterestHistory,
  fetchGlobalLongShortRatio,
  fetchTopTraderLongShortRatio,
  fetchOrderBookDepth,
  fetchLiquidationOrders,
  fetchExchangeSpecs,
  fetchSpotExchangeSymbols,
};
