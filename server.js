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
      console.error('❌ FATAL: Failed to start HTTP server:', err);
      return;
    }
    
    console.log(`> 🚀 Server is listening on PORT: ${port}`);
    console.log(`> 🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    
    // Check if dashboard directory exists (debugging for Railway)
    const fs = require('fs');
    const path = require('path');
    const dashboardPath = path.join(__dirname, 'dashboard');
    if (!fs.existsSync(dashboardPath)) {
      console.error('❌ ERROR: Dashboard directory NOT FOUND at', dashboardPath);
    } else {
      console.log('✅ Dashboard directory found.');
    }

    // Start Bot Backend Services safely in the background
    try {
      console.log('🤖 Initializing Telegram & Scanner...');
      await initTelegram();
      startScanner();
      console.log('✅ Background services (Telegram & Scanner) are now active.');
    } catch (err) {
      console.error('❌ ERROR: Failed to start background services:', err);
    }
  });
}).catch((err) => {
  logger.error('Error starting server:', err);
  process.exit(1);
});
