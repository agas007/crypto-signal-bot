import * as fs from 'fs';
import * as path from 'path';
import puppeteer from 'puppeteer';
import TelegramBot from 'node-telegram-bot-api';
const config = require('../config');

/**
 * Autovisualiser Utility
 * Menyediakan snippet HTML/JS untuk berbagai jenis chart menggunakan CDN.
 */
class Autovisualiser {
  static renderRadar(id: string, label: string, data: number[], labels: string[]): string {
    return `
      <div class="chart-container"><canvas id="${id}"></canvas></div>
      <script>
        new Chart(document.getElementById('${id}'), {
          type: 'radar',
          data: {
            labels: ${JSON.stringify(labels)},
            datasets: [{
              label: '${label}',
              data: ${JSON.stringify(data)},
              fill: true,
              backgroundColor: 'rgba(56, 189, 248, 0.2)',
              borderColor: 'rgb(56, 189, 248)',
              pointBackgroundColor: 'rgb(56, 189, 248)',
              pointBorderColor: '#fff',
            }]
          },
          options: {
            scales: { r: { angleLines: { display: false }, suggestMin: 0, suggestMax: 100 } },
            plugins: { legend: { labels: { color: '#fff' } } }
          }
        });
      </script>`;
  }

  static renderDonut(id: string, labels: string[], data: number[]): string {
    return `
      <div class="chart-container"><canvas id="${id}"></canvas></div>
      <script>
        new Chart(document.getElementById('${id}'), {
          type: 'doughnut',
          data: {
            labels: ${JSON.stringify(labels)},
            datasets: [{
              data: ${JSON.stringify(data)},
              backgroundColor: ['#22c55e', '#ef4444', '#f59e0b', '#3b82f6'],
              hoverOffset: 4
            }]
          },
          options: {
            plugins: { legend: { position: 'bottom', labels: { color: '#fff' } } }
          }
        });
      </script>`;
  }

  static renderMermaid(content: string): string {
    return `<div class="mermaid">${content}</div>`;
  }

  static renderSankey(id: string, data: any[][]): string {
    return `
      <div id="${id}" style="height: 300px;"></div>
      <script>
        google.charts.load('current', {'packages':['sankey']});
        google.charts.setOnLoadCallback(() => {
          var dt = new google.visualization.DataTable();
          dt.addColumn('string', 'From'); dt.addColumn('string', 'To'); dt.addColumn('number', 'Weight');
          dt.addRows(${JSON.stringify(data)});
          var chart = new google.visualization.Sankey(document.getElementById('${id}'));
          chart.draw(dt, { sankey: { node: { label: { color: '#ffffff' } }, link: { color: { fill: '#334155' } } } });
        });
      </script>`;
  }
}

async function run() {
  const logPath = path.join(process.cwd(), 'scan_audit.log');
  if (!fs.existsSync(logPath)) {
    console.error('❌ Log file scan_audit.log tidak ditemukan!');
    return;
  }

  const logContent = fs.readFileSync(logPath, 'utf8');
  const lines = logContent.split('\n').filter(l => l.includes('|'));

  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600000);

  // Metrik
  let stats = { scanned: 0, prePassed: 0, stratPassed: 0, approved: 0, rejected: 0, watchlist: 0 };
  const symbolCount: Record<string, number> = {};
  let bias = { long: 0, short: 0 };
  let solData = { volatility: 65, confluence: 50, rr: 50, confidence: 50 };

  lines.forEach(line => {
    const tsMatch = line.match(/\[(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})\]/);
    if (!tsMatch) return;

    const logDate = new Date(`${tsMatch[3]}-${tsMatch[2]}-${tsMatch[1]}T${tsMatch[4]}:${tsMatch[5]}:${tsMatch[6]}`);
    if (logDate >= oneHourAgo) {
      const parts = line.split('|').map(p => p.trim());
      const [_, symbol, phase, status, scoreStr, details] = parts;
      const score = parseInt(scoreStr);

      if (phase === 'PRE-FILTER') {
        stats.scanned++;
        if (status === 'PASSED') stats.prePassed++;
      } else if (phase === 'STRATEGY') {
        if (status === 'PASSED') stats.stratPassed++;
      } else if (phase === 'AI') {
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
          if (details.includes('R:R di bawah 1.5')) solData.rr = 30;
          else if (details.includes('R:R')) solData.rr = 85;
        }
      }
    }
  });

  const top3 = Object.entries(symbolCount).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s]) => s);
  const domBias = bias.long > bias.short ? 'LONG' : (bias.short > bias.long ? 'SHORT' : 'NEUTRAL');

  const htmlContent = `
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
    <script type="text/javascript" src="https://www.gstatic.com/charts/loader.js"></script>
    <style>
        :root { --bg: #0f172a; --card: #1e293b; --text: #f8fafc; --primary: #38bdf8; }
        body { font-family: sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 20px; width: 1000px; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        .card { background: var(--card); border-radius: 16px; padding: 20px; border: 1px solid rgba(255,255,255,0.05); }
        h1 { color: var(--primary); text-align: center; font-size: 28px; margin-bottom: 10px; }
        .stats-row { display: flex; justify-content: space-around; margin-bottom: 20px; text-align: center; background: rgba(255,255,255,0.02); padding: 15px; border-radius: 10px; }
        .stat-val { font-size: 24px; font-weight: bold; color: var(--primary); }
        .stat-lab { font-size: 12px; opacity: 0.6; }
        .chart-container { position: relative; height: 280px; }
        .recommendation { border-left: 5px solid var(--primary); background: rgba(56, 189, 248, 0.1); padding: 15px; margin-top: 20px; border-radius: 4px; }
    </style>
</head>
<body>
    <h1>🚀 Crypto Trading Health Dashboard</h1>
    <div style="text-align: center; opacity: 0.5; font-size: 12px; margin-bottom: 20px;">Periode: ${oneHourAgo.toLocaleTimeString()} - ${now.toLocaleTimeString()}</div>
    
    <div class="stats-row">
        <div><div class="stat-val">${stats.scanned}</div><div class="stat-lab">Total Scanned</div></div>
        <div><div class="stat-val">${domBias}</div><div class="stat-lab">Dominant Bias</div></div>
        <div><div class="stat-val">${top3.join(', ') || 'N/A'}</div><div class="stat-lab">Hot Pairs</div></div>
    </div>

    <div class="grid">
        <div class="card"><h3>🥧 AI Status</h3>${Autovisualiser.renderDonut('d1', ['Approved', 'Rejected', 'Watchlist'], [stats.approved, stats.rejected, stats.watchlist])}</div>
        <div class="card"><h3>📊 SOLUSDT Analysis</h3>${Autovisualiser.renderRadar('r1', 'SOL Metrics', [solData.volatility, solData.confluence, solData.rr, solData.confidence], ['Volatility', 'Confluence', 'R:R', 'AI Confidence'])}</div>
        <div class="card"><h3>🔁 Decision Flow</h3>${Autovisualiser.renderMermaid(`graph LR\\nS[Scan: ${stats.scanned}] --> P[Filter: ${stats.prePassed}] --> ST[Strat: ${stats.stratPassed}] --> AI[AI] --> AP[Approve: ${stats.approved}]`)}</div>
        <div class="card"><h3>🌐 Conversion Funnel</h3>${Autovisualiser.renderSankey('s1', [['Scan','Pre',stats.scanned],['Pre','Strat',stats.prePassed],['Strat','AI',stats.stratPassed],['AI','Approve',stats.approved],['AI','Reject',stats.rejected]])}</div>
    </div>

    <div class="recommendation">
        <strong>💡 Insight:</strong> ${stats.rejected > stats.approved ? 'Tingkat rejection AI tinggi. Pasar mungkin sedang choppy atau tidak stabil.' : 'Alur kerja normal. Cek portofolio untuk sinyal aktif.'}
    </div>
    <script>mermaid.initialize({ startOnLoad: true, theme: 'dark' });</script>
</body>
</html>`;

  const htmlPath = path.join(process.cwd(), 'dashboard_latest.html');
  const screenshotPath = path.join(process.cwd(), 'dashboard_latest.png');
  fs.writeFileSync(htmlPath, htmlContent);

  // --- SCREENSHOT LOGIC ---
  console.log('📸 Generating screenshot via Puppeteer...');
  const browser = await puppeteer.launch({ 
    headless: true, 
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1050, height: 950 });
  await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
  
  // Kasih waktu sedikit buat animasi chart
  await new Promise(resolve => setTimeout(resolve, 2500));
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await browser.close();

  // --- TELEGRAM LOGIC ---
  console.log('📤 Sending dashboard to Telegram...');
  try {
    const bot = new (TelegramBot as any)(config.telegram.botToken);
    const caption = `📊 *HOURLY MARKET DASHBOARD*\n` +
                    `━━━━━━━━━━━━━━━━━━━\n` +
                    `🔎 *Scanned:* ${stats.scanned} pairs\n` +
                    `✅ *Approved:* ${stats.approved} | 🚫 *Rejected:* ${stats.rejected}\n` +
                    `⚖️ *Dominant Bias:* #${domBias}\n` +
                    `🔥 *Hot Symbols:* ${top3.join(', ')}\n\n` +
                    `_Generated on: ${now.toLocaleString('id-ID')} WIB_`;

    await bot.sendPhoto(config.telegram.chatId, fs.createReadStream(screenshotPath), {
      caption: caption,
      parse_mode: 'Markdown'
    });
    console.log('✅ Success: Dashboard sent to Telegram!');
    
    // Cleanup
    if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
  } catch (err: any) {
    console.error('❌ Gagal mengirim ke Telegram:', err.message);
  }
}

run().catch(err => console.error('致命的なエラー:', err));
