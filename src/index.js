const logger = require('./utils/logger');
const { startScanner } = require('./modules/scanner');
const { initTelegram } = require('./modules/telegram');

// ─── Banner ─────────────────────────────────────────────
console.log(`
╔═══════════════════════════════════════════╗
║      🤖 CRYPTO SIGNAL BOT v2.1.0         ║
║                                           ║
║  Binance → TA → AI → Telegram             ║
║  Multi-TF: D1 · H4 · M15                  ║
║  Mode: Balanced (confluence scoring)       ║
╚═══════════════════════════════════════════╝
`);

// ─── Graceful shutdown ──────────────────────────────────
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down...');
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection:', err);
});

// ─── Start ──────────────────────────────────────────────
async function main() {
  try {
    initTelegram();

    if (process.env.MODE === 'oneshot') {
      logger.info('Running in ONESHOT mode...');
      const { runScanCycle } = require('./modules/scanner');
      await runScanCycle();
      logger.info('Oneshot cycle complete. Exiting.');
      process.exit(0);
    } else {
      await startScanner();
    }
  } catch (err) {
    logger.error('Fatal error:', err);
    process.exit(1);
  }
}

main();
