const express = require('express');
const next = require('next');
const logger = require('./src/utils/logger');
const { startScanner } = require('./src/modules/scanner');
const { initTelegram } = require('./src/modules/telegram');

// Configure Next.js
const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev, dir: './dashboard' }); // Point Next.js to the dashboard folder
const handle = app.getRequestHandler();

console.log('🤖 CRYPTO SIGNAL BOT (Copilot Mode) BOOTING...');

app.prepare().then(() => {
  const server = express();

  // Forward all HTTP requests to Next.js (including /api/signals)
  server.all(/.*/, (req, res) => {
    return handle(req, res);
  });

  const port = process.env.PORT || 3000;
  server.listen(port, '0.0.0.0', async (err) => {
    if (err) {
      logger.error('Failed to start HTTP server:', err);
      return;
    }
    logger.info(`> 🚀 Next.js Dashboard Ready on http://localhost:${port}`);
    
    // Start Bot Backend Services safely in the background
    try {
      await initTelegram();
      startScanner();
      logger.info('✅ Background services (Telegram & Scanner) started.');
    } catch (err) {
      logger.error('Failed to start background services:', err);
    }
  });
}).catch((err) => {
  logger.error('Error starting server:', err);
  process.exit(1);
});
