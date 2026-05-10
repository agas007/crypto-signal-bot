/**
 * run_once.js — One-shot entry point for manual or external cron triggers.
 */

require('dotenv').config();

const logger = require('./utils/logger');
const { sendStatus } = require('./services/signal_delivery');
const { runSignalCheck } = require('./services/run_signal_check');
globalThis.__cryptoSignalGenerateChartImage = require('./modules/chart').generateChartImage;

async function main() {
  const startMs = Date.now();
  console.log('🚀 [run_once] Starting one-shot scan cycle...');
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Redis: ${process.env.UPSTASH_REDIS_REST_URL ? '✅ configured' : '⚠️  not set (using local files)'}`);
  console.log(`   Telegram: ${(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) ? '✅ configured' : '⚠️ not set'}`);
  console.log(`   Discord: ${(process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_SIGNAL_WEBHOOK_URL) ? '✅ configured' : '⚠️ not set'}`);

  // 1. Notify start (optional, comment out if too noisy)
  try {
    await sendStatus(
      `🤖 **Crypto Signal Bot** — Scan cycle started\n` +
      `_Triggered at ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB_`
    );
  } catch (err) {
    logger.warn('Startup notification failed (non-fatal):', err.message);
  }

  // 2. Run the scan
  let signalCount = 0;
  try {
    const result = await runSignalCheck();
    signalCount = result.signalCount;
  } catch (err) {
    logger.error('❌ runSignalCheck() threw an error:', err);
    await sendStatus(`❌ **Scan cycle error:** \`${err.message}\``).catch(() => {});
    process.exit(1);
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  logger.info(`✅ [run_once] Done. ${signalCount} signal(s) sent. Total time: ${elapsed}s`);

  process.exit(0);
}

// Handle unexpected crashes
process.on('unhandledRejection', async (reason) => {
  logger.error('Unhandled rejection in run_once:', reason);
  process.exit(1);
});

main();
