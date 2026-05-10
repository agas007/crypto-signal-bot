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
    '⚠️ Provider Fallback Alert',
    '',
    `• Blocked providers: ${activeBlocked}`,
    `• Recent fallback events: ${fallbackEvents.length}`,
    ...latest,
  ].join('\n');
}

function buildScanSummary(report) {
  const lines = [
    '🧭 Scan Summary',
    '',
    `• Status: ${report?.status || 'UNKNOWN'}`,
    `• Signals: ${report?.signalCount ?? 0}`,
    `• Watchlist: ${report?.watchlistCount ?? 0}`,
    `• Candidates: ${report?.candidateCount ?? 0}`,
    `• Errors: ${report?.errorCount ?? 0}`,
    `• Duration: ${report?.durationMs ? `${Math.round(report.durationMs / 1000)}s` : 'n/a'}`,
  ];

  const lessonSummary = report?.lessonSummary || null;
  const thresholds = report?.adaptiveThresholds || lessonSummary?.thresholds || null;
  const topRejectReasons = Array.isArray(lessonSummary?.topRejectReasons) ? lessonSummary.topRejectReasons : [];

  if (thresholds) {
    lines.push(
      '',
      '🧪 Adaptive Thresholds',
      `• Min R:R: ${Number.isFinite(thresholds.minRrRatio) ? thresholds.minRrRatio.toFixed(1) : 'n/a'}`,
      `• Min score: ${Number.isFinite(thresholds.minFinalScore) ? thresholds.minFinalScore : 'n/a'}`,
      `• Standby R:R: ${Number.isFinite(thresholds.standbyMinRr) ? thresholds.standbyMinRr.toFixed(1) : 'n/a'}`,
    );
  }

  const phases = report?.phaseBreakdown || null;
  if (phases) {
    lines.push(
      '',
      '🧩 Phase Breakdown',
      `• Pre-filter passed: ${phases.preFilterPassed ?? 0}`,
      `• Pre-filter rejected: ${phases.preFilterRejected ?? 0}`,
      `• Strategy candidate: ${phases.strategyCandidate ?? 0}`,
      `• Strategy watchlist: ${phases.strategyWatchlist ?? 0}`,
      `• Strategy rejected: ${phases.strategyRejected ?? 0}`,
      `• AI watchlist: ${phases.aiWatchlist ?? 0}`,
      `• AI rejected: ${phases.aiRejected ?? 0}`,
      `• Confirmation rejected: ${phases.confirmationRejected ?? 0}`,
      `• Delivered: ${phases.delivered ?? 0}`,
    );
  }

  if (topRejectReasons.length > 0) {
    lines.push('', '📉 Top Reject Reasons Today');
    for (const reason of topRejectReasons.slice(0, 3)) {
      const examples = Array.isArray(reason.symbols) && reason.symbols.length > 0
        ? ` | ${reason.symbols.slice(0, 3).join(', ')}`
        : '';
      lines.push(`• ${reason.rank}. ${reason.label}: ${reason.count}${examples}`);
    }
  }

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
