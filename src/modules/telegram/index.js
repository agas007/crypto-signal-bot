const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
// Fix deprecation warnings for file options
process.env.NTBA_FIX_350 = 1;
const config = require('../../config');
const logger = require('../../utils/logger');
const { formatJakartaTime, getNextJakartaReset } = require('../../utils/time');
const { aggregatePositionHistory } = require('../../utils/trade_aggregation');
const { analyzePerformanceSummary } = require('../ai/openrouter');
const tracker = require('../tracker');
const binancePerformance = require('../tracker/binance_performance');

let bot = null;
let startTime = Date.now();

function getHelpMessage(chatId) {
  return `🤖 *Crypto Signal Bot v4.4* is active!\n` +
    `_Adaptive Intelligence, Market Regime, Retest Guard & Smart SL active._\n\n` +
    `📈 /performance [period] [market] - Real PnL & AI Coach\n` +
    `_Periods: daily, weekly, monthly, all_\n` +
    `_Markets: spot, futures, combined_\n` +
    `_Example: /performance weekly futures_\n\n` +
    `⏳ /active - List all currently active signals\n` +
    `🔎 /check SYMBOL - Manual deep analysis for a pair\n` +
    `📊 /status - Bot health & info\n` +
    `📜 /history - View last 10 trade results\n` +
    `🧠 /lessons - View recent AI learnings\n` +
    `📐 /strategy - View current trading logic\n` +
    `📋 /watchlist - View last cycle high-alert watchlist\n` +
    `📋 /log - View last 15 scan audit logs\n` +
    `❓ /help - Show this help menu\n\n` +
    `⚙️ /adjust SYMBOL TP SL - Manual level adjust\n\n` +
    `🛠 *Admin Commands:* \n` +
    `🗑 /reset\\_active - Clear all active signals\n` +
    `📂 /reset\\_history - Clear trade history\n` +
    `🧠 /reset\\_lessons - Clear AI lessons\n` +
    `🛡️ /reset\\_cooldown - Reset daily limits immediately\n\n` +
    `_Daily reset occurs at 09:00 WIB (UTC+7)_`;
}

/**
 * Initialize the Telegram bot with polling enabled for interactive commands.
 */
async function initTelegram() {
  if (bot) return; // Prevent multiple initializations

  bot = new TelegramBot(config.telegram.botToken, { 
    polling: false, // Start with polling false to clear webhook first
    request: {
        agentOptions: {
            keepAlive: true,
            family: 4 
        }
    }
  });

  try {
    // Clear any existing webhooks to prevent 409 Conflict errors
    if (typeof bot.deleteWebHook === 'function') {
      await bot.deleteWebHook();
    } else if (typeof bot.deleteWebhook === 'function') {
      await bot.deleteWebhook();
    }
    
    logger.info('Telegram webhook cleared. Waiting 5s before starting polling to avoid race conditions...');
    
    // Give a small delay to let old Railway instances shut down completely
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Now start polling
    await bot.startPolling();
    logger.info('Telegram bot initialized with interactive POLLING mode');
  } catch (err) {
    logger.error('Failed to initialize Telegram polling:', err.message);
  }

  // Handle unhandled rejections to prevent crashes
  process.on('unhandledRejection', (reason, p) => {
    logger.error(`❌ Unhandled Rejection at: ${p}, reason: ${reason}`);
  });

  // ─── Command Handlers ─────────────────────────────────────
  
  // /start, /help, /commands
  const helpHandler = (msg) => {
    const text = getHelpMessage(msg.chat.id);
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' }).catch(() => {
        bot.sendMessage(msg.chat.id, text.replace(/[*_`]/g, ''));
    });
  };

  bot.onText(/\/start/, helpHandler);
  bot.onText(/\/help/, helpHandler);
  bot.onText(/\/commands/, helpHandler);

  // /ping - Diagnostic command
  bot.onText(/\/ping/, async (msg) => {
    const chatId = msg.chat.id;
    const start = Date.now();
    const { fetchFuturesBalance, fetchTopPairs } = require('../data/binance');
    const axios = require('axios');

    try {
        await bot.sendMessage(chatId, '🛰️ *Testing connectivity to Binance...* ⏳', { parse_mode: 'Markdown' });
        
        let ipInfo = 'Unknown';
        try {
            const ipRes = await axios.get('https://api.ipify.org?format=json', { timeout: 3000 });
            ipInfo = ipRes.data.ip;
        } catch (e) { /* ignore */ }

        const [balance, pairs] = await Promise.all([
            fetchFuturesBalance(),
            fetchTopPairs(1)
        ]);

        const latency = Date.now() - start;
        const msgText = `📡 *NETWORK DIAGNOSTIC*\n\n` +
            `✅ *Connectivity:* Stable\n` +
            `⚡ *Latency:* \`${latency}ms\`\n` +
            `📍 *Outbound IP:* \`${ipInfo}\` (Singapore Cluster)\n\n` +
            `💰 *Binance Balance:* \`${balance > 0 ? '$' + balance.toFixed(2) : 'No Permission / 0.00'}\`\n` +
            `📊 *Market Access:* \`${pairs.length > 0 ? 'OK' : 'FAIL'}\`\n\n` +
            `_Bot is successfully communicating with Binance API._`;

        await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
    } catch (err) {
        let errType = 'UNKNOWN';
        if (err.message.includes('451')) errType = 'RESTRICTED COUNTRY (451)';
        else if (err.message.includes('401')) errType = 'INVALID API KEY (401)';
        else if (err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') errType = 'NETWORK DOWN / DNS FAIL';

        await bot.sendMessage(chatId, `❌ *DIAGNOSTIC FAILED*\n\n` +
            `🔴 *Error Type:* \`${errType}\`\n` +
            `📝 *Detail:* \`${err.message}\`\n\n` +
            `• _Cek koneksi internet server lo_\n` +
            `• _Cek apakah Env Variables sudah diisi di Railway_\n` +
            `• _Pastiin server TIDAK di Amerika Serikat (US)_`);
    }
  });

  bot.onText(/\/status/, (msg) => {
    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
    const hrs = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);

    const dailyCount = tracker.getDailyTradeCount();
    const globalSlToday = tracker.getGlobalSLCountToday();
    const nextReset = getNextJakartaReset();
    const timeUntilResetMs = Math.max(0, nextReset - Date.now());
    const resetHrs = Math.floor(timeUntilResetMs / 3600000);
    const resetMins = Math.floor((timeUntilResetMs % 3600000) / 60000);
    
    let cooldownStatus = '🟢 *Scanning Active*';
    if (globalSlToday >= 3) {
      cooldownStatus = '🚫 *Global SL Cooldown* (3/3 SL hit)';
    } else if (dailyCount >= 5) {
      cooldownStatus = '⏳ *Daily Trade Limit Reached* (5/5 trades)';
    }
    
    const text = `✅ *Bot Status: ONLINE*\n\n` +
      `🕒 *Uptime:* ${hrs}h ${mins}m\n` +
      `⌛ *Interval:* ${config.scanner.intervalMs / 3600000} hour(s)\n` +
      `🔄 *Timeframes:* D1 · H4 · H1\n\n` +
      `🛡️ *Daily Limits (Reset in ${resetHrs}h ${resetMins}m):*\n` +
      `• *Trades Today:* ${dailyCount}/5\n` +
      `• *SL Hits Today:* ${globalSlToday}/3\n` +
      `• *Status:* ${cooldownStatus}\n\n` +
      `🧠 *AI Memory:* ${tracker.lessons.length} lessons learned\n` +
      `🎯 *Mode:* Strict (Score ≥ 65)`;

    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' }).catch(() => {
        bot.sendMessage(msg.chat.id, text.replace(/[*_`]/g, ''));
    });
  });

  // /dashboard command (Auto Visualizer via QuickChart)
  bot.onText(/\/dashboard/, async (msg) => {
    bot.sendMessage(msg.chat.id, '⏳ _Generating premium visual dashboard via Puppeteer..._', { parse_mode: 'Markdown' });
    
    try {
      const { generateAndSendDashboard } = require('../chart/dashboard');
      await generateAndSendDashboard(msg.chat.id);
    } catch (err) {
      logger.error('Manual dashboard generation failed:', err.message);
      bot.sendMessage(msg.chat.id, '❌ Gagal membuat visual dashboard harian.');
    }
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
                   const hasPlannedLevels = t.rr && t.tp != null && t.sl != null;
                   const fillsTag = t.fills && t.fills > 1 ? ` • *Fills:* ${t.fills}` : '';
                   const entryTimeLine = t.entryTime
                     ? `\n   _Entry Time:_ \`${formatJakartaTime(new Date(t.entryTime), 'readable')} WIB\``
                     : '';
                   
                   let extraInfo = '';
                   if (hasPlannedLevels) {
                     extraInfo = ` | *RR: ${parseFloat(t.rr).toFixed(2)}*${fillsTag}\n   _Entry:_ \`${t.entryPrice || '?'}\` | _Exit:_ \`${t.exitPrice || '?'}\`${entryTimeLine}\n   _TP:_ \`${t.tp || '?'}\` | _SL:_ \`${t.sl || '?'}\``;
                   } else {
                     let marginEst = (t.quoteQty || 0) / 20; 
                     let pnlPct = marginEst > 0 ? (parseFloat(t.pnl) / marginEst * 100) : 0;
                     extraInfo = `\n   _Entry:_ \`${t.entryPrice || '?'}\` | _Exit:_ \`${t.exitPrice || '?'}\`${entryTimeLine}\n   _Manual_ | _ROE:_ \`${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%\` (est 20x)${fillsTag}`;
                   }
                   
                   return `${emoji} \`${symbolSafe}\` (${t.market}): \`${pnlSafe} USDT\`${extraInfo}`;
                 }).join('\n') + `\n\n`;
      }

      // 🧠 Call AI Performance Coach
      let aiReview = await analyzePerformanceSummary(stats, stats.tradeLog.slice(0, 50));
      
      // Sanitize Markdown from AI (Truncate BEFORE sanitization to avoid breaking entities)
      const maxAiLen = 2000;
      const aiTruncated = aiReview.length > maxAiLen ? aiReview.substring(0, maxAiLen) + '...' : aiReview;
      
      const sanitizedAiReview = aiTruncated
        .replace(/\\/g, '') // Remove backslashes first
        .replace(/[*_]/g, '') // Strip existing AI-sent asterisk/underscores for cleanliness
        .replace(/\n\n+/g, '\n\n'); // Normalize double newlines

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
          const plainReport = report.replace(/[*_`]/g, '');
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
      const startTime = s.entryAt || s.signalAt || Date.now();
      const ageMin = Math.floor((Date.now() - startTime) / 60000);
      const ageStr = ageMin > 60 ? `${(ageMin/60).toFixed(1)}h` : `${ageMin}m`;
      
      const risk = Math.abs(s.entry - s.stop_loss);
      const reward = Math.abs(s.take_profit - s.entry);
      const rrRatio = risk > 0 ? (reward / risk).toFixed(2) : (s.slMovedToEntry ? '∞ (Risk-Free)' : 'N/A');
      
      const ps = s.riskReward?.positionSize;
      const psStr = ps 
        ? `• Position (20x): \`${(ps.margin).toFixed(2)} USDT\` (Qty: \`${ps.quantity.toFixed(3)}\`)\n`
        : '';

      report += `${i+1}. *${s.symbol}* (${s.bias})\n` +
                `• Entry: \`${s.entry}\`\n` +
                `• TP: \`${s.take_profit}\` | SL: \`${s.stop_loss}\`\n` +
                psStr +
                `• R:R Ratio: \`${rrRatio}\` | Age: \`${ageStr}\`\n\n`;
    });

    bot.sendMessage(msg.chat.id, report, { parse_mode: 'Markdown' }).catch(() => {
        bot.sendMessage(msg.chat.id, report.replace(/[*_`]/g, ''));
    });
  });

  // /adjust command
  bot.onText(/\/adjust\s+(\w+)\s+([\d.]+)\s+([\d.]+)/, (msg, match) => {
    const symbol = match[1].toUpperCase();
    const tp = match[2];
    const sl = match[3];

    const success = tracker.adjustSignal(symbol, tp, sl);
    if (success) {
      const text = `✅ *Adjusted levels for ${symbol}:*\n• *New TP:* \`${tp}\`\n• *New SL:* \`${sl}\``;
      bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' }).catch(() => {
        bot.sendMessage(msg.chat.id, text.replace(/[*_`]/g, ''));
      });
    } else {
      bot.sendMessage(msg.chat.id, `❌ Signal for *${symbol}* not found.`);
    }
  });

  // /history command
  bot.onText(/\/history/, (msg) => {
    const history = aggregatePositionHistory(tracker.history).slice(0, 10);
    if (history.length === 0) return bot.sendMessage(msg.chat.id, '📜 *No trade history* yet.');

    let report = `📜 *LAST 10 TRADE RESULTS*\n\n`;
    history.forEach((t, i) => {
      const resultEmoji = t.close_reason === 'TP_HIT' ? '✅' : t.close_reason === 'SL_HIT' ? '🚨' : '⚪';
      report += `${i+1}. ${resultEmoji} *${t.symbol}* (${t.bias})\n` +
                `• In: \`${t.entry}\` → Out: \`${t.exit_price || 'N/A'}\`\n` +
                `• Result: \`${t.close_reason}\`${t.fills > 1 ? ` | Fills: \`${t.fills}\`` : ''}\n\n`;
    });
    bot.sendMessage(msg.chat.id, report, { parse_mode: 'Markdown' }).catch(() => {
        bot.sendMessage(msg.chat.id, report.replace(/[*_`]/g, ''));
    });
  });

  // /lessons command
  bot.onText(/\/lessons/, (msg) => {
    const lessons = tracker.lessons.slice(-5).reverse();
    if (lessons.length === 0) return bot.sendMessage(msg.chat.id, '🧠 *No lessons learned* yet. Keep trading!');

    let report = `🧠 *RECENT AI LESSONS (Post-Mortem)*\n\n`;
    lessons.forEach((l, i) => {
      report += `${i+1}. *${l.symbol}* (${l.bias})\n_${l.analysis}_\n\n`;
    });
    bot.sendMessage(msg.chat.id, report, { parse_mode: 'Markdown' }).catch(() => {
        bot.sendMessage(msg.chat.id, report.replace(/[*_`]/g, ''));
    });
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

  bot.onText(/\/reset_cooldown/, (msg) => {
    tracker.resetCooldown();
    bot.sendMessage(msg.chat.id, '🛡️ *Cooldown manually reset!* Daily trade and SL limits have been cleared.');
  });

  // /log command
  bot.onText(/\/log/, (msg) => {
    const logPath = require('path').join(process.cwd(), 'scan_audit.log');
    if (!fs.existsSync(logPath)) {
        return bot.sendMessage(msg.chat.id, '📋 *Audit log is empty* or hasn\'t been created yet.');
    }

    try {
        const content = fs.readFileSync(logPath, 'utf8');
        const lines = content.trim().split('\n');
        
        // Take header (lines 0 and 1) + last 10 lines to reduce size
        const header = lines.slice(0, 2).join('\n');
        let lastEntries = lines.slice(-10).join('\n');
        
        // Telegram max is 4096. We need to leave room for formatting.
        const maxLen = 3800;
        if (lastEntries.length > maxLen) {
            lastEntries = '...[TRUNCATED]\n' + lastEntries.substring(lastEntries.length - maxLen);
        }
        
        const report = `📋 *SCAN AUDIT LOG (Last 10 entries)*\n\n` +
                       `\`\`\`\n${header}\n${lastEntries}\n\`\`\``;
        
        bot.sendMessage(msg.chat.id, report, { parse_mode: 'Markdown' }).catch(err => {
            logger.error('Telegram Markdown Error in /log (Retrying plain text):', err.message);
            let plainText = report.replace(/[*_`]/g, '');
            if (plainText.length > 4000) plainText = plainText.substring(0, 4000) + '...';
            bot.sendMessage(msg.chat.id, plainText);
        });
    } catch (err) {
        logger.error('Failed to read audit log:', err.message);
        bot.sendMessage(msg.chat.id, '❌ Failed to read audit log.');
    }
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

  // /watchlist command
  // /watchlist command
  bot.onText(/\/watchlist/, (msg) => {
    const list = tracker.getWatchlist();
    
    if (!list || list.length === 0) {
      return bot.sendMessage(msg.chat.id, '😴 *The High Alert Watchlist is empty.* \n_Wait for the next scan cycle..._');
    }
    
    const topList = list.slice(0, 10);
    let report = `📡 *HIGH ALERT WATCHLIST (${topList.length})*\n_These setups were close but didn't meet 'Strict' criteria._\n\n`;
    
    topList.forEach((s, i) => {
      const type = s.quality === 'WATCHLIST' ? '📋' : '🚫';
      const rrRatio = s.riskReward?.rr ? s.riskReward.rr.toFixed(2) : 'N/A';
      
      // Limit reason length to avoid Telegram character limit issues
      let reason = (s.reason || 'No specific reason').replace(/[*_`]/g, '');
      if (reason.length > 180) {
        reason = reason.substring(0, 180) + '...';
      }
      
      report += `${i + 1}. ${type} *${s.symbol}* (${s.bias || 'N/A'})\n` +
                `• Score: \`${s.score}/100\` | R:R: \`${rrRatio}\`\n` +
                `• Reason: _${reason}_\n\n`;
    });
    
    report += `🛡️ *Status:* Standby. Waiting for criteria to improve.`;

    // Final safety check for total length
    if (report.length > 3800) {
      report = report.substring(0, 3800) + '\n\n...[Truncated]';
    }

    bot.sendMessage(msg.chat.id, report, { parse_mode: 'Markdown' }).catch(() => {
        bot.sendMessage(msg.chat.id, report.replace(/[*_`]/g, ''));
    });
  });

  // /check [SYMBOL] command
  bot.onText(/\/check\s+(.+)/, async (msg, match) => {
    const rawInput = match[1].trim().toUpperCase();
    const symbol = rawInput.replace(/[\s_]/g, '');
    const finalSym = symbol.endsWith('USDT') ? symbol : symbol + 'USDT';
    
    logger.info(`🔍 Manual check triggered for: raw="${match[1]}", sanitized="${finalSym}"`);
    bot.sendMessage(msg.chat.id, `🔍 *Manual Analysis Request: ${finalSym}*\n_Fetching multi-TF data and calling AI..._`, { parse_mode: 'Markdown' });

    try {
        const { fetchMultiTimeframe, fetchFundingRate, fetchOHLCV } = require('../data/binance');
        const { evaluateSignal } = require('../strategy');
        const { refineSignal } = require('../ai/openrouter');
        const { analyzeTrend } = require('../indicators');

        const mtfData = await fetchMultiTimeframe(finalSym);
        const fundingRate = await fetchFundingRate(finalSym);

        if (!mtfData) {
            return bot.sendMessage(msg.chat.id, `❌ *Failed:* Could not fetch data for \`${finalSym}\`. Check symbol.`, { parse_mode: 'Markdown' });
        }

        // Evaluate technically
        const evalResult = evaluateSignal(finalSym, mtfData, { 
            fundingRate, 
            accountBalance: config.strategy.accountBalance,
            includeRejectionReason: true,
            micro: {} // provide empty micro for check
        });

        // evaluateSignal returns:
        //   Success: full object { symbol, bias, score, ... }
        //   Rejection: { signal: null, rejectionReason: '...' }
        const isRejection = evalResult && evalResult.signal === null;
        
        if (!evalResult || isRejection) {
            const reason = isRejection ? evalResult.rejectionReason : 'No clear technical bias';
            return bot.sendMessage(msg.chat.id, `🚫 *TECHNICAL REJECTION: ${finalSym}*\n_Alasan: ${reason}_`, { parse_mode: 'Markdown' });
        }

        const signal = evalResult;

        // Market Regime (BTC check)
        let btcTrend = 'NEUTRAL';
        try {
            const btcCandles = await fetchOHLCV('BTCUSDT', config.timeframes.D1, 50);
            if (btcCandles.length > 0) btcTrend = analyzeTrend(btcCandles).direction;
        } catch (e) {}

        // Construct Technical Report
        const techReport = `📊 *TECHNICAL ANALYSIS: ${finalSym}*\n` +
                           `━━━━━━━━━━━━━━━━━━━\n` +
                           `• *Bias:* \`${signal.bias}\`\n` +
                           `• *Technical Score:* \`${signal.score}/100\`\n` +
                           `• *Funding:* \`${signal.fundingRate}\`\n\n` +
                           `✅ *Confluences Found:*\n` +
                           signal.reasons.map(r => `_• ${r}_`).join('\n') + `\n\n` +
                           `📐 *Proposed Levels (Technical):*\n` +
                           `• *Entry:* \`${signal.riskReward.entry.toFixed(5)}\`\n` +
                           `• *TP:* \`${signal.riskReward.tp.toFixed(5)}\`\n` +
                           `• *SL:* \`${signal.riskReward.sl.toFixed(5)}\` \`(${(Math.abs(signal.riskReward.entry - signal.riskReward.sl)/signal.riskReward.entry*100).toFixed(2)}%)\`\n` +
                           `• *R:R Ratio:* \`${signal.riskReward.rr.toFixed(2)}\`\n\n` +
                           `⌛ *Calling AI Validator...*`;

        const techMsg = await bot.sendMessage(msg.chat.id, techReport, { parse_mode: 'Markdown' });

        const refined = await refineSignal(signal, { btcTrend });
        
        if (!refined || refined.bias === 'NO_TRADE' || refined.bias === 'NO TRADE' || refined.bias === 'WATCHLIST') {
            const isWatchlist = refined && refined.bias === 'WATCHLIST';
            const verdict = isWatchlist ? '📋 AI VERDICT: WATCHLIST' : '🚫 AI VERDICT: NO TRADE';
            
            // Clean AI reason from any markdown characters it might have sent automatically
            const rawReason = (refined ? refined.reason : 'AI Gagal memberikan respon detail.').replace(/[*_`]/g, '');
            const safeReason = escapeMarkdown(rawReason);
            
            let levelInfo = '';
            if (refined && refined.entry) {
                const rr = Math.abs(refined.take_profit - refined.entry) / Math.abs(refined.entry - refined.stop_loss);
                levelInfo = `\n\n📐 *AI Potential Levels:*` +
                            `\n• Entry: \`${refined.entry}\`` +
                            `\n• TP: \`${refined.take_profit}\` | SL: \`${refined.stop_loss}\`` +
                            `\n• AI R:R: \`${rr.toFixed(2)}\``;
            }

            const fullMsg = `*${verdict}* ${levelInfo}\n\n🧠 *AI REASONING:*\n_${safeReason}_`;
            return bot.sendMessage(msg.chat.id, fullMsg, { parse_mode: 'Markdown' });
        }

        // Recalculate RR / Position Size for the refined levels
        const { calculateRiskReward } = require('../strategy');
        refined.riskReward = calculateRiskReward(refined.bias, refined.entry, signal.analysis.h4SR, {
            accountBalance: config.strategy.accountBalance,
            sl: refined.stop_loss,
            tp: refined.take_profit
        });

        if (!refined.riskReward) {
            return bot.sendMessage(msg.chat.id, `❌ *AI ERROR:* AI suggested invalid price levels that failed risk calculation.`, { parse_mode: 'Markdown' });
        }

        // Format and send as a full signal
        const message = formatSignalMessage(refined);
        bot.sendMessage(msg.chat.id, `✅ *AI VERDICT: VALIDATED*\n\n${message}`, { parse_mode: 'Markdown' });

    } catch (err) {
        logger.error(`Manual check failed for ${finalSym}:`, err.message);
        bot.sendMessage(msg.chat.id, `❌ *Error:* Analysis failed for \`${finalSym}\`. \nDetail: ${err.message}`, { parse_mode: 'Markdown' });
    }
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
 * Helper to escape markdown characters to prevent Telegram API errors.
 * Note: Simple version for Markdown (V1) style.
 */
function escapeMarkdown(text) {
  if (!text) return '';
  // Only escape the characters that break basic Markdown
  return text.replace(/[_*`\[\]()]/g, (match) => `\\${match}`);
}

/**
 * Format a validated AI signal into a Telegram message.
 */
function formatSignalMessage(signal) {
  const isChartUpdate = signal.isChartUpdate;
  if (isChartUpdate) {
    return `📊 *CHART CONFIRMATION: ${signal.symbol}* \n_Sinyal sudah masuk, ini adalah chart pendukungnya._`;
  }

  const biasEmoji = signal.bias === 'LONG' ? '🟢' : '🔴';
  const qualityEmoji = signal.quality === 'HIGH' ? '⭐' : '🔶';

  const confidence = signal.confidence > 1 ? signal.confidence : signal.confidence * 100;
  const confBars = '█'.repeat(Math.round(confidence / 10)) + '░'.repeat(10 - Math.round(confidence / 10));

  const rrRatio = Math.abs(signal.take_profit - signal.entry) / Math.abs(signal.entry - signal.stop_loss);

  const fallbackHeader = signal.isFallback
    ? `⚠️ *BEST AVAILABLE — LOW CONFIDENCE*\n_Tidak ada sinyal high-conviction saat ini. Ini adalah kandidat terbaik dari scan cycle ini._\n\n`
    : '';

  const header = signal.isFallback ? '📡 *BEST AVAILABLE SIGNAL*' : '🚨 *TRADE SIGNAL*';

  const typeEmoji = signal.trading_type?.includes('MOMENTUM') ? '⚡' : signal.trading_type?.includes('SWING') ? '🎯' : '🗓️';
  const fundingEmoji = signal.fundingRate?.includes('-') ? '🔵' : '🟠';

  // 1. Clean AI reason from any markdown characters it might have sent automatically
  const rawReason = (signal.reason || '').replace(/[*_`]/g, '');
  
  // 2. Escape the cleaned reason
  let safeReason = escapeMarkdown(rawReason);

  // Calculate Expiry based on Type
  const now = new Date();
  let expiryHours = 4; // Default Day Trading
  if (signal.trading_type?.includes('SCALP')) expiryHours = 1;
  if (signal.trading_type?.includes('SWING')) expiryHours = 24;
  
  const expiryDate = new Date(now.getTime() + expiryHours * 60 * 60 * 1000);
  const expiryStr = formatJakartaTime(expiryDate, 'short');
  const dateStr = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: '2-digit',
  }).format(expiryDate);

  const scalingTag = signal.riskReward?.isScaled ? ' (⚠️ AUTO SCALED)' : '';

  const baseMessage = `
${fallbackHeader}${header} ${qualityEmoji}

${biasEmoji} *${signal.symbol}*
━━━━━━━━━━━━━━━━━━━

📊 *Bias:* \`${signal.bias}\`
${typeEmoji} *Type:* \`${signal.trading_type || 'DAY TRADING'}\`
🎯 *Confidence:* ${confidence.toFixed(0)}% ${confBars}
📋 *Quality:* \`${signal.quality || 'N/A'}\`
${fundingEmoji} *Funding:* \`${signal.fundingRate || '0.0000%'}\`

💰 *Entry:* \`${signal.entry}\`
🎯 *Take Profit:* \`${signal.take_profit}\`
🛑 *Stop Loss:* \`${signal.stop_loss}\`
📐 *R:R Ratio:* \`${rrRatio.toFixed(2)}\`

⏱️ *Valid Until:* \`${expiryStr} WIB (${dateStr})\`
🚫 *No Entry If:* \`${signal.bias === 'LONG' ? '>' : '<'} ${signal.bias === 'LONG' ? (signal.entry * 1.003).toFixed(5) : (signal.entry * 0.997).toFixed(5)}\`

🧮 *Position Size (Risk $${signal.riskReward.positionSize.risk.toFixed(2)} / 20x)${scalingTag}:*
• *Margin (Cost):* \`${signal.riskReward.positionSize.margin.toFixed(2)} USDT\`
• *Quantity:* \`${signal.riskReward.positionSize.quantity.toFixed(3)}\`
• *Notional:* \`$${signal.riskReward.positionSize.notional.toFixed(2)}\`

${signal.warnings && signal.warnings.length > 0 ? `⚠️ *Warnings:*\n${signal.warnings.map(w => `_• ${escapeMarkdown(w)}_`).join('\n')}\n` : ''}
💬 *Reason:*
`.trim();

  const footer = `
\n⏰ ${formatJakartaTime(new Date(), 'readable')} WIB | *v4.4*
━━━━━━━━━━━━━━━━━━━
⚠️ _Not financial advice. DYOR._
  `.trim();

  // Telegram Photo Caption Limit is 1024.
  const maxReasonLen = 1000 - baseMessage.length - footer.length;
  if (safeReason.length > maxReasonLen) {
    safeReason = safeReason.substring(0, Math.max(0, maxReasonLen - 20)) + '... [truncated]';
  }

  return `${baseMessage}\n_${safeReason}_\n${footer}`;
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
      }, {
        contentType: 'image/png' // Manually specifying to avoid deprecation warnings
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
    logger.error(`Failed to send interactive signal (${signal.symbol}): ${err.message}. Retrying as plain text...`);
    // Fallback: Send plain text message without markdown
    try {
        const plainMsg = message.replace(/[*_`]/g, '');
        await bot.sendMessage(config.telegram.chatId, `⚠️ [FORMATTING ERROR] ⚠️\n\n${plainMsg}`, {
            disable_web_page_preview: true,
            reply_markup: replyMarkup
        });
    } catch (retryErr) {
        logger.error(`Complete signal failure for ${signal.symbol}: ${retryErr.message}`);
    }
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
    logger.error(`Failed to send Telegram status: ${err.message}. Retrying as plain text...`);
    try {
        await bot.sendMessage(config.telegram.chatId, text.replace(/[*_`]/g, ''), {
            disable_web_page_preview: true
        });
    } catch (retryErr) {
        logger.error(`Complete status failure: ${retryErr.message}`);
    }
  }
}

/**
 * Improved helper to escape markdown characters to prevent Telegram API errors.
 */
function escapeMarkdown(text) {
  if (!text) return '';
  // More comprehensive for V1 Markdown
  return text.replace(/([_*`\[\]()])/g, '\\$1');
}

module.exports = { initTelegram, sendSignal, sendStatus, formatSignalMessage };
