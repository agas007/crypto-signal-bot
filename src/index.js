const logger = require('./utils/logger');
const { startScanner } = require('./modules/scanner');
const { initTelegram } = require('./modules/telegram');
const { startDashboard } = require('./web/server');
const enableLegacyScanner = process.env.ENABLE_LEGACY_SCANNER === '1';

console.log('🤖 CRYPTO SIGNAL BOT v4.4.1 STARTED');

async function main() {
  try {
    startDashboard(); // Jalankan Dashboard
    if (enableLegacyScanner) {
      await initTelegram();   // Jalankan Telegram Bot
      await startScanner(); // Jalankan Market Scanner
    } else {
      logger.info('Legacy scanner disabled. Use /api/check-signal for one-shot serverless runs.');
    }
  } catch (err) {
    logger.error('Fatal error:', err);
    process.exit(1);
  }
}

main();
