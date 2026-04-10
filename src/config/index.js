const path = require('path');
const envPath = path.resolve(__dirname, '../../.env');
require('dotenv').config({ path: envPath });


const config = {
  binance: {
    baseUrl: process.env.BINANCE_BASE_URL || 'https://api.binance.com',
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_API_SECRET,
    rateLimitMs: parseInt(process.env.BINANCE_RATE_LIMIT_MS, 10) || 200,
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
    intervalMs: parseInt(process.env.SCAN_INTERVAL_MS, 10) || 3_600_000, // 1 hour
    topSignalsToAi: parseInt(process.env.TOP_SIGNALS_TO_AI, 10) || 5,
    maxPairs: parseInt(process.env.MAX_PAIRS, 10) || 30,
  },

  // Timeframes mapped to Binance interval codes
  timeframes: {
    D1: '1d',
    H4: '4h',
    H1: '1h',
  },

  // Indicator parameters
  indicators: {
    ema: { fast: 9, slow: 21 },
    stochastic: { kPeriod: 5, dPeriod: 3, smooth: 3 },
    swingLookback: 20,
  },

  // Filter thresholds
  filters: {
    minVolume24hUsd: 1_000_000,    // $1M minimum daily volume (was $5M)
    minAtrPercent: 0.8,             // 0.8% minimum ATR (was 1.5%)
    minTrendStrength: 0.2,          // Allow moderate trends through (was 0.6)
  },

  strategy: {
    minRrRatio: parseFloat(process.env.MIN_RR_RATIO) || 1.5,
    accountBalance: parseFloat(process.env.ACCOUNT_BALANCE) || 1000,
    riskPercentage: parseFloat(process.env.RISK_PERCENTAGE) || 0.05,           // Risk X% of account balance per trade
    maxPositionPercentage: parseFloat(process.env.MAX_POSITION_PERCENTAGE) || 3.0, // Default to 300% total balance
    minRiskDollar: 0.25,             // Minimum $0.20 risk if 5% is lower
    maxSlAllowed: 0.08,              // Max 8% Stop Loss distance allowed
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
    process.exit(1);
  }
}

module.exports = config;
