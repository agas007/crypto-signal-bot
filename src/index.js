const logger = require('./utils/logger');
const { startScanner } = require('./modules/scanner');
const { initTelegram } = require('./modules/telegram');
const { startDashboard } = require('./web/server');
const enableBackgroundRuntime = process.env.DISABLE_BACKGROUND_RUNTIME !== '1' && process.env.ENABLE_LEGACY_SCANNER !== '0';

console.log('🤖 CRYPTO SIGNAL BOT v4.4.1 STARTED');

async function main() {
  try {
    startDashboard(); // Jalankan Dashboard
    if (enableBackgroundRuntime) {
      await initTelegram(); // Jalankan Telegram Bot
      await startScanner(); // Jalankan Market Scanner
    } else {
      logger.info('Background runtime disabled. Use /api/check-signal for one-shot serverless runs.');
    }
  } catch (err) {
    logger.error('Fatal error:', err);
    process.exit(1);
  }
}

main();
