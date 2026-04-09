const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const logger = require('../../utils/logger');

let browserInstance = null;
let chartCount = 0; // Masalah OOM: Restart browser after X charts

async function getBrowser() {
  // Masalah OOM: If we've generated 10 charts, kill browser to clear memory spikes
  if (chartCount >= 10 && browserInstance) {
    logger.info('🧹 [Chart] Max charts reached. Restarting browser to clear memory...');
    await browserInstance.close();
    browserInstance = null;
    chartCount = 0;
  }

  if (browserInstance) {
    try {
      await browserInstance.version();
      return browserInstance;
    } catch (e) {
      browserInstance = null;
    }
  }

  browserInstance = await puppeteer.launch({
    headless: "new",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  return browserInstance;
}

/**
 * Generate a high-quality chart image for a signal with Entry, TP, and SL markers.
 */
async function generateChartImage(symbol, candles, signal) {
  const entry = signal.entry || (signal.riskReward && signal.riskReward.entry);
  const tp = signal.take_profit || (signal.riskReward && signal.riskReward.tp);
  const sl = signal.stop_loss || (signal.riskReward && signal.riskReward.sl);

  if (!entry || !tp || !sl) {
    logger.error(`❌ Cannot generate chart for ${symbol}: Missing price levels`);
    return null;
  }

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
    body { background: #0c0c0c; margin: 0; padding: 0; width: 1024px; height: 512px; font-family: 'Inter', system-ui, -apple-system, sans-serif; overflow: hidden; }
    #chart { width: 1022px; height: 510px; }
    .overlay {
        position: absolute;
        top: 20px;
        left: 20px;
        z-index: 10;
        pointer-events: none;
        color: #d1d4dc;
    }
    .symbol { font-size: 28px; font-weight: 700; color: #ffffff; margin-bottom: 4px; }
    .details { font-size: 14px; opacity: 0.8; letter-spacing: 1px; }
    .watermark { position: absolute; bottom: 40px; right: 80px; font-size: 14px; color: #363a45; z-index: 5; }
  </style>
</head>
<body>
  <div class="overlay">
    <div class="symbol">${symbol}</div>
    <div class="details">BINANCE FUTURES • 1H • CRYPTO SIGNAL BOT V4.4</div>
  </div>
  <div class="watermark">DYOR • NOT FINANCIAL ADVICE</div>
  <div id="chart"></div>
  <script>
    const container = document.getElementById('chart');
    const chart = LightweightCharts.createChart(container, {
      width: 1022,
      height: 510,
      layout: { 
        background: { type: 'solid', color: '#0c0c0c' }, 
        textColor: '#d1d4dc',
        fontSize: 12
      },
      grid: { 
        vertLines: { color: 'rgba(42, 46, 57, 0.5)' }, 
        horzLines: { color: 'rgba(42, 46, 57, 0.5)' } 
      },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      timeScale: { borderColor: '#485c7b', timeVisible: true, secondsVisible: false },
    });

    const candlestickSeries = chart.addCandlestickSeries({
      upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
      wickUpColor: '#26a69a', wickDownColor: '#ef5350',
      priceFormat: { type: 'price', precision: 6, minMove: 0.000001 },
    });

    chart.priceScale().applyOptions({ autoScale: true, borderColor: '#485c7b' });

    const data = ${JSON.stringify(chartData)};
    candlestickSeries.setData(data);

    const addLine = (price, color, title) => {
      candlestickSeries.createPriceLine({
        price: price, color: color, lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: title,
      });
    };

    addLine(${entry}, '#bbbbbb', ' ENTRY');
    addLine(${tp}, '#26a69a', ' TAKE PROFIT');
    addLine(${sl}, '#ef5350', ' STOP LOSS');

    chart.timeScale().fitContent();
  </script>
</body>
</html>
  `;

  let browser;
  let page;
  try {
    const tmpDir = path.join(process.cwd(), 'tmp_charts');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

    const filename = `${symbol}_${Date.now()}.jpg`;
    const imagePath = path.join(tmpDir, filename);

    browser = await getBrowser();
    page = await browser.newPage();
    
    await page.setViewport({ width: 1024, height: 512 });
    await page.setContent(html, { waitUntil: 'networkidle2' });
    
    await page.waitForFunction(() => {
        return window.LightweightCharts && document.querySelector('#chart').children.length > 0;
    }, { timeout: 5000 });

    await new Promise(resolve => setTimeout(resolve, 1000));
    await page.screenshot({ path: imagePath, type: 'jpeg', quality: 70 }); // Lower quality to save RAM
    chartCount++;
    
    return imagePath;
  } catch (err) {
    logger.error(`Chart error for ${symbol}:`, err.message);
    return null;
  } finally {
    if (page) await page.close();
  }
}

module.exports = { generateChartImage };
