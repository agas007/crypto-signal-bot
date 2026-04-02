const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const config = require('../../config');
const logger = require('../../utils/logger');
const { formatJakartaTime } = require('../../utils/time');
const { analyzePerformanceSummary } = require('../ai/openrouter');
const tracker = require('../tracker');
const binancePerformance = require('../tracker/binance_performance');

let bot = null;
let startTime = Date.now();

function getHelpMessage(chatId) {
  return `🤖 *Crypto Signal Bot v4.2.0* is active!\n` +
    `_Binance Sync, Funding Rate Filter, BE Protect & Stalled detection active._\n\n` +
    `📈 /performance [period] [market] - Real PnL & AI Coach\n` +
    `_Periods: daily, weekly, monthly, all_\n` +
    `_Markets: spot, futures, combined_\n` +
    `_Example: /performance weekly futures_\n\n` +
    `⏳ /active - List all currently active signals\n` +
    `📊 /status - Bot health & info\n` +
    `📜 /history - View last 10 trade results\n` +
    `🧠 /lessons - View recent AI learnings\n` +
    `📐 /strategy - View current trading logic\n` +
    `❓ /help - Show this help menu\n\n` +
    `⚙️ /adjust SYMBOL TP SL - Manual level adjust\n\n` +
    `🛠 *Admin Commands:* \n` +
    `🗑 /reset\\_active - Clear all active signals\n` +
    `📂 /reset\\_history - Clear trade history\n` +
    `🧠 /reset\\_lessons - Clear AI lessons\n\n` +
    `_Connected to chatId: ${chatId}_`;
}

/**
 * Initialize the Telegram bot with polling enabled for interactive commands.
 */
function initTelegram() {
  if (bot) return; // Prevent multiple initializations

  bot = new TelegramBot(config.telegram.botToken, { polling: true });
  logger.info('Telegram bot initialized with interactive POLLING mode');

  // ─── Command Handlers ─────────────────────────────────────
  
  // /start, /help, /commands
  const helpHandler = (msg) => {
    bot.sendMessage(msg.chat.id, getHelpMessage(msg.chat.id), { parse_mode: 'Markdown' });
  };

  bot.onText(/\/start/, helpHandler);
  bot.onText(/\/help/, helpHandler);
  bot.onText(/\/commands/, helpHandler);

  // /status command
  bot.onText(/\/status/, (msg) => {
    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
    const hrs = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    
    bot.sendMessage(msg.chat.id, 
      `✅ *Bot Status: ONLINE*\n\n` +
      `🕒 *Uptime:* ${hrs}h ${mins}m\n` +
      `⌛ *Interval:* ${config.scanner.intervalMs / 3600000} hour(s)\n` +
      `🎯 *Mode:* Strict (Score ≥ 65)\n` +
      `🧠 *AI Memory:* ${tracker.lessons.length} lessons learned\n` +
      `🔄 *Timeframes:* D1 · H4 · H1`,
      { parse_mode: 'Markdown' }
    );
  });

  // /performance command
  bot.onText(/\/performance(?:\s+(\w+))?(?:\s+(\w+))?/, async (msg, match) => {
    let period = (match[1] || 'all').toLowerCase();
    let market = (match[2] || 'combined').toLowerCase();

    // Allow swap of arguments (e.g. /performance futures weekly)
    const validPeriods = ['daily', 'weekly', 'monthly', 'all'];
    const validMarkets = ['spot', 'futures', 'combined'];

    if (validMarkets.includes(period) && !validPeriods.includes(market)) {
        [period, market] = [market, period]; // swap
    }

    bot.sendMessage(msg.chat.id, `⌛ *Fetching Binance ${market.toUpperCase()} data...*\n_Analyzing trades and calling AI Coach..._`, { parse_mode: 'Markdown' });

    try {
      const stats = await binancePerformance.getPerformance(period, market);
      
      let ledger = '';
      if (stats.tradeLog && stats.tradeLog.length > 0) {
        ledger = `📜 *TRADE LEDGER (Recent 10):*\n` +
                 stats.tradeLog.slice(0, 10).map(t => {
                   const emoji = parseFloat(t.pnl) > 0 ? '✅' : '🚨';
                   const pnlSafe = (parseFloat(t.pnl) > 0 ? '+' : '') + t.pnl;
                   const symbolSafe = (t.symbol || 'PAIR').replace(/_/g, '\\_');
                   return `${emoji} \`${symbolSafe}\` (${t.market}): \`${pnlSafe} USDT\``;
                 }).join('\n') + `\n\n`;
      }

      // 🧠 Call AI Performance Coach
      let aiReview = await analyzePerformanceSummary(stats, stats.tradeLog);
      
      // Sanitize Markdown from AI (Truncate BEFORE sanitization to avoid breaking entities)
      const maxAiLen = 3000;
      const aiTruncated = aiReview.length > maxAiLen ? aiReview.substring(0, maxAiLen) + '...' : aiReview;
      
      const sanitizedAiReview = aiTruncated
        .replace(/([_*`\[\]()])/g, '\\$1') // Escape ALL possible markdown chars
        .replace(/\\`\\`\\`(\w+)?/g, '\n```$1\n') // But restore code blocks
        .replace(/\\*\\*/g, '*') // And bold
        .replace(/\\`/g, '`'); // And inline code

      const report = `📈 *BINANCE PERFORMANCE REPORT*\n` +
                     `⏱ *Period:* \`${stats.period.toUpperCase()}\`\n` +
                     `🏛 *Market:* \`${stats.market.toUpperCase()}\`\n` +
                     `━━━━━━━━━━━━━━━━━━━\n\n` +
                     ledger +
                     `💰 *Total Realized PnL:* \`$${stats.totalPnl}\`\n` +
                     `📊 *Total Trades:* \`${stats.tradesCount}\`\n` +
                     `🎯 *Win Rate:* \`${stats.winRate}\`\n` +
                     `✅ *Wins:* ${stats.wins} | 🚨 *Losses:* ${stats.losses}\n\n` +
                     `🧠 *AI PERFORMANCE COACH:* \n${sanitizedAiReview}\n\n` +
                     `_Note: Datasync is real-time via Binance API._`;

      bot.sendMessage(msg.chat.id, report, { parse_mode: 'Markdown' }).catch(err => {
          logger.error('Telegram Markdown Error (Retrying plain text):', err.message);
          const plainReport = report
             .replace(/[*_`]/g, '')
             .replace(/━━━━━━━━━━━━━━━━━━━/g, '-------------------');
          bot.sendMessage(msg.chat.id, plainReport);
      });
    } catch (err) {
      logger.error('Failed to generate Binance performance:', err.stack);
      bot.sendMessage(msg.chat.id, '❌ *Failed to fetch performance data.* \n\nCheck if your API keys are correct and your VPS is in a supported region (avoid US/UK). Error: ' + err.message, { parse_mode: 'Markdown' });
    }
  });

  // /active command
  bot.onText(/\/active/, (msg) => {
    const actives = tracker.getAllActive();
    
    if (actives.length === 0) {
      return bot.sendMessage(msg.chat.id, '😴 *No active signals* at the moment.');
    }

    let report = `⏳ *ACTIVE SIGNALS (${actives.length})*\n\n`;
    
    actives.forEach((s, i) => {
      const ageMin = Math.floor((Date.now() - s.timestamp) / 60000);
      const ageStr = ageMin > 60 ? `${(ageMin/60).toFixed(1)}h` : `${ageMin}m`;
      
      const risk = Math.abs(s.entry - s.stop_loss);
      const reward = Math.abs(s.take_profit - s.entry);
      const rrRatio = risk > 0 ? (reward / risk).toFixed(2) : (s.slMovedToEntry ? '∞ (Risk-Free)' : 'N/A');

      report += `${i+1}. *${s.symbol}* (${s.bias})\n` +
                `• Entry: \`${s.entry}\`\n` +
                `• TP: \`${s.take_profit}\` | SL: \`${s.stop_loss}\`\n` +
                `• R:R Ratio: \`${rrRatio}\` | Age: \`${ageStr}\`\n\n`;
    });

    bot.sendMessage(msg.chat.id, report, { parse_mode: 'Markdown' });
  });

  // /adjust command
  bot.onText(/\/adjust\s+(\w+)\s+([\d.]+)\s+([\d.]+)/, (msg, match) => {
    const symbol = match[1].toUpperCase();
    const tp = match[2];
    const sl = match[3];

    const success = tracker.adjustSignal(symbol, tp, sl);
    if (success) {
      bot.sendMessage(msg.chat.id, `✅ *Adjusted levels for ${symbol}:*\n• *New TP:* \`${tp}\`\n• *New SL:* \`${sl}\``, { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(msg.chat.id, `❌ Signal for *${symbol}* not found.`);
    }
  });

  // /history command
  bot.onText(/\/history/, (msg) => {
    const history = tracker.history.slice(-10).reverse();
    if (history.length === 0) return bot.sendMessage(msg.chat.id, '📜 *No trade history* yet.');

    let report = `📜 *LAST 10 TRADE RESULTS*\n\n`;
    history.forEach((t, i) => {
      const resultEmoji = t.close_reason === 'TP_HIT' ? '✅' : t.close_reason === 'SL_HIT' ? '🚨' : '⚪';
      report += `${i+1}. ${resultEmoji} *${t.symbol}* (${t.bias})\n` +
                `• In: \`${t.entry}\` → Out: \`${t.exit_price || 'N/A'}\`\n` +
                `• Result: \`${t.close_reason}\`\n\n`;
    });
    bot.sendMessage(msg.chat.id, report, { parse_mode: 'Markdown' });
  });

  // /lessons command
  bot.onText(/\/lessons/, (msg) => {
    const lessons = tracker.lessons.slice(-5).reverse();
    if (lessons.length === 0) return bot.sendMessage(msg.chat.id, '🧠 *No lessons learned* yet. Keep trading!');

    let report = `🧠 *RECENT AI LESSONS (Post-Mortem)*\n\n`;
    lessons.forEach((l, i) => {
      report += `${i+1}. *${l.symbol}* (${l.bias})\n_${l.analysis}_\n\n`;
    });
    bot.sendMessage(msg.chat.id, report, { parse_mode: 'Markdown' });
  });

  // ─── Reset Commands ───
  bot.onText(/\/reset_active/, (msg) => {
    tracker.clearActive();
    bot.sendMessage(msg.chat.id, '🗑 *Active signals cleared!*');
  });

  bot.onText(/\/reset_history/, (msg) => {
    tracker.clearHistory();
    bot.sendMessage(msg.chat.id, '📂 *Trade history cleared!*');
  });

  bot.onText(/\/reset_lessons/, (msg) => {
    tracker.clearLessons();
    bot.sendMessage(msg.chat.id, '🧠 *AI lessons cleared!*');
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

  const typeEmoji = signal.trading_type === 'SCALPING' ? '⚡' : signal.trading_type === 'SWING' ? '🎯' : '🗓️';

  return `
${fallbackHeader}${header} ${qualityEmoji}

${biasEmoji} *${signal.symbol}*
━━━━━━━━━━━━━━━━━━━

📊 *Bias:* \`${signal.bias}\`
${typeEmoji} *Type:* \`${signal.trading_type || 'DAY TRADING'}\`
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
        { text: '📈 View', url: `https://www.tradingview.com/chart/?symbol=BINANCE:${signal.symbol}` },
        { text: '💰 Trade', url: `https://app.binance.com/en/trade/${signal.symbol.replace('USDT', '_USDT')}` }
      ]
    ]
  };

  try {
    if (imagePath && fs.existsSync(imagePath)) {
      await bot.sendPhoto(config.telegram.chatId, fs.createReadStream(imagePath), {
        caption: message,
        parse_mode: 'Markdown',
        reply_markup: replyMarkup
      });
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
