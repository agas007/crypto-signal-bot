const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const config = require('../../config');
const logger = require('../../utils/logger');

async function generateAndSendDashboard(targetChatId = null) {
  const logPath = path.join(process.cwd(), 'scan_audit.log');
  if (!fs.existsSync(logPath)) return;
  
  const chatId = targetChatId || config.telegram.chatId;

  const logContent = fs.readFileSync(logPath, 'utf8');
  const lines = logContent.split('\n').filter(l => l.includes('|'));
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600000);

  let stats = { scanned: 0, prePassed: 0, stratPassed: 0, approved: 0, rejected: 0, watchlist: 0 };
  let symbolCount = {};
  let bias = { long: 0, short: 0 };
  let solData = { volatility: 65, confluence: 50, rr: 50, confidence: 50 };
  const uniqueScanned = new Set();

  lines.forEach(line => {
    const tsMatch = line.match(/\[(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})\]/);
    if (!tsMatch) return;
    const logDate = new Date(`${tsMatch[3]}-${tsMatch[2]}-${tsMatch[1]}T${tsMatch[4]}:${tsMatch[5]}:${tsMatch[6]}`);
    
    if (logDate >= oneHourAgo) {
      const parts = line.split('|').map(p => p.trim());
      const [_, symbol, phase, status, scoreStr, details] = parts;
      const score = parseInt(scoreStr);

      uniqueScanned.add(symbol);

      if (phase === 'PRE-FILTER') { if (status === 'PASSED') stats.prePassed++; }
      else if (phase === 'STRATEGY') { if (status === 'PASSED') stats.stratPassed++; }
      else if (phase === 'AI') {
        if (status === 'APPROVED') stats.approved++;
        else if (status === 'REJECTED') stats.rejected++;
        else if (status === 'WATCHLIST') stats.watchlist++;
      }
      symbolCount[symbol] = (symbolCount[symbol] || 0) + 1;
      if (details.toLowerCase().includes('long')) bias.long++;
      if (details.toLowerCase().includes('short')) bias.short++;
      if (symbol === 'SOLUSDT') {
        if (phase === 'STRATEGY') solData.confluence = score;
        if (phase === 'AI') {
          solData.confidence = score;
          solData.rr = details.includes('R:R') ? 85 : 30;
        }
      }
    }
  });

  stats.scanned = uniqueScanned.size;

  const top3 = Object.entries(symbolCount).sort((a,b) => b[1]-a[1]).slice(0,3).map(s => s[0]);
  const domBias = bias.long > bias.short ? 'LONG' : (bias.short > bias.long ? 'SHORT' : 'NEUTRAL');

  const htmlContent = `
  <!DOCTYPE html><html><head><script src="https://cdn.jsdelivr.net/npm/chart.js"></script><script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script><script type="text/javascript" src="https://www.gstatic.com/charts/loader.js"></script><style>:root { --bg: #0f172a; --card: #1e293b; --text: #f8fafc; --primary: #38bdf8; } body { font-family: sans-serif; background: var(--bg); color: var(--text); padding: 20px; width: 1000px; } .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; } .card { background: var(--card); border-radius: 16px; padding: 20px; } .stats-row { display: flex; justify-content: space-around; margin-bottom: 20px; text-align: center; background: rgba(255,255,255,0.02); padding: 15px; border-radius: 10px; } .stat-val { font-size: 24px; font-weight: bold; color: var(--primary); } h1 { color: var(--primary); text-align: center; }</style></head>
  <body>
    <h1>🚀 Crypto Trading Health Dashboard</h1>
    <div class="stats-row">
        <div><div class="stat-val">${stats.scanned}</div><div>Total Scanned</div></div>
        <div><div class="stat-val">${domBias}</div><div>Dominant Bias</div></div>
        <div><div class="stat-val">${top3.join(', ') || 'N/A'}</div><div>Hot Pairs</div></div>
    </div>
    <div class="grid">
        <div class="card"><h3>🥧 AI Status</h3><canvas id="d1"></canvas></div>
        <div class="card"><h3>📊 SOLUSDT</h3><canvas id="r1"></canvas></div>
        <div class="card"><h3>🔁 Flow</h3><div class="mermaid">graph LR\nS[Scan: ${stats.scanned}] --> P[Filter: ${stats.prePassed}] --> ST[Strat: ${stats.stratPassed}] --> AI[AI] --> AP[App: ${stats.approved}]</div></div>
        <div class="card"><h3>🌐 Conversion</h3><div id="s1" style="height: 250px;"></div></div>
    </div>
    <script>
      new Chart(document.getElementById('d1'), { type: 'doughnut', data: { labels: ['App', 'Rej', 'Watch'], datasets: [{ data: [${stats.approved}, ${stats.rejected}, ${stats.watchlist}], backgroundColor: ['#22c55e', '#ef4444', '#f59e0b'] }] }, options: { plugins: { legend: { labels: { color: '#fff' } } } } });
      new Chart(document.getElementById('r1'), { type: 'radar', data: { labels: ['Vol', 'Conf', 'RR', 'AI'], datasets: [{ label: 'SOL', data: [${solData.volatility}, ${solData.confluence}, ${solData.rr}, ${solData.confidence}], backgroundColor: 'rgba(56, 189, 248, 0.2)', borderColor: '#38bdf8' }] }, options: { scales: { r: { suggestMin: 0, suggestMax: 100 } }, plugins: { legend: { labels: { color: '#fff' } } } } });
      google.charts.load('current', {'packages':['sankey']}); google.charts.setOnLoadCallback(() => { var dt = new google.visualization.DataTable(); dt.addColumn('string', 'From'); dt.addColumn('string', 'To'); dt.addColumn('number', 'Weight'); dt.addRows([['Scan','Pre',${stats.scanned}],['Pre','Strat',${stats.prePassed}],['Strat','AI',${stats.stratPassed}]]); var chart = new google.visualization.Sankey(document.getElementById('s1')); chart.draw(dt, { sankey: { node: { label: { color: '#ffffff' } } } }); });
      mermaid.initialize({ startOnLoad: true, theme: 'dark' });
    </script>
  </body></html>`;

  const screenshotPath = path.join(process.cwd(), 'dashboard_latest.png');
  
  try {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1050, height: 900 });
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 2000));
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await browser.close();

    const bot = new TelegramBot(config.telegram.botToken);
    await bot.sendPhoto(chatId, fs.createReadStream(screenshotPath), {
      caption: `📊 *HOURLY SYSTEM UPDATE*\nScanned: ${stats.scanned} | App: ${stats.approved} | Bias: #${domBias}`,
      parse_mode: 'Markdown'
    });
    fs.unlinkSync(screenshotPath);
    logger.info('✅ Dashboard pushed to Telegram successfully');
  } catch (err) {
    logger.error('❌ Dashboard push failed:', err.message);
  }
}

module.exports = { generateAndSendDashboard };
