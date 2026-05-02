/**
 * run_once.js — One-shot entry point for GitHub Actions cron job.
 *
 * Flow:
 *   1. Load state from Upstash Redis (falls back to local JSON if no Redis)
 *   2. Init Discord (send-only, no polling)
 *   3. Run one full scan cycle
 *   4. Final sync state back to Redis
 *   5. Exit cleanly
 */

require('dotenv').config();

const logger = require('./utils/logger');
const tracker = require('./modules/tracker');
const { runScanCycle } = require('./modules/scanner');
const { initAudit } = require('./utils/audit');
const { sendStatus } = require('./utils/discord');

async function main() {
  const startMs = Date.now();
  console.log('🚀 [run_once] Starting one-shot scan cycle...');
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Redis: ${process.env.UPSTASH_REDIS_REST_URL ? '✅ configured' : '⚠️  not set (using local files)'}`);
  console.log(`   Discord: ${process.env.DISCORD_SIGNAL_WEBHOOK_URL ? '✅ configured' : '❌ not set'}`);

  // 1. Load state from Redis
  await tracker.syncFromRedis();

  // 2. Init audit log
  initAudit();

  // 3. Notify start (optional, comment out if too noisy)
  try {
    await sendStatus(
      `🤖 **Crypto Signal Bot** — Scan cycle started\n` +
      `_GitHub Actions cron triggered at ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB_`
    );
  } catch (err) {
    logger.warn('Discord startup notification failed (non-fatal):', err.message);
  }

  // 4. Run the scan
  let signalCount = 0;
  try {
    signalCount = await runScanCycle();
  } catch (err) {
    logger.error('❌ runScanCycle() threw an error:', err);
    await sendStatus(`❌ **Scan cycle error:** \`${err.message}\``).catch(() => {});
    // Still try to save state before exiting
    await tracker.syncToRedis().catch(e => logger.error('Final Redis sync failed:', e.message));
    process.exit(1);
  }

  // 5. Final state push to Redis
  await tracker.syncToRedis();

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  logger.info(`✅ [run_once] Done. ${signalCount} signal(s) sent. Total time: ${elapsed}s`);

  process.exit(0);
}

// Handle unexpected crashes
process.on('unhandledRejection', async (reason) => {
  logger.error('Unhandled rejection in run_once:', reason);
  await tracker.syncToRedis().catch(() => {});
  process.exit(1);
});

main();
