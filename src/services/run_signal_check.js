const logger = require('../utils/logger');
const tracker = require('../modules/tracker');
const { initAudit } = require('../utils/audit');
const { runScanCycle } = require('../modules/scanner');
const { maybeSendDiscordNotifications } = require('./discord_notifications');

async function runSignalCheck() {
  const startedAt = Date.now();
  const prevSkipLiveConfirmation = process.env.SKIP_LIVE_CONFIRMATION;

  logger.info('🚀 [runSignalCheck] Starting one-shot signal check...');

  await tracker.syncFromRedis().catch((err) => {
    logger.warn(`[runSignalCheck] syncFromRedis failed: ${err.message}`);
  });

  initAudit();

  let signalCount = 0;
  let scanError = null;

  try {
    process.env.SKIP_LIVE_CONFIRMATION = '1';
    signalCount = await runScanCycle();
  } catch (err) {
    scanError = err;
    logger.error('[runSignalCheck] runScanCycle failed:', err);
    throw err;
  } finally {
    if (prevSkipLiveConfirmation === undefined) {
      delete process.env.SKIP_LIVE_CONFIRMATION;
    } else {
      process.env.SKIP_LIVE_CONFIRMATION = prevSkipLiveConfirmation;
    }

    await tracker.syncToRedis().catch((err) => {
      logger.warn(`[runSignalCheck] syncToRedis failed: ${err.message}`);
    });
  }

  const report = tracker.getScanReport();
  await maybeSendDiscordNotifications(report).catch((err) => {
    logger.warn(`[runSignalCheck] discord notifications skipped: ${err.message}`);
  });
  const finishedAt = Date.now();

  return {
    ok: !scanError,
    signalCount,
    report,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
  };
}

module.exports = { runSignalCheck };
