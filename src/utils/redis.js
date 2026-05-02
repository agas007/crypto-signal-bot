/**
 * Upstash Redis REST API wrapper for cross-environment state persistence.
 * Falls back gracefully (no-op) when env vars are not set (local dev).
 *
 * Env vars required:
 *   UPSTASH_REDIS_REST_URL   - e.g. https://xxxx.upstash.io
 *   UPSTASH_REDIS_REST_TOKEN - Bearer token
 */

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const isEnabled = () => !!(UPSTASH_URL && UPSTASH_TOKEN);

/**
 * Execute a single Redis command via REST API.
 * @param {string} command - Redis command e.g. 'GET', 'SET'
 * @param {...string} args - Command arguments
 */
async function redisCall(command, ...args) {
  if (!isEnabled()) return null;

  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([command, ...args]),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upstash HTTP ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (data.error) throw new Error(`Redis error: ${data.error}`);
  return data.result;
}

/**
 * Get a JSON value from Redis by key.
 * Returns null if key doesn't exist or Redis is not configured.
 * @param {string} key
 * @returns {Promise<any|null>}
 */
async function getState(key) {
  try {
    const result = await redisCall('GET', key);
    return result ? JSON.parse(result) : null;
  } catch (err) {
    console.error(`[Redis] getState(${key}) failed:`, err.message);
    return null;
  }
}

/**
 * Set a JSON value in Redis by key.
 * @param {string} key
 * @param {any} value - Will be JSON.stringify'd
 */
async function setState(key, value) {
  try {
    await redisCall('SET', key, JSON.stringify(value));
  } catch (err) {
    console.error(`[Redis] setState(${key}) failed:`, err.message);
  }
}

/**
 * Get multiple keys at once (MGET).
 * @param {string[]} keys
 * @returns {Promise<Array<any|null>>}
 */
async function mgetState(keys) {
  try {
    if (!isEnabled() || keys.length === 0) return keys.map(() => null);
    const results = await redisCall('MGET', ...keys);
    return (results || []).map(v => (v ? JSON.parse(v) : null));
  } catch (err) {
    console.error('[Redis] mgetState failed:', err.message);
    return keys.map(() => null);
  }
}

module.exports = { getState, setState, mgetState, isEnabled };
