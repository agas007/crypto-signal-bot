const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const logger = require('../../utils/logger');

/**
 * Generate a high-quality chart image for a signal with Entry, TP, and SL markers.
 * 
 * @param {string} symbol
 * @param {Array} candles - OHLCV data array
 * @param {Object} signal - { bias, riskReward: { entry, tp, sl } }
 * @returns {Promise<string>} Path to the generated image
 */
async function generateChartImage(symbol, candles, signal) {
  // Handle both raw signal structure and refined signal structure
  const entry = signal.entry || (signal.riskReward && signal.riskReward.entry);
  const tp = signal.take_profit || (signal.riskReward && signal.riskReward.tp);
  const sl = signal.stop_loss || (signal.riskReward && signal.riskReward.sl);

  if (!entry || !tp || !sl) {
    logger.error(`❌ Cannot generate chart for ${symbol}: Missing price levels`, { entry, tp, sl });
    return null;
  }

  const bias = signal.bias;

  // Map and SORT candles to strictly increasing time (mandatory for Lightweight Charts)
  const chartData = candles
    .map(c => ({
      time: Math.floor(c.openTime / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close
    }))
    .sort((a, b) => a.time - b.time);

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <script src="https://unpkg.com/lightweight-charts@4.1.1/dist/lightweight-charts.standalone.production.js"></script>
  <style>
    body { background: #0c0c0c; margin: 0; padding: 0; width: 1024px; height: 512px; font-family: sans-serif; }
    #chart { width: 1000px; height: 500px; margin: 6px; }
  </style>
</head>
<body>
  <div id="chart"></div>
  <script>
    console.log("🚀 Starting Chart Render...");
    const container = document.getElementById('chart');
    const chart = LightweightCharts.createChart(container, {
      width: 1000,
      height: 500,
      layout: { background: { type: 'solid', color: '#0c0c0c' }, textColor: '#d1d4dc' },
      grid: { vertLines: { color: '#1f222d' }, horzLines: { color: '#1f222d' } },
      timeScale: { borderColor: '#485c7b', timeVisible: true },
    });

    const candlestickSeries = chart.addCandlestickSeries({
      upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
      wickUpColor: '#26a69a', wickDownColor: '#ef5350',
      priceFormat: {
        type: 'price',
        precision: 8,
        minMove: 0.00000001,
      },
    });

    // Also update price scale precision
    chart.priceScale().applyOptions({
        autoScale: true,
        borderColor: '#485c7b',
    });

    const data = ${JSON.stringify(chartData)};
    console.log("📦 Data Points:", data.length);
    
    candlestickSeries.setData(data);

    // Add Markers (Lines) for SL, TP, and Entry
    const addLine = (price, color, title) => {
      candlestickSeries.createPriceLine({
        price: price,
        color: color,
        lineWidth: 2,
        lineStyle: 1, // Dashed
        axisLabelVisible: true,
        title: title,
      });
    };

    addLine(${entry}, '#bbbbbb', ' ENTRY');
    addLine(${tp}, '#26a69a', ' TP (TAKE PROFIT)');
    addLine(${sl}, '#ef5350', ' SL (STOP LOSS)');

    chart.timeScale().fitContent();
    console.log("✅ Render Finished!");
  </script>
</body>
</html>
  `;

  let browser;
  try {
    const tmpDir = path.join(process.cwd(), 'tmp_charts');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

    const filename = `${symbol}_${Date.now()}.jpg`;
    const imagePath = path.join(tmpDir, filename);

    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    
    // Catch errors from the browser's console
    page.on('console', msg => logger.debug(`🌐 BROWSER: ${msg.text()}`));
    page.on('pageerror', err => logger.error(`🔥 BROWSER_ERROR: ${err.message}`));

    await page.setViewport({ width: 1024, height: 512 });
    
    // Debug: log first few data points
    logger.debug(`📊 Rendering ${chartData.length} candles for ${symbol}. First: ${JSON.stringify(chartData[0])}`);

    // Set content and wait for the library to be available
    await page.setContent(html, { waitUntil: 'networkidle0' });
    
    // Wait for the chart to be fully ready
    await page.waitForFunction(() => {
        try {
          return window.LightweightCharts && document.querySelector('#chart').children.length > 0;
        } catch(e) { return false; }
    }, { timeout: 10000 });

    // Brief extra pause for the "price lines" to render
    await new Promise(resolve => setTimeout(resolve, 1500));

    await page.screenshot({ path: imagePath, type: 'jpeg', quality: 90 });
    
    logger.debug(`🎨 Chart generated: ${imagePath}`);
    return imagePath;
  } catch (err) {
    logger.error('Failed to generate chart image:', err);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { generateChartImage };
