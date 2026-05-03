const logger = require('./logger');

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

let upstashClient = null;

function normalizePart(value, fallback = 'unknown') {
  const text = String(value ?? '').trim();
  return text ? text.replace(/\s+/g, '_').toUpperCase() : fallback;
}

function getSignalCandleTime(signal) {
  const explicitCandleTime = Number(signal?.candleTime);
  if (Number.isFinite(explicitCandleTime) && explicitCandleTime > 0) {
    return explicitCandleTime;
  }

  const candles = Array.isArray(signal?.candles) ? signal.candles : [];
  const lastCandle = candles.length > 0 ? candles[candles.length - 1] : null;
  const candleTime = Number(lastCandle?.openTime);

  if (Number.isFinite(candleTime) && candleTime > 0) {
    return candleTime;
  }

  const timestamp = Number(signal?.timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    return timestamp;
  }

  return Date.now();
}

function buildSignalDedupeKey(signal) {
  const symbol = normalizePart(signal?.symbol, 'UNKNOWN');
  const timeframe = normalizePart(signal?.timeframe || signal?.interval || '1h', '1H');
  const side = normalizePart(signal?.side || signal?.bias, 'UNKNOWN');
  const candleTime = String(getSignalCandleTime(signal));

  return `signal:${symbol}:${timeframe}:${side}:${candleTime}`;
}

function hasUpstashEnv() {
  return Boolean(REDIS_URL && REDIS_TOKEN);
}

function getUpstashClient() {
  if (upstashClient) return upstashClient;
  if (!hasUpstashEnv()) return null;

  try {
    // Prefer the official Upstash client when available.
    const { Redis } = require('@upstash/redis');
    upstashClient = new Redis({
      url: REDIS_URL,
      token: REDIS_TOKEN,
    });
    return upstashClient;
  } catch (err) {
    logger.warn(`[Dedupe] @upstash/redis unavailable, using REST fallback: ${err.message}`);
    upstashClient = {
      async set(key, value, opts = {}) {
        const args = ['SET', key, value];
        if (opts.nx) args.push('NX');
        if (opts.ex) args.push('EX', String(opts.ex));

        const res = await fetch(REDIS_URL, {
          method: 'POST',
          cache: 'no-store',
          headers: {
            Authorization: `Bearer ${REDIS_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(args),
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Upstash REST ${res.status}: ${text}`);
        }

        const data = await res.json();
        if (data?.error) {
          throw new Error(`Upstash error: ${data.error}`);
        }
        return data?.result ?? null;
      },
      async del(key) {
        const res = await fetch(REDIS_URL, {
          method: 'POST',
          cache: 'no-store',
          headers: {
            Authorization: `Bearer ${REDIS_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(['DEL', key]),
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Upstash REST ${res.status}: ${text}`);
        }

        const data = await res.json();
        if (data?.error) {
          throw new Error(`Upstash error: ${data.error}`);
        }
        return data?.result ?? 0;
      },
    };
    return upstashClient;
  }
}

async function claimSignalDedupe(signal, options = {}) {
  const key = options.key || buildSignalDedupeKey(signal);
  const ttlSeconds = options.ttlSeconds || DEFAULT_TTL_SECONDS;
  const client = getUpstashClient();

  if (!client) {
    return {
      ok: false,
      deduped: false,
      key,
      backend: 'disabled',
      reason: 'Redis env is not configured',
    };
  }

  try {
    const result = await client.set(key, '1', { nx: true, ex: ttlSeconds });
    const created = result === 'OK' || result === true;

    return {
      ok: true,
      deduped: !created,
      key,
      backend: 'upstash',
    };
  } catch (err) {
    logger.error(`[Dedupe] claimSignalDedupe failed for ${key}: ${err.message}`);
    return {
      ok: false,
      deduped: false,
      key,
      backend: 'error',
      reason: err.message,
    };
  }
}

async function releaseSignalDedupe(key) {
  const client = getUpstashClient();
  if (!client) return false;

  try {
    const result = await client.del(key);
    return Number(result) > 0;
  } catch (err) {
    logger.error(`[Dedupe] releaseSignalDedupe failed for ${key}: ${err.message}`);
    return false;
  }
}

module.exports = {
  buildSignalDedupeKey,
  claimSignalDedupe,
  getSignalCandleTime,
  releaseSignalDedupe,
};
