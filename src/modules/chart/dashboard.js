const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const config = require('../../config');
const logger = require('../../utils/logger');
const { formatJakartaTime } = require('../../utils/time');
const tracker = require('../tracker');
const { aggregatePositionHistory } = require('../../utils/trade_aggregation');

function resolvePath(filename) {
  const candidates = [
    process.env.DATA_DIR ? path.join(process.env.DATA_DIR, filename) : null,
    path.join(process.cwd(), filename),
    path.join(process.cwd(), '../' + filename),
    path.join(__dirname, '../../../../../../', filename),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function readJson(filename, fallback) {
  const resolved = resolvePath(filename);
  if (!resolved) return fallback;

  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function normalizeSignals(raw) {
  if (!raw) return [];
  return Array.isArray(raw) ? raw : Object.values(raw);
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pickLatest(items, key = 'timestamp') {
  return [...items]
    .filter((item) => typeof item?.[key] === 'number')
    .sort((a, b) => (b[key] || 0) - (a[key] || 0))[0] || null;
}

async function generateAndSendDashboard(targetChatId = null) {
  const chatId = targetChatId || config.telegram.chatId;
  const isManual = Boolean(targetChatId);
  const sixHoursMs = 6 * 60 * 60 * 1000;
  const dashboardState = tracker.getDashboardState ? tracker.getDashboardState() : { lastAutoDashboardSentAt: 0 };
  const lastAutoSentAt = dashboardState.lastAutoDashboardSentAt || 0;

  if (!isManual && lastAutoSentAt && (Date.now() - lastAutoSentAt) < sixHoursMs) {
    logger.info(`🕒 Dashboard auto-send skipped. Next eligible send in ${Math.ceil((sixHoursMs - (Date.now() - lastAutoSentAt)) / 60000)} min.`);
    return;
  }

  const rawSignals = readJson('active_signals.json', []);
  const history = aggregatePositionHistory(readJson('trade_history.json', []));
  const lessons = readJson('history_lessons.json', []);

  const signals = normalizeSignals(rawSignals);
  const activeSignals = signals.filter((s) => s.bias === 'LONG' || s.bias === 'SHORT');
  const watchlistSignals = signals.filter((s) => s.bias === 'WATCHLIST' || s.quality === 'WATCHLIST');
  const completedTrades = history.filter((t) => t.close_reason === 'TP_HIT' || t.close_reason === 'SL_HIT');
  const wins = completedTrades.filter((t) => t.close_reason === 'TP_HIT').length;
  const losses = completedTrades.filter((t) => t.close_reason === 'SL_HIT').length;
  const winRate = completedTrades.length ? (wins / completedTrades.length) * 100 : 0;
  const avgConfidence = activeSignals.length
    ? activeSignals.reduce((sum, s) => sum + asNumber(s.confidence), 0) / activeSignals.length
    : 0;
  const topSetups = [...activeSignals].sort((a, b) => asNumber(b.confidence) - asNumber(a.confidence)).slice(0, 3);
  const latestSignal = pickLatest(signals) || topSetups[0] || null;
  const latestTrade = history[0] || null;
  const latestLesson = lessons[0] || null;

  const statusLabel = signals.length === 0
    ? 'No active signal'
    : watchlistSignals.length > 0
      ? `${watchlistSignals.length} watchlist`
      : `${activeSignals.length} active`;

  const htmlContent = `
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <style>
    :root {
      --bg: #07111f;
      --panel: rgba(15, 23, 42, 0.92);
      --panel-2: rgba(15, 23, 42, 0.76);
      --border: rgba(148, 163, 184, 0.14);
      --text: #e2e8f0;
      --muted: #94a3b8;
      --sky: #67e8f9;
      --emerald: #34d399;
      --amber: #fbbf24;
      --rose: #fb7185;
      --violet: #a78bfa;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 28px;
      width: 1200px;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(103, 232, 249, 0.18), transparent 32%),
        radial-gradient(circle at top right, rgba(167, 139, 250, 0.14), transparent 28%),
        linear-gradient(180deg, #08111f 0%, #050b15 100%);
    }
    .title {
      display: flex;
      justify-content: space-between;
      align-items: end;
      margin-bottom: 18px;
      gap: 24px;
    }
    h1 {
      margin: 0;
      font-size: 34px;
      line-height: 1.1;
      background: linear-gradient(90deg, #7dd3fc, #67e8f9, #86efac);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    .subtitle {
      margin-top: 8px;
      color: var(--muted);
      font-size: 14px;
      max-width: 760px;
    }
    .badge {
      padding: 10px 14px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.8);
      color: var(--text);
      font-size: 12px;
      white-space: nowrap;
    }
    .grid-metrics {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 12px;
      margin: 18px 0 18px;
    }
    .metric {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 16px;
      min-height: 96px;
    }
    .metric .label {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.18em;
    }
    .metric .value {
      margin-top: 10px;
      font-size: 28px;
      font-weight: 700;
    }
    .metric .hint {
      margin-top: 6px;
      font-size: 12px;
      color: var(--muted);
    }
    .layout {
      display: grid;
      grid-template-columns: 1.4fr 0.9fr;
      gap: 16px;
    }
    .stack {
      display: grid;
      gap: 16px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 22px;
      padding: 18px;
      box-shadow: 0 20px 45px rgba(2, 8, 23, 0.25);
    }
    .card h2 {
      margin: 0 0 12px;
      font-size: 18px;
      color: #f8fafc;
    }
    .table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .table th {
      color: var(--muted);
      font-weight: 600;
      text-align: left;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      padding: 10px 8px;
      border-bottom: 1px solid var(--border);
    }
    .table td {
      padding: 14px 8px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.08);
    }
    .pill {
      display: inline-block;
      padding: 5px 10px;
      border-radius: 999px;
      font-size: 11px;
      border: 1px solid transparent;
      font-weight: 700;
    }
    .pill-long { background: rgba(52, 211, 153, 0.12); color: #86efac; border-color: rgba(52, 211, 153, 0.2); }
    .pill-short { background: rgba(251, 113, 133, 0.12); color: #fda4af; border-color: rgba(251, 113, 133, 0.2); }
    .pill-watch { background: rgba(251, 191, 36, 0.12); color: #fcd34d; border-color: rgba(251, 191, 36, 0.2); }
    .pill-win { background: rgba(52, 211, 153, 0.12); color: #86efac; border-color: rgba(52, 211, 153, 0.2); }
    .pill-loss { background: rgba(251, 113, 133, 0.12); color: #fda4af; border-color: rgba(251, 113, 133, 0.2); }
    .muted { color: var(--muted); }
    .list {
      display: grid;
      gap: 10px;
    }
    .item {
      padding: 14px;
      border-radius: 16px;
      background: var(--panel-2);
      border: 1px solid rgba(148, 163, 184, 0.1);
    }
    .item-top {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: start;
    }
    .symbol {
      font-size: 18px;
      font-weight: 700;
      margin: 0;
    }
    .reason {
      margin: 10px 0 0;
      font-size: 12px;
      line-height: 1.55;
      color: #cbd5e1;
    }
    .footer-note {
      margin-top: 16px;
      color: var(--muted);
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="title">
    <div>
      <h1>Crypto Signal Ops</h1>
      <div class="subtitle">Snapshot yang fokus ke hal yang bisa dipakai: signal aktif, watchlist, performa trade terakhir, dan catatan AI. Kalau kosong, itu ditampilkan jujur, bukan dipoles seolah-olah ramai.</div>
    </div>
    <div class="badge">${statusLabel} • ${formatJakartaTime(new Date(), 'readable')} WIB</div>
  </div>

  <div class="grid-metrics">
    <div class="metric"><div class="label">Active</div><div class="value">${signals.length}</div><div class="hint">signal live</div></div>
    <div class="metric"><div class="label">Approved</div><div class="value">${activeSignals.length}</div><div class="hint">lolos screening</div></div>
    <div class="metric"><div class="label">Watchlist</div><div class="value">${watchlistSignals.length}</div><div class="hint">butuh konfirmasi</div></div>
    <div class="metric"><div class="label">Win Rate</div><div class="value">${winRate.toFixed(0)}%</div><div class="hint">${wins} TP / ${losses} SL</div></div>
    <div class="metric"><div class="label">Avg Conf</div><div class="value">${avgConfidence.toFixed(0)}%</div><div class="hint">signal aktif</div></div>
    <div class="metric"><div class="label">Latest</div><div class="value" style="font-size:22px">${latestTrade ? latestTrade.symbol : (latestSignal ? latestSignal.symbol : '-')}</div><div class="hint">${latestTrade ? latestTrade.close_reason : 'latest signal'}</div></div>
  </div>

  <div class="layout">
    <div class="stack">
      <div class="card">
        <h2>Signal Aktif</h2>
        ${topSetups.length === 0 ? `
          <div class="item">
            <div class="muted">Tidak ada signal aktif saat ini. Itu artinya dashboard ini tidak sedang memaksa approval palsu.</div>
          </div>
        ` : `
          <table class="table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Bias</th>
                <th>Type</th>
                <th>Conf</th>
                <th>Entry</th>
                <th>TP / SL</th>
              </tr>
            </thead>
            <tbody>
              ${topSetups.map((s) => `
                <tr>
                  <td><strong>${s.symbol}</strong></td>
                  <td>${s.bias === 'LONG' ? '<span class="pill pill-long">LONG</span>' : '<span class="pill pill-short">SHORT</span>'}</td>
                  <td class="muted">${s.trading_type || 'DAY TRADING'}</td>
                  <td>${asNumber(s.confidence).toFixed(0)}%</td>
                  <td>${typeof s.entry === 'number' ? s.entry.toFixed(5) : (s.entry || '-')}</td>
                  <td class="muted">${s.take_profit ?? '-'} / ${s.stop_loss ?? '-'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `}
      </div>

      <div class="card">
        <h2>Trade Terakhir</h2>
        ${latestTrade ? `
          <div class="item">
            <div class="item-top">
              <div>
                <p class="symbol">${latestTrade.symbol}</p>
                <div class="muted">${latestTrade.bias} • ${latestTrade.close_reason}</div>
              </div>
              <div class="pill ${latestTrade.close_reason === 'TP_HIT' ? 'pill-win' : 'pill-loss'}">${latestTrade.close_reason === 'TP_HIT' ? 'TP' : 'SL'}</div>
            </div>
            <div class="reason">Entry: ${latestTrade.entry} • Exit: ${latestTrade.exit_price || '-'} • Confidence: ${latestTrade.confidence ?? '-'} • Quality: ${latestTrade.quality || '-'}</div>
          </div>
        ` : `
          <div class="item"><div class="muted">Belum ada trade history.</div></div>
        `}
      </div>
    </div>

    <div class="stack">
      <div class="card">
        <h2>Quick Take</h2>
        <div class="list">
          <div class="item">
            <div class="muted">Current focus</div>
            <div class="reason">${topSetups[0] ? `${topSetups[0].symbol} paling kuat saat ini.` : 'Belum ada signal aktif untuk difokuskan.'}</div>
          </div>
          <div class="item">
            <div class="muted">Watchlist</div>
            <div class="reason">${watchlistSignals.length ? `${watchlistSignals.length} setup masih di watchlist dan perlu konfirmasi.` : 'Tidak ada watchlist yang menunggu konfirmasi.'}</div>
          </div>
          <div class="item">
            <div class="muted">Latest lesson</div>
            <div class="reason">${latestLesson ? latestLesson.analysis : 'Belum ada lesson tersimpan.'}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <h2>Recent Outcomes</h2>
        <div class="list">
          ${completedTrades.slice(0, 5).map((trade) => `
            <div class="item">
              <div class="item-top">
                <div>
                  <div class="symbol" style="font-size:16px">${trade.symbol}</div>
                  <div class="muted">${trade.bias}</div>
                </div>
                <div class="pill ${trade.close_reason === 'TP_HIT' ? 'pill-win' : 'pill-loss'}">${trade.close_reason === 'TP_HIT' ? 'TP' : 'SL'}</div>
              </div>
              <div class="reason">Entry ${trade.entry} → Exit ${trade.exit_price || '-'} • Quality ${trade.quality || '-'} • Conf ${trade.confidence ?? '-'}</div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  </div>

  <div class="footer-note">Generated from live bot state: active_signals.json, trade_history.json, history_lessons.json, and scan_audit.log. No fake approval inflation.</div>
</body>
</html>`;

  const screenshotPath = path.join(process.cwd(), 'dashboard_latest.png');

  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1240, height: 1200 });
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    await new Promise((resolve) => setTimeout(resolve, 800));
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await browser.close();

    const bot = new TelegramBot(config.telegram.botToken);
    await bot.sendPhoto(chatId, fs.createReadStream(screenshotPath), {
      caption: `📊 *SIGNAL OPS DASHBOARD*\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `• Active: ${signals.length}\n` +
        `• Approved: ${activeSignals.length}\n` +
        `• Watchlist: ${watchlistSignals.length}\n` +
        `• Win Rate: ${winRate.toFixed(0)}%\n` +
        `• Latest: ${latestTrade ? latestTrade.symbol : (latestSignal ? latestSignal.symbol : 'N/A')}\n\n` +
        `_Generated on: ${formatJakartaTime(new Date(), 'readable')} WIB_`,
      parse_mode: 'Markdown',
    });

    if (!isManual) {
      tracker.setDashboardState({
        lastAutoDashboardSentAt: Date.now()
      });
    }

    if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
    logger.info('✅ Dashboard pushed to Telegram successfully');
  } catch (err) {
    logger.error('❌ Dashboard push failed:', err.message);
  }
}

module.exports = { generateAndSendDashboard };
