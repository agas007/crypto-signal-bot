const logger = require('./utils/logger');
const { startScanner } = require('./modules/scanner');
const { initTelegram } = require('./modules/telegram');
const { startDashboard } = require('./web/server');

console.log('🤖 CRYPTO SIGNAL BOT v4.4.1 STARTED');

async function main() {
  try {
    startDashboard(); // Jalankan Dashboard
    await initTelegram();   // Jalankan Telegram Bot
    await startScanner(); // Jalankan Market Scanner
  } catch (err) {
    logger.error('Fatal error:', err);
    process.exit(1);
  }
}

main();
