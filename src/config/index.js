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

  discord: {
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_SIGNAL_WEBHOOK_URL,
    signalWebhookUrl: process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_SIGNAL_WEBHOOK_URL,
    statusWebhookUrl: process.env.DISCORD_STATUS_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_SIGNAL_WEBHOOK_URL,
  },

  bybit: {
    baseUrl:   process.env.BYBIT_BASE_URL   || 'https://api.bytick.com',
    apiKey:    process.env.BYBIT_API_KEY,
    apiSecret: process.env.BYBIT_API_SECRET,
  },

  futuresData: {
    providerOrder: process.env.FUTURES_DATA_PROVIDER_ORDER || 'bitget,okx,kucoin,hyperliquid',
    enableHyperliquid: process.env.FUTURES_DATA_ENABLE_HYPERLIQUID !== '0',
    enableBinanceFallback: process.env.FUTURES_DATA_ENABLE_BINANCE_FALLBACK === '1',
    bitgetBaseUrl: process.env.BITGET_BASE_URL || 'https://api.bitget.com',
    okxBaseUrl: process.env.OKX_BASE_URL || 'https://www.okx.com',
    kucoinBaseUrl: process.env.KUCOIN_BASE_URL || 'https://api-futures.kucoin.com',
    hyperliquidBaseUrl: process.env.HYPERLIQUID_BASE_URL || 'https://api.hyperliquid.xyz',
    providerBlockCooldownMs: parseInt(process.env.FUTURES_PROVIDER_BLOCK_COOLDOWN_MS, 10) || 15 * 60 * 1000,
    providerTransientCooldownMs: parseInt(process.env.FUTURES_PROVIDER_TRANSIENT_COOLDOWN_MS, 10) || 2 * 60 * 1000,
  },

  scanner: {
    intervalMs: parseInt(process.env.SCAN_INTERVAL_MS, 10) || 3_600_000, // 1 hour
    topSignalsToAi: parseInt(process.env.TOP_SIGNALS_TO_AI, 10) || 5,
    maxPairs: parseInt(process.env.MAX_PAIRS, 10) || 100,
  },

  // Timeframes mapped to Binance interval codes
  timeframes: {
    D1: '1d',
    H4: '4h',
    H1: '1h',
    M30: '30m',
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
    minVolume24hUsd: 750_000,       // $750K minimum daily volume
    minAtrPercent: 1.0,             // 1.0% minimum ATR — filter near-zero volatility pairs
    minTrendStrength: 0.3,          // 0.3 minimum — require a meaningful trend
  },

  strategy: {
    minRrRatio: parseFloat(process.env.MIN_RR_RATIO) || 2.0,
    accountBalance: parseFloat(process.env.ACCOUNT_BALANCE) || 1000,
    riskPercentage: parseFloat(process.env.RISK_PERCENTAGE) || 0.05,           // Risk X% of account balance per trade
    maxPositionPercentage: parseFloat(process.env.MAX_POSITION_PERCENTAGE) || 3.0, // Default to 300% total balance
    minRiskDollar: 0.25,             // Minimum $0.20 risk if 5% is lower
    maxSlAllowed: 0.08,              // Max 8% Stop Loss distance allowed
    bosConfirmationCandles: parseInt(process.env.BOS_CONFIRMATION_CANDLES, 10) || 2,
    repeatedLevelTouches: parseInt(process.env.REPEATED_LEVEL_TOUCHES, 10) || 3,
    standbyMinRr: parseFloat(process.env.STANDBY_MIN_RR) || 2.0,
  },
};

// ── validation ──────────────────────────────────────────
const required = [
  ['openRouter.apiKey', config.openRouter.apiKey],
];

// Discord webhook is required UNLESS Telegram is configured (backward compat)
const hasDiscord   = !!(config.discord.webhookUrl || config.discord.signalWebhookUrl);
const hasTelegram  = !!(config.telegram.botToken && config.telegram.chatId);
if (!hasDiscord && !hasTelegram) {
  required.push(['discord.signalWebhookUrl OR telegram.botToken+chatId', null]);
}

const validationErrors = required
  .filter(([, value]) => !value)
  .map(([name]) => `Missing required env var: ${name}`);

if (validationErrors.length > 0) {
  for (const message of validationErrors) {
    console.error(`❌ [Config] ${message}`);
  }
}

config.validationErrors = validationErrors;

module.exports = config;
