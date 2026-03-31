require('dotenv').config();

const config = {
  binance: {
    baseUrl: process.env.BINANCE_BASE_URL || 'https://api.binance.com',
    rateLimitMs: 200, // delay between requests to stay under rate limits
  },

  openRouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
    baseUrl: 'https://openrouter.ai/api/v1',
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },

  scanner: {
    intervalMs: parseInt(process.env.SCAN_INTERVAL_MS, 10) || 900_000, // 15 min
    topSignalsToAi: parseInt(process.env.TOP_SIGNALS_TO_AI, 10) || 5,
    maxPairs: parseInt(process.env.MAX_PAIRS, 10) || 30,
  },

  // Timeframes mapped to Binance interval codes
  timeframes: {
    D1: '1d',
    H4: '4h',
    M15: '15m',
  },

  // Indicator parameters
  indicators: {
    ema: { fast: 9, slow: 21 },
    stochastic: { kPeriod: 5, dPeriod: 3, smooth: 3 },
    swingLookback: 20,
  },

  // Filter thresholds
  filters: {
    minVolume24hUsd: 5_000_000,    // $5M minimum daily volume (was $10M)
    minAtrPercent: 0.8,             // 0.8% minimum ATR (was 1.5%)
    minTrendStrength: 0.2,          // Allow moderate trends through (was 0.6)
  },

  strategy: {
    minRrRatio: parseFloat(process.env.MIN_RR_RATIO) || 1.5,
  },
};

// ── validation ──────────────────────────────────────────
const required = [
  ['openRouter.apiKey', config.openRouter.apiKey],
  ['telegram.botToken', config.telegram.botToken],
  ['telegram.chatId', config.telegram.chatId],
];

for (const [name, value] of required) {
  if (!value) {
    console.error(`❌ Missing required env variable: ${name}`);
    process.exit(1);
  }
}

module.exports = config;
