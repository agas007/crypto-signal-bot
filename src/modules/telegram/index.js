const TelegramBot = require('node-telegram-bot-api');
const config = require('../../config');
const logger = require('../../utils/logger');
const { formatJakartaTime } = require('../../utils/time');

let bot = null;

/**
 * Initialize the Telegram bot (polling disabled — send-only mode).
 */
function initTelegram() {
  bot = new TelegramBot(config.telegram.botToken, { polling: false });
  logger.info('Telegram bot initialized (send-only mode)');
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

  return `
🚨 *TRADE SIGNAL* ${qualityEmoji}

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
 * Send a trade signal to the configured Telegram chat.
 *
 * @param {{
 *   symbol: string, bias: string, confidence: number, quality: string,
 *   entry: number, stop_loss: number, take_profit: number, reason: string
 * }} signal
 */
async function sendSignal(signal) {
  if (!bot) initTelegram();

  const message = formatSignalMessage(signal);

  try {
    await bot.sendMessage(config.telegram.chatId, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
    logger.info(`📨 Signal sent to Telegram: ${signal.symbol} ${signal.bias}`);
  } catch (err) {
    logger.error(`Failed to send Telegram message: ${err.message}`);
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
