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
  const phaseBreakdown = report?.phaseBreakdown || {};
  const topFailurePhase = report?.summary?.topFailurePhase || (() => {
    const phases = [
      { label: 'Pre-filter', count: Number(phaseBreakdown.preFilterRejected) || 0 },
      { label: 'Strategy', count: Number(phaseBreakdown.strategyRejected) || 0 },
      { label: 'AI', count: Number(phaseBreakdown.aiRejected) || 0 },
      { label: 'Confirmation', count: Number(phaseBreakdown.confirmationRejected) || 0 },
    ].sort((a, b) => b.count - a.count);
    const top = phases[0];
    return top && top.count > 0 ? `${top.label} (${top.count})` : null;
  })();

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

  if (report?.adaptiveTuning?.status) {
    lines.push(
      '',
      '🧠 AI Tuning',
      `• Status: ${report.adaptiveTuning.status}`,
      `• Confidence: ${Number.isFinite(report.adaptiveTuning.confidence) ? `${Math.round(report.adaptiveTuning.confidence * 100)}%` : 'n/a'}`,
      `• Reason: ${report.adaptiveTuning.reason || 'n/a'}`,
    );
  }

  if (phaseBreakdown) {
    lines.push(
      '',
      '🧩 Phase Breakdown',
      `• Pre-filter passed: ${phaseBreakdown.preFilterPassed ?? 0}`,
      `• Pre-filter rejected: ${phaseBreakdown.preFilterRejected ?? 0}`,
      `• Strategy candidate: ${phaseBreakdown.strategyCandidate ?? 0}`,
      `• Strategy watchlist: ${phaseBreakdown.strategyWatchlist ?? 0}`,
      `• Strategy rejected: ${phaseBreakdown.strategyRejected ?? 0}`,
      `• AI watchlist: ${phaseBreakdown.aiWatchlist ?? 0}`,
      `• AI rejected: ${phaseBreakdown.aiRejected ?? 0}`,
      `• Confirmation rejected: ${phaseBreakdown.confirmationRejected ?? 0}`,
      `• Delivered: ${phaseBreakdown.delivered ?? 0}`,
    );
  }

  if (topFailurePhase) {
    lines.push('', `🔥 Top Failure Phase: ${topFailurePhase}`);
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
