const tracker = require('../modules/tracker');
const { sendStatus } = require('./signal_delivery');
const { formatJakartaTime } = require('../utils/time');

function getJakartaDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
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

function formatProviderFallbackMessage(report) {
  const health = report?.providerHealth || null;
  if (!health) return null;

  const blocked = Array.isArray(health.blockedProviders) ? health.blockedProviders : [];
  const recent = Array.isArray(health.recentEvents) ? health.recentEvents : [];
  const fallbackEvents = recent.filter((event) => ['blocked', 'degraded', 'missing-symbol'].includes(event.status));
  const activeBlocked = blocked.length > 0 ? blocked.join(', ') : 'none';

  if (blocked.length === 0 && fallbackEvents.length < 3) {
    return null;
  }

  const latest = fallbackEvents.slice(-3).map((event) => {
    return `• ${event.method}/${event.provider}: ${event.status} - ${event.message}`;
  });

  return [
    '⚠️ **Provider Fallback Alert**',
    '',
    `• Blocked providers: ${activeBlocked}`,
    `• Recent fallback events: ${fallbackEvents.length}`,
    ...latest,
  ].join('\n');
}

function buildScanSummary(report) {
  const lines = [
    '🧭 **Scan Summary**',
    '',
    `• Status: ${report?.status || 'UNKNOWN'}`,
    `• Signals: ${report?.signalCount ?? 0}`,
    `• Watchlist: ${report?.watchlistCount ?? 0}`,
    `• Candidates: ${report?.candidateCount ?? 0}`,
    `• Errors: ${report?.errorCount ?? 0}`,
    `• Duration: ${report?.durationMs ? `${Math.round(report.durationMs / 1000)}s` : 'n/a'}`,
  ];

  const providerMessage = formatProviderFallbackMessage(report);
  if (providerMessage) {
    lines.push('', providerMessage);
  }

  if (report?.errors?.length) {
    lines.push('', 'Latest errors:');
    for (const err of report.errors.slice(0, 2)) {
      lines.push(`• ${err}`);
    }
  }

  return lines.join('\n');
}

function buildHealthPing(report) {
  return [
    '🩺 **Health Ping**',
    '',
    `• Cron finished with no signal`,
    `• Status: ${report?.status || 'NO_SIGNAL'}`,
    `• Errors: ${report?.errorCount ?? 0}`,
    `• Scan age: ${minutesAgoLabel(report?.finishedAt || report?.startedAt)}`,
  ].join('\n');
}

function buildDailySummary(report) {
  const stats = tracker.getStats ? tracker.getStats() : { global: { active: 0, total: 0, winRate: '0.00%' } };
  const snapshot = tracker.getBinanceSnapshot ? tracker.getBinanceSnapshot() : null;
  const completed = tracker.history?.filter((t) => t.status === 'COMPLETED' || t.close_reason) || [];
  const wins = completed.filter((t) => t.close_reason === 'TP_HIT').length;
  const losses = completed.filter((t) => t.close_reason === 'SL_HIT').length;
  const todayKey = getJakartaDateKey();

  const lines = [
    `📅 **Daily Summary** - ${todayKey} WIB`,
    '',
    `• Active Trades: ${stats.global?.active || 0}`,
    `• Total History: ${stats.global?.total || 0}`,
    `• Win Rate: ${stats.global?.winRate || '0.00%'}`,
    `• Wins / Losses: ${wins} / ${losses}`,
    `• Last Scan: ${report?.status || 'UNKNOWN'} (${report?.signalCount ?? 0} signals)`,
  ];

  if (snapshot?.generatedAt) {
    lines.push(`• Latest Performance Snapshot: ${snapshot.period || 'n/a'}/${snapshot.market || 'n/a'} @ ${formatJakartaTime(new Date(snapshot.generatedAt), 'short')} WIB`);
  }

  return lines.join('\n');
}

async function maybeSendDiscordNotifications(report) {
  if (!report) return;

  const dashboardState = tracker.getDashboardState ? tracker.getDashboardState() : {};
  const todayKey = getJakartaDateKey();
  const lastSummaryDate = dashboardState.lastDailySummaryDate || '';
  const summaryFingerprint = [
    report.status || 'UNKNOWN',
    report.signalCount || 0,
    report.errorCount || 0,
    (report.providerHealth?.blockedProviders || []).join(','),
  ].join('|');

  const shouldSendScanSummary =
    summaryFingerprint !== (dashboardState.lastScanSummaryFingerprint || '') &&
    (report.signalCount > 0 || report.errorCount > 0 || (report.providerHealth?.blockedProviders || []).length > 0 || report.status === 'WATCHLIST_ONLY');

  if (shouldSendScanSummary) {
    await sendStatus(buildScanSummary(report));
    tracker.setDashboardState({
      ...(tracker.getDashboardState ? tracker.getDashboardState() : {}),
      lastScanSummaryFingerprint: summaryFingerprint,
      lastScanSummaryAt: Date.now(),
    });
  }

  if ((report.signalCount || 0) === 0 && (report.status === 'NO_SIGNAL' || report.status === 'NO_SIGNAL_WITH_ERRORS')) {
    const lastHealthPingDate = dashboardState.lastHealthPingDate || '';
    if (lastHealthPingDate !== todayKey && lastSummaryDate !== todayKey) {
      await sendStatus(buildHealthPing(report));
      tracker.setDashboardState({
        ...(tracker.getDashboardState ? tracker.getDashboardState() : {}),
        lastHealthPingDate: todayKey,
        lastHealthPingAt: Date.now(),
      });
    }
  }

  if (lastSummaryDate !== todayKey) {
    await sendStatus(buildDailySummary(report));
    tracker.setDashboardState({
      ...(tracker.getDashboardState ? tracker.getDashboardState() : {}),
      lastDailySummaryDate: todayKey,
      lastDailySummaryAt: Date.now(),
    });
  }
}

module.exports = {
  buildDailySummary,
  buildHealthPing,
  buildScanSummary,
  maybeSendDiscordNotifications,
};
