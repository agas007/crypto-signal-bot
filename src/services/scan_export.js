const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { formatJakartaTime } = require('../utils/time');

function pad2(value) {
  return String(value).padStart(2, '0');
}

function getJakartaStamp(timestamp = Date.now()) {
  const jakartaDate = new Date(Number(timestamp) + (7 * 60 * 60 * 1000));
  return [
    jakartaDate.getUTCFullYear(),
    pad2(jakartaDate.getUTCMonth() + 1),
    pad2(jakartaDate.getUTCDate()),
  ].join('') + `-${pad2(jakartaDate.getUTCHours())}${pad2(jakartaDate.getUTCMinutes())}${pad2(jakartaDate.getUTCSeconds())}`;
}

function sanitizeFilePart(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function buildLatestScanReportExport(tracker, options = {}) {
  const scanReport = tracker?.getScanReport ? tracker.getScanReport() : null;
  if (!scanReport) return null;

  const exportedAt = Date.now();
  const exportedAtJakarta = formatJakartaTime(new Date(exportedAt), 'readable');
  const fileName = options.fileName || [
    'scan-report-raw',
    sanitizeFilePart(scanReport.status || 'unknown'),
    getJakartaStamp(exportedAt),
    crypto.randomBytes(2).toString('hex'),
  ].join('-') + '.json';

  const payload = {
    meta: {
      source: 'latest-scan-report',
      exportedAt,
      exportedAtJakarta,
      sourceStatus: scanReport.status || 'unknown',
      sourceStartedAt: scanReport.startedAt || null,
      sourceFinishedAt: scanReport.finishedAt || null,
      sourceSignalCount: Number(scanReport.signalCount) || 0,
      sourceWatchlistCount: Number(scanReport.watchlistCount) || 0,
      sourceCandidateCount: Number(scanReport.candidateCount) || 0,
      sourceErrorCount: Number(scanReport.errorCount) || 0,
      sourceTopFailurePhase: scanReport.summary?.topFailurePhase || null,
      sourceDurationMs: Number(scanReport.durationMs) || null,
    },
    scanReport,
  };

  const filePath = path.join(os.tmpdir(), fileName);
  const fileContents = JSON.stringify(payload, null, 2);
  fs.writeFileSync(filePath, fileContents);

  return {
    fileName,
    filePath,
    payload,
    size: Buffer.byteLength(fileContents),
  };
}

function cleanupExportFile(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (_) {
    // Best effort cleanup only.
  }
}

module.exports = {
  buildLatestScanReportExport,
  cleanupExportFile,
  getJakartaStamp,
};
