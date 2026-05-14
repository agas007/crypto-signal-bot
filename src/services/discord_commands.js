const crypto = require('crypto');
const tracker = require('../modules/tracker');
const binancePerformance = require('../modules/tracker/binance_performance');
const { formatJakartaTime, getNextJakartaReset } = require('../utils/time');
const { isEnabled: isRedisEnabled } = require('../utils/redis');
const { postWebhookWithFile } = require('../utils/discord');
const { buildLatestScanReportExport } = require('./scan_export');
const { COMMANDS } = require('./discord_command_definitions');

function truncate(text, max = 1800) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function minutesAgoLabel(timestamp) {
  if (!timestamp) return 'unknown';
  const diff = Date.now() - Number(timestamp);
  if (!Number.isFinite(diff) || diff < 0) return 'unknown';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

function formatSignalLine(signal) {
  if (!signal) return 'Tidak ada signal terakhir.';
  const side = signal.bias || signal.side || 'UNKNOWN';
  const score = signal.score != null ? `score ${signal.score}` : 'no score';
  const entry = signal.entry != null ? `entry ${signal.entry}` : 'entry n/a';
  const tp = signal.take_profit != null ? `TP ${signal.take_profit}` : 'TP n/a';
  const sl = signal.stop_loss != null ? `SL ${signal.stop_loss}` : 'SL n/a';
  const at = signal.signalAt || signal.entryAt || signal.timestamp || signal.closedAt || null;
  return `• \`${signal.symbol || 'PAIR'}\` (${side}) | ${score}\n  ${entry} | ${tp} | ${sl}\n  updated ${minutesAgoLabel(at)} ago`;
}

async function hydrateTracker() {
  await tracker.syncFromRedis().catch(() => {});
  return tracker;
}

function getCheckSignalUrl() {
  const configured = process.env.CHECK_SIGNAL_URL || process.env.CRON_TRIGGER_URL;
  if (configured) return configured;

  const baseUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || '';
  if (!baseUrl) return '';

  const normalized = baseUrl.startsWith('http://') || baseUrl.startsWith('https://')
    ? baseUrl
    : `https://${baseUrl}`;
  return `${normalized.replace(/\/+$/, '')}/api/check-signal`;
}

async function triggerRemoteScan(options = {}) {
  const timeoutMs = Number(
    options.timeoutMs ?? process.env.SCAN_TRIGGER_TIMEOUT_MS ?? 60000
  );
  const targetUrl = getCheckSignalUrl();
  const cronSecret = process.env.CRON_SECRET || process.env.CHECK_SIGNAL_SECRET;

  if (!targetUrl) {
    throw new Error('CHECK_SIGNAL_URL is not configured');
  }

  if (!cronSecret) {
    throw new Error('CRON_SECRET is not configured');
  }

  const url = new URL(targetUrl);
  url.searchParams.set('secret', cronSecret);

  const controller = new AbortController();
  const timeoutId = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${cronSecret}`,
      },
    });

    const text = await res.text().catch(() => '');

    return {
      ok: res.ok,
      status: res.status,
      url: url.toString(),
      body: text,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function buildStatusResponse() {
  const scanReport = tracker.getScanReport ? tracker.getScanReport() : null;
  const stats = tracker.getStats ? tracker.getStats() : { global: { total: 0, active: 0, winRate: '0.00%' } };
  const dashboardState = tracker.getDashboardState ? tracker.getDashboardState() : { lastAutoDashboardSentAt: 0 };
  const lastScanAt = scanReport?.finishedAt || scanReport?.startedAt || null;
  const scanAge = lastScanAt ? minutesAgoLabel(lastScanAt) : 'unknown';
  const resetTime = getNextJakartaReset();

  const lines = [
    '🟢 **Bot Status**',
    '',
    `• Active Trades: ${stats.global?.active || 0}`,
    `• SL Hits Today: ${tracker.getGlobalSLCountToday ? `${tracker.getGlobalSLCountToday()}/3` : 'n/a'}`,
    `• Total History: ${stats.global?.total || 0} trades`,
    `• Scan: cron-job.org → Vercel /api/check-signal`,
    `• Alert: Discord Webhook`,
    `• Redis: ${isRedisEnabled() ? 'enabled' : 'disabled'}`,
    `• Last Scan: ${scanReport?.status || 'unknown'} (${scanAge} ago)`,
    `• Reset: ${formatJakartaTime(new Date(resetTime), 'short')} WIB`,
    `• Dashboard Auto: ${dashboardState.lastAutoDashboardSentAt ? `${minutesAgoLabel(dashboardState.lastAutoDashboardSentAt)} ago` : 'never'}`,
  ];

  if (scanReport?.errors?.length) {
    lines.push('', `• Last Errors: ${truncate(scanReport.errors.slice(0, 2).join(' | '), 220)}`);
  }

  return lines.join('\n');
}

function buildActiveResponse() {
  const actives = (tracker.getAllActive ? tracker.getAllActive() : [])
    .slice()
    .sort((a, b) => (b.entryAt || b.signalAt || 0) - (a.entryAt || a.signalAt || 0));

  if (actives.length === 0) {
    return 'Tidak ada active trades sekarang.';
  }

  const lines = ['🟢 **Active Trades**', ''];
  for (const trade of actives.slice(0, 10)) {
    const age = minutesAgoLabel(trade.entryAt || trade.signalAt || trade.timestamp);
    lines.push(
      `• \`${trade.symbol}\` (${trade.bias || 'n/a'}) | entry ${trade.entry ?? 'n/a'} | TP ${trade.take_profit ?? 'n/a'} | SL ${trade.stop_loss ?? 'n/a'} | age ${age}`
    );
  }
  return lines.join('\n');
}

function buildWatchlistResponse() {
  const items = tracker.getWatchlist ? tracker.getWatchlist() : [];
  if (!items || items.length === 0) {
    return 'Watchlist kosong.';
  }

  const lines = ['📋 **Watchlist**', ''];
  for (const item of items.slice(0, 10)) {
    lines.push(`• \`${item.symbol || 'PAIR'}\` | score ${item.score ?? 'n/a'} | ${item.bias || item.quality || 'n/a'}${item.reason ? ` | ${truncate(item.reason, 90)}` : ''}`);
  }
  return lines.join('\n');
}

function buildPerformanceResponse(period = 'all', market = 'combined') {
  const snapshot = tracker.getBinanceSnapshot ? tracker.getBinanceSnapshot() : null;
  const history = tracker.history || [];
  const completed = history.filter((t) => t.status === 'COMPLETED' || t.close_reason);
  const wins = completed.filter((t) => t.close_reason === 'TP_HIT').length;
  const losses = completed.filter((t) => t.close_reason === 'SL_HIT').length;
  const total = completed.length;
  const winRate = total > 0 ? ((wins / total) * 100).toFixed(2) : '0.00';

  const lines = [
    `📊 **Performance** (${period}/${market})`,
    '',
    `• Trades: ${snapshot?.tradesCount ?? total}`,
    `• Win Rate: ${snapshot?.winRate ?? `${winRate}%`}`,
    `• Wins: ${snapshot?.wins ?? wins}`,
    `• Losses: ${snapshot?.losses ?? losses}`,
  ];

  if (snapshot?.generatedAt) {
    lines.push(`• Cached Snapshot: ${snapshot.period || 'n/a'}/${snapshot.market || 'n/a'} @ ${formatJakartaTime(new Date(snapshot.generatedAt), 'short')} WIB`);
  } else {
    lines.push('• Cached Snapshot: belum ada');
  }

  if (snapshot?.latestTrade) {
    const t = snapshot.latestTrade;
    lines.push('', 'Latest trade:');
    lines.push(
      `• \`${t.symbol || 'PAIR'}\` (${t.market || 'n/a'}) | ${t.close_reason || 'n/a'} | PnL ${t.pnl || 'n/a'}`
    );
  } else if (completed[0]) {
    const t = completed[0];
    lines.push('', 'Latest completed trade:');
    lines.push(
      `• \`${t.symbol || 'PAIR'}\` (${t.bias || 'n/a'}) | ${t.close_reason || 'n/a'} | exit ${t.exit_price || 'n/a'}`
    );
  }

  const ledger = snapshot?.tradeLog?.slice(0, 5) || [];
  if (ledger.length > 0) {
    lines.push('', 'Recent ledger:');
    for (const t of ledger) {
      lines.push(`• \`${t.symbol || 'PAIR'}\` (${t.market || 'n/a'}) | ${t.close_reason || 'n/a'} | ${t.pnl || 'n/a'} USDT`);
    }
  }

  return lines.join('\n');
}

function buildLastSignalResponse() {
  const actives = tracker.getAllActive ? tracker.getAllActive() : [];
  const latestActive = actives.slice().sort((a, b) => (b.entryAt || b.signalAt || 0) - (a.entryAt || a.signalAt || 0))[0];
  const latestHistory = tracker.history?.[0] || null;
  const chosen = latestActive || latestHistory;

  const lines = ['🚨 **Last Signal**', ''];
  lines.push(formatSignalLine(chosen));
  return lines.join('\n');
}

function buildHealthResponse() {
  const scanReport = tracker.getScanReport ? tracker.getScanReport() : null;
  const parts = [
    '🩺 **Health**',
    '',
    `• Runtime: ${process.env.VERCEL ? 'Vercel' : 'local'}`,
    `• Region: ${process.env.VERCEL_REGION || process.env.AWS_REGION || 'unknown'}`,
    `• Discord Webhook: ${(process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_SIGNAL_WEBHOOK_URL) ? 'set' : 'missing'}`,
    `• Discord Public Key: ${process.env.DISCORD_PUBLIC_KEY ? 'set' : 'missing'}`,
    `• Cron Secret: ${process.env.CRON_SECRET ? 'set' : 'missing'}`,
    `• Redis: ${isRedisEnabled() ? 'enabled' : 'disabled'}`,
    `• Scan Report: ${scanReport?.status || 'none'}`,
    `• Last Scan Duration: ${scanReport?.durationMs ? `${Math.round(scanReport.durationMs / 1000)}s` : 'n/a'}`,
    `• Active Signals: ${(tracker.getAllActive ? tracker.getAllActive().length : 0)}`,
  ];

  return parts.join('\n');
}

function buildLogResponse() {
  const scanReport = tracker.getScanReport ? tracker.getScanReport() : null;
  const providerHealth = scanReport?.providerHealth || null;
  const recentErrors = Array.isArray(scanReport?.errors) ? scanReport.errors : [];
  const recentEvents = Array.isArray(providerHealth?.recentEvents) ? providerHealth.recentEvents : [];
  const fallbackEvents = recentEvents.filter((event) => ['blocked', 'degraded', 'missing-symbol'].includes(event.status));

  const lines = [
    '📋 **Scan Log**',
    '',
    `• Status: ${scanReport?.status || 'unknown'}`,
    `• Signals: ${scanReport?.signalCount ?? 0}`,
    `• Duration: ${scanReport?.durationMs ? `${Math.round(scanReport.durationMs / 1000)}s` : 'n/a'}`,
    `• Provider fallback events: ${fallbackEvents.length}`,
    `• Recent errors: ${recentErrors.length}`,
  ];

  if (recentErrors.length > 0) {
    lines.push('', 'Recent errors:');
    for (const err of recentErrors.slice(0, 5)) {
      lines.push(`• ${truncate(err, 130)}`);
    }
  }

  if (fallbackEvents.length > 0) {
    lines.push('', 'Recent provider events:');
    for (const event of fallbackEvents.slice(-5)) {
      lines.push(`• ${event.method}/${event.provider} (${event.status}) - ${truncate(event.message, 110)}`);
    }
  }

  if (lines.length <= 6) {
    lines.push('', 'Belum ada log scan yang berguna.');
  }

  return lines.join('\n');
}

async function sendRawScanReportToDiscord(context = {}) {
  const logger = context.logger || console;
  const exportData = buildLatestScanReportExport(tracker);

  if (!exportData) {
    throw new Error('No scan report available yet');
  }

  const scanReport = exportData.payload?.scanReport || {};
  const phaseBreakdown = scanReport.phaseBreakdown || {};
  const webhookUrl = process.env.DISCORD_STATUS_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_SIGNAL_WEBHOOK_URL;

  if (!webhookUrl) {
    throw new Error('Discord webhook is not configured');
  }

  const caption = [
    '📄 Raw scan report JSON',
    `• Status: ${scanReport.status || 'unknown'}`,
    `• Signals: ${scanReport.signalCount ?? 0} | Watchlist: ${scanReport.watchlistCount ?? 0} | Candidates: ${scanReport.candidateCount ?? 0}`,
    `• Phase: pre-filter ${phaseBreakdown.preFilterPassed ?? 0}/${phaseBreakdown.preFilterRejected ?? 0} | strategy rejected ${phaseBreakdown.strategyRejected ?? 0}`,
    `• Exported: ${exportData.payload?.meta?.exportedAtJakarta || 'unknown'} WIB`,
  ].join('\n');

  await postWebhookWithFile(webhookUrl, { content: caption }, exportData.filePath, {
    filename: exportData.fileName,
    contentType: 'application/json',
    cleanupFile: true,
  });

  logger.info?.(`[discord/scan-raw] exported ${exportData.fileName} (${Math.round(exportData.size / 1024)} KB)`);
  return exportData;
}

function buildHelpResponse() {
  const lines = [
    '🤖 **Discord Commands**',
    '',
    '• `/status` - bot health dan status scan',
    '• `/scan-now` - trigger scan sekali',
    '• `/scan-raw` - download latest raw scan report as JSON',
    '• `/active` - list active trades',
    '• `/watchlist` - latest watchlist',
    '• `/performance` - cached performance summary',
    '• `/last-signal` - signal terakhir',
    '• `/health` - environment/service health',
    '• `/log` - scan log summary',
    '• `/help` - list command',
    '',
    'Scan hasilnya akan dikirim lewat Discord webhook yang sama.',
  ];

  return lines.join('\n');
}

function buildInteractionResponse(content, options = {}) {
  return {
    type: 4,
    data: {
      content: truncate(content, options.maxChars || 1800),
      flags: options.ephemeral ? 64 : 0,
      allowed_mentions: { parse: [] },
    },
  };
}

async function handleInteraction(interaction, context = {}) {
  const commandName = String(interaction?.data?.name || '').toLowerCase();
  const options = Array.isArray(interaction?.data?.options) ? interaction.data.options : [];
  const getOption = (name) => options.find((option) => option.name === name)?.value;

  if (commandName === 'scan-now') {
    const logger = context.logger || console;
    try {
      void triggerRemoteScan()
        .then((result) => {
          const summary = result.ok
            ? `✅ Scan request sent (${result.status})`
            : `⚠️ Scan request returned ${result.status}`;
          logger.info?.(`[discord/scan-now] ${summary}`);
          if (!result.ok) {
            logger.warn?.(`[discord/scan-now] Response: ${truncate(result.body || '(empty)', 500)}`);
          }
        })
        .catch((err) => {
          logger.error?.(`[discord/scan-now] triggerRemoteScan failed: ${err.message}`);
        });

      return buildInteractionResponse(
        '✅ Scan request queued. Hasil final akan muncul lewat webhook.',
        { ephemeral: true }
      );
    } catch (err) {
      logger.error?.(`[discord/scan-now] triggerRemoteScan failed: ${err.message}`);
      return buildInteractionResponse(
        `❌ Scan trigger gagal: ${err.message}`,
        { ephemeral: true }
      );
    }
  }

  if (commandName === 'performance') {
    return buildInteractionResponse(
      buildPerformanceResponse(getOption('period') || 'all', getOption('market') || 'combined'),
      { ephemeral: true, maxChars: 1900 }
    );
  }

  if (commandName === 'scan-raw' || commandName === 'scanraw') {
    const logger = context.logger || console;
    void sendRawScanReportToDiscord({ logger })
      .catch((err) => {
        logger.error?.(`[discord/scan-raw] failed: ${err.message}`);
      });

    return buildInteractionResponse(
      '✅ Raw scan report lagi dikirim ke channel sebagai file JSON.',
      { ephemeral: true }
    );
  }

  if (commandName === 'status') return buildInteractionResponse(buildStatusResponse(), { ephemeral: true });
  if (commandName === 'active') return buildInteractionResponse(buildActiveResponse(), { ephemeral: true });
  if (commandName === 'watchlist') return buildInteractionResponse(buildWatchlistResponse(), { ephemeral: true });
  if (commandName === 'last-signal') return buildInteractionResponse(buildLastSignalResponse(), { ephemeral: true });
  if (commandName === 'health') return buildInteractionResponse(buildHealthResponse(), { ephemeral: true });
  if (commandName === 'log') return buildInteractionResponse(buildLogResponse(), { ephemeral: true });
  if (commandName === 'help') return buildInteractionResponse(buildHelpResponse(), { ephemeral: true });

  return buildInteractionResponse(`Unknown command: ${commandName || '(empty)'}`, { ephemeral: true });
}

function verifyDiscordRequest({ signature, timestamp, body, publicKeyHex }) {
  if (!signature || !timestamp || !publicKeyHex) return false;

  try {
    const normalizedPublicKey = String(publicKeyHex).replace(/\s+/g, '').replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]{64}$/.test(normalizedPublicKey)) {
      return false;
    }

    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(normalizedPublicKey, 'hex'),
      ]),
      format: 'der',
      type: 'spki',
    });

    return crypto.verify(
      null,
      Buffer.from(timestamp + body),
      publicKey,
      Buffer.from(signature, 'hex')
    );
  } catch (err) {
    return false;
  }
}

function getDiscordCommandDefinitions() {
  return COMMANDS;
}

module.exports = {
  buildActiveResponse,
  buildHelpResponse,
  buildHealthResponse,
  buildLogResponse,
  buildInteractionResponse,
  buildLastSignalResponse,
  buildPerformanceResponse,
  buildStatusResponse,
  buildWatchlistResponse,
  getDiscordCommandDefinitions,
  getCheckSignalUrl,
  handleInteraction,
  hydrateTracker,
  sendRawScanReportToDiscord,
  verifyDiscordRequest,
  triggerRemoteScan,
};
