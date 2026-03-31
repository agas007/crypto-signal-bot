const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const config = require('../../config');
const logger = require('../../utils/logger');
const { formatJakartaTime } = require('../../utils/time');

let bot = null;
let startTime = Date.now();

/**
 * Initialize the Telegram bot with polling enabled for interactive commands.
 */
function initTelegram() {
  if (bot) return; // Prevent multiple initializations

  bot = new TelegramBot(config.telegram.botToken, { polling: true });
  logger.info('Telegram bot initialized with interactive POLLING mode');

  // ─── Command Handlers ─────────────────────────────────────
  
  // /start command
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 
      `🤖 *Crypto Signal Bot v3.1.0* is active!\n\n` +
      `Commands:\n` +
      `📊 /status - Quick bot health check\n` +
      `📐 /strategy - View current trading logic\n` +
      `🔍 /pairs - See top pairs being scanned\n\n` +
      `_Connected to chatId: ${chatId}_`, 
      { parse_mode: 'Markdown' }
    );
  });

  // /status command
  bot.onText(/\/status/, (msg) => {
    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
    const hrs = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    
    bot.sendMessage(msg.chat.id, 
      `✅ *Bot Status: ONLINE*\n\n` +
      `🕒 *Uptime:* ${hrs}h ${mins}m\n` +
      `⌛ *Interval:* ${config.scanner.intervalMs / 3600000} hour(s)\n` +
      `🎯 *Strict Mode:* Active (Score ≥ 65)\n` +
      `🔄 *Timeframes:* D1 · H4 · H1`,
      { parse_mode: 'Markdown' }
    );
  });

  // /strategy command
  bot.onText(/\/strategy/, (msg) => {
    bot.sendMessage(msg.chat.id, 
      `📐 *Current Strategy:* v3.1.0\n\n` +
      `• *Min Score:* 65/98\n` +
      `• *Min Confluence:* 3 reasons\n` +
      `• *Min R:R Ratio:* ${config.strategy.minRrRatio}\n` +
      `• *S/R Proximity:* 4.0% threshold\n` +
      `• *Filter:* ATR > ${config.filters.minAtrPercent}%, Vol > $${(config.filters.minVolume24hUsd/1e6).toFixed(0)}M`,
      { parse_mode: 'Markdown' }
    );
  });

  // /pairs command
  bot.onText(/\/pairs/, async (msg) => {
    const { fetchTopPairs } = require('../data/binance');
    bot.sendMessage(msg.chat.id, '🔍 Fetching current top pairs...');
    
    try {
      const pairs = await fetchTopPairs();
      bot.sendMessage(msg.chat.id, 
        `📊 *Top ${pairs.length} Pairs Scanned:*\n\n` +
        `\`${pairs.join(', ')}\``,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      bot.sendMessage(msg.chat.id, '❌ Failed to fetch pairs.');
    }
  });
}

/**
 * Format a validated AI signal into a Telegram message.
 *
 * @param {{
 *   symbol: string, bias: string, confidence: number, quality: string,
 *   entry: number, stop_loss: number, take_profit: number, reason: string
 * }} signal
 * @returns {string}
 */
function formatSignalMessage(signal) {
  const biasEmoji = signal.bias === 'LONG' ? '🟢' : '🔴';
  const qualityEmoji = signal.quality === 'HIGH' ? '⭐' : '🔶';

  const confidence = signal.confidence > 1 ? signal.confidence : signal.confidence * 100;
  const confBars = '█'.repeat(Math.round(confidence / 10)) + '░'.repeat(10 - Math.round(confidence / 10));

  const rrRatio = Math.abs(signal.take_profit - signal.entry) / Math.abs(signal.entry - signal.stop_loss);

  const fallbackHeader = signal.isFallback
    ? `⚠️ *BEST AVAILABLE — LOW CONFIDENCE*\n_Tidak ada sinyal high-conviction saat ini. Ini adalah kandidat terbaik dari scan cycle ini._\n\n`
    : '';

  const header = signal.isFallback ? '📡 *BEST AVAILABLE SIGNAL*' : '🚨 *TRADE SIGNAL*';

  return `
${fallbackHeader}${header} ${qualityEmoji}

${biasEmoji} *${signal.symbol}*
━━━━━━━━━━━━━━━━━━━

📊 *Bias:* \`${signal.bias}\`
🎯 *Confidence:* ${confidence.toFixed(0)}% ${confBars}
📋 *Quality:* \`${signal.quality || 'N/A'}\`

💰 *Entry:* \`${signal.entry}\`
🎯 *Take Profit:* \`${signal.take_profit}\`
🛑 *Stop Loss:* \`${signal.stop_loss}\`
📐 *R:R Ratio:* \`${rrRatio.toFixed(2)}\`

💬 *Reason:*
_${signal.reason}_

⏰ ${formatJakartaTime(new Date(), 'readable')} WIB
━━━━━━━━━━━━━━━━━━━
⚠️ _Not financial advice. DYOR._
  `.trim();
}

/**
 * Send a trade signal with interactive inline buttons and an optional chart image.
 *
 * @param {Object} signal
 * @param {string} [imagePath] - Absolute path to the generated chart image
 */
async function sendSignal(signal, imagePath = null) {
  if (!bot) initTelegram();

  const message = formatSignalMessage(signal);
  
  // Construct inline buttons for TradingView and Binance
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: '📈 TradingView', url: `https://www.tradingview.com/chart/?symbol=BINANCE:${signal.symbol}` },
        { text: '💰 Binance App', url: `https://app.binance.com/en/trade/${signal.symbol.replace('USDT', '_USDT')}` }
      ]
    ]
  };

  try {
    if (imagePath && fs.existsSync(imagePath)) {
      await bot.sendPhoto(config.telegram.chatId, fs.createReadStream(imagePath), {
        caption: message,
        parse_mode: 'Markdown',
        reply_markup: replyMarkup
      }, { contentType: false }); // Fix deprecation warning
      // Optionally cleanup the image after sending
      fs.unlinkSync(imagePath);
    } else {
      await bot.sendMessage(config.telegram.chatId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: replyMarkup
      });
    }
    logger.info(`📨 Interactive signal sent to Telegram: ${signal.symbol}`);
  } catch (err) {
    logger.error(`Failed to send interactive signal: ${err.message}`);
  }
}

/**
 * Send a status/info message to the Telegram chat.
 *
 * @param {string} text
 */
async function sendStatus(text) {
  if (!bot) initTelegram();

  try {
    await bot.sendMessage(config.telegram.chatId, text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  } catch (err) {
    logger.error(`Failed to send Telegram status: ${err.message}`);
  }
}

module.exports = { initTelegram, sendSignal, sendStatus, formatSignalMessage };
