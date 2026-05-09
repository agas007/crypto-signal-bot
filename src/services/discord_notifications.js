const { sendStatus } = require('./signal_delivery');

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
    '⚠️ *Provider Fallback Alert*',
    '',
    `• Blocked providers: ${activeBlocked}`,
    `• Recent fallback events: ${fallbackEvents.length}`,
    ...latest,
  ].join('\n');
}

function buildScanSummary(report) {
  const lines = [
    '🧭 *Scan Summary*',
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

async function maybeSendDiscordNotifications(report) {
  if (!report) return;

  await sendStatus(buildScanSummary(report));
}

module.exports = {
  buildScanSummary,
  maybeSendDiscordNotifications,
};
