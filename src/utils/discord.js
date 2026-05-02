/**
 * Discord Webhook sender — replaces Telegram sendSignal/sendStatus.
 *
 * Env vars required:
 *   DISCORD_SIGNAL_WEBHOOK_URL  - for trade signals (can be same as status)
 *   DISCORD_STATUS_WEBHOOK_URL  - for status/info messages (optional, falls back to SIGNAL)
 */

const fs = require('fs');
const logger = require('./logger');

const SIGNAL_WEBHOOK = process.env.DISCORD_SIGNAL_WEBHOOK_URL;
const STATUS_WEBHOOK = process.env.DISCORD_STATUS_WEBHOOK_URL || process.env.DISCORD_SIGNAL_WEBHOOK_URL;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function jakartaTime(date = new Date()) {
  return date.toLocaleTimeString('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Convert basic Telegram markdown (*bold* _italic_) to Discord (**bold** *italic*). */
function tgToDiscord(text = '') {
  return text
    .replace(/\*([^*\n]+)\*/g, '**$1**')
    .replace(/_([^_\n]+)_/g, '*$1*');
}

// ─── Webhook Sender ───────────────────────────────────────────────────────────

async function postWebhook(url, payload) {
  if (!url) {
    logger.warn('[Discord] Webhook URL not set. Skipping.');
    return;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord ${res.status}: ${text}`);
  }
}

async function postWebhookWithFile(url, payload, imagePath) {
  if (!url || !fs.existsSync(imagePath)) return postWebhook(url, payload);

  const { FormData, Blob } = globalThis;
  const form = new FormData();
  form.append('payload_json', JSON.stringify(payload));
  const buf = fs.readFileSync(imagePath);
  form.append('file[0]', new Blob([buf], { type: 'image/png' }), 'chart.png');

  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord (file) ${res.status}: ${text}`);
  }

  fs.unlinkSync(imagePath);
}

// ─── Signal Embed Builder ─────────────────────────────────────────────────────

function buildSignalEmbed(signal) {
  const isLong = signal.bias === 'LONG';
  const color = isLong ? 0x00c853 : 0xff1744;
  const biasEmoji = isLong ? '🟢' : '🔴';
  const qualityEmoji = signal.quality === 'HIGH' ? '⭐' : '🔶';
  const typeEmoji = signal.trading_type?.includes('MOMENTUM') ? '⚡'
    : signal.trading_type?.includes('SWING') ? '🎯' : '🗓️';

  const confidence = signal.confidence > 1 ? signal.confidence : (signal.confidence || 0) * 100;
  const confBars = '█'.repeat(Math.round(confidence / 10)) + '░'.repeat(10 - Math.round(confidence / 10));

  const rrRatio = (signal.take_profit && signal.entry && signal.stop_loss)
    ? Math.abs(signal.take_profit - signal.entry) / Math.abs(signal.entry - signal.stop_loss)
    : signal.riskReward?.rr || 0;

  let expiryHours = 4;
  if (signal.trading_type?.includes('SCALP')) expiryHours = 1;
  if (signal.trading_type?.includes('SWING')) expiryHours = 24;
  const expiryDate = new Date(Date.now() + expiryHours * 3600000);
  const noEntryPrice = signal.bias === 'LONG'
    ? (signal.entry * 1.003).toFixed(5)
    : (signal.entry * 0.997).toFixed(5);

  const ps = signal.riskReward?.positionSize;
  const scalingTag = signal.riskReward?.isScaled ? ' *(AUTO SCALED)*' : '';

  const fields = [
    { name: '💰 Entry',      value: `\`${signal.entry}\``,            inline: true },
    { name: '🎯 Take Profit', value: `\`${signal.take_profit}\``,      inline: true },
    { name: '🛑 Stop Loss',   value: `\`${signal.stop_loss}\``,        inline: true },
    { name: '📐 R:R Ratio',  value: `\`${rrRatio.toFixed(2)}\``,       inline: true },
    { name: `${typeEmoji} Type`, value: `\`${signal.trading_type || 'DAY TRADING'}\``, inline: true },
    { name: `${qualityEmoji} Quality`, value: `\`${signal.quality || 'N/A'}\``,         inline: true },
    { name: '🎯 Confidence', value: `${confidence.toFixed(0)}% ${confBars}`,            inline: false },
    { name: '⏱️ Valid Until', value: `\`${jakartaTime(expiryDate)} WIB\``,              inline: true },
    { name: '🚫 No Entry If', value: `\`${signal.bias === 'LONG' ? '>' : '<'} ${noEntryPrice}\``, inline: true },
  ];

  if (ps) {
    fields.push({
      name: `🧮 Position Size (Risk $${ps.risk?.toFixed(2)} / 20x)${scalingTag}`,
      value: `Margin: \`${ps.margin?.toFixed(2)} USDT\`  |  Qty: \`${ps.quantity?.toFixed(3)}\`  |  Notional: \`$${ps.notional?.toFixed(2)}\``,
      inline: false,
    });
  }

  if (signal.warnings?.length > 0) {
    fields.push({
      name: '⚠️ Warnings',
      value: signal.warnings.map(w => `• ${w}`).join('\n'),
      inline: false,
    });
  }

  const header = signal.isFallback ? '📡 BEST AVAILABLE SIGNAL' : '🚨 TRADE SIGNAL';

  return {
    title: `${biasEmoji} ${header}: ${signal.symbol}`,
    color,
    description: signal.reason ? `> ${signal.reason.replace(/[*_`]/g, '')}` : '',
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: `Crypto Signal Bot v4.4  •  ${jakartaTime()} WIB` },
    url: `https://www.tradingview.com/chart/?symbol=BINANCE:${signal.symbol}`,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a trade signal embed to Discord.
 * Drop-in replacement for telegram.sendSignal(signal, imagePath).
 */
async function sendSignal(signal, imagePath = null) {
  try {
    if (signal.isChartUpdate) {
      if (imagePath && fs.existsSync(imagePath)) {
        await postWebhookWithFile(SIGNAL_WEBHOOK, {
          content: `📊 **Chart Confirmation: ${signal.symbol}** — sinyal sudah masuk, ini chart pendukungnya.`,
        }, imagePath);
      }
      return;
    }

    const embed = buildSignalEmbed(signal);
    const components = [{
      type: 1,
      components: [
        { type: 2, style: 5, label: '📈 TradingView', url: `https://www.tradingview.com/chart/?symbol=BINANCE:${signal.symbol}` },
        { type: 2, style: 5, label: '💰 Binance',     url: `https://app.binance.com/en/trade/${signal.symbol.replace('USDT', '_USDT')}` },
      ],
    }];

    if (imagePath && fs.existsSync(imagePath)) {
      embed.image = { url: 'attachment://chart.png' };
      await postWebhookWithFile(SIGNAL_WEBHOOK, { embeds: [embed], components }, imagePath);
    } else {
      await postWebhook(SIGNAL_WEBHOOK, { embeds: [embed], components });
    }

    logger.info(`📨 Signal sent to Discord: ${signal.symbol}`);
  } catch (err) {
    logger.error(`[Discord] sendSignal(${signal.symbol}) failed: ${err.message}`);
    // Fallback: plain text
    try {
      await postWebhook(STATUS_WEBHOOK, {
        content: `🚨 **${signal.symbol} ${signal.bias}** | Entry: \`${signal.entry}\` | TP: \`${signal.take_profit}\` | SL: \`${signal.stop_loss}\``,
      });
    } catch (_) { /* ignore */ }
  }
}

/**
 * Send a plain status/info message to Discord.
 * Drop-in replacement for telegram.sendStatus(text).
 */
async function sendStatus(text) {
  try {
    const content = tgToDiscord(text);
    // Split if over Discord's 2000 char limit
    const chunks = [];
    for (let i = 0; i < content.length; i += 1900) chunks.push(content.slice(i, i + 1900));

    for (const chunk of chunks) {
      await postWebhook(STATUS_WEBHOOK, { content: chunk });
    }
  } catch (err) {
    logger.error(`[Discord] sendStatus failed: ${err.message}`);
  }
}

module.exports = { sendSignal, sendStatus };
