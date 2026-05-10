const fs = require('fs');
const config = require('../config');
const logger = require('../utils/logger');
const discord = require('../utils/discord');

const IS_SERVERLESS = Boolean(process.env.VERCEL || process.env.VERCEL_ENV || process.env.AWS_LAMBDA_FUNCTION_NAME);

function hasTelegramDelivery() {
  return Boolean(config.telegram.botToken && config.telegram.chatId);
}

function hasDiscordDelivery() {
  return Boolean(config.discord.webhookUrl || config.discord.signalWebhookUrl || config.discord.statusWebhookUrl);
}

function describeFailure(channel, method, err) {
  const message = err instanceof Error ? err.message : String(err);
  logger.warn(`[Notify] ${channel}.${method} failed: ${message}`);
  return message;
}

async function fanout(method, args) {
  const jobs = [];

  if (hasTelegramDelivery()) {
    jobs.push({
      channel: 'telegram',
      promise: method === 'sendSignal'
        ? sendTelegramSignal(args[0], args[1], args[2] || {})
        : sendTelegramStatus(args[0]),
    });
  }

  if (hasDiscordDelivery() && typeof discord[method] === 'function') {
    jobs.push({
      channel: 'discord',
      promise: discord[method](...args),
    });
  }

  if (jobs.length === 0) {
    logger.warn(`[Notify] No delivery channels configured for ${method}.`);
    return { telegram: false, discord: false, delivered: false };
  }

  const settled = await Promise.allSettled(jobs.map((job) => job.promise));
  const result = { telegram: false, discord: false, delivered: false };

  settled.forEach((entry, idx) => {
    const job = jobs[idx];
    if (entry.status === 'fulfilled' && entry.value !== false) {
      result[job.channel] = true;
      result.delivered = true;
      return;
    }

    const failure = entry.status === 'rejected' ? entry.reason : new Error('Delivery returned false');
    describeFailure(job.channel, method, failure);
  });

  return result;
}

function buildTelegramReplyMarkup(signal = {}) {
  return {
    inline_keyboard: [
      [
        { text: '📈 View', url: `https://www.tradingview.com/chart/?symbol=BINANCE:${signal.symbol}` },
        { text: '💰 Trade', url: `https://app.binance.com/en/trade/${String(signal.symbol || '').replace('USDT', '_USDT')}` },
      ],
    ],
  };
}

function formatTelegramSignal(signal = {}) {
  const side = signal.bias === 'SHORT' ? 'SHORT' : 'LONG';
  const title = signal.isFallback ? 'BEST AVAILABLE SIGNAL' : 'TRADE SIGNAL';
  const entry = signal.entry != null ? signal.entry : '?';
  const tp = signal.take_profit != null ? signal.take_profit : '?';
  const sl = signal.stop_loss != null ? signal.stop_loss : '?';
  const reason = String(signal.reason || '').replace(/[*_`]/g, '');

  return [
    `🚨 ${title}: ${signal.symbol || 'PAIR'}`,
    `Bias: ${side}`,
    `Entry: ${entry}`,
    `TP: ${tp}`,
    `SL: ${sl}`,
    reason ? `Reason: ${reason}` : null,
  ].filter(Boolean).join('\n');
}

async function telegramApiRequest(pathname, payload, asFormData = false) {
  if (!hasTelegramDelivery()) return false;

  const url = `https://api.telegram.org/bot${config.telegram.botToken}/${pathname}`;
  const options = { method: 'POST' };

  if (asFormData) {
    options.body = payload;
  } else {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(payload);
  }

  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Telegram ${res.status}: ${text}`);
  }

  return true;
}

async function sendTelegramSignal(signal, imagePath = null, options = {}) {
  const cleanupImage = options.cleanupImage !== false;
  const chatId = config.telegram.chatId;
  if (!chatId || !config.telegram.botToken) return false;

  const message = formatTelegramSignal(signal);
  const replyMarkup = buildTelegramReplyMarkup(signal);

  try {
    if (imagePath && fs.existsSync(imagePath)) {
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('caption', message);
      form.append('parse_mode', 'Markdown');
      form.append('reply_markup', JSON.stringify(replyMarkup));
      form.append('photo', new Blob([fs.readFileSync(imagePath)], { type: 'image/png' }), 'chart.png');
      await telegramApiRequest('sendPhoto', form, true);
    } else {
      await telegramApiRequest('sendMessage', {
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
      });
    }

    if (cleanupImage && imagePath && fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
    }

    return true;
  } catch (err) {
    logger.error(`Failed to send interactive signal (${signal.symbol || 'PAIR'}): ${err.message}`);
    try {
      const plainMsg = message.replace(/[*_`]/g, '');
      await telegramApiRequest('sendMessage', {
        chat_id: chatId,
        text: `⚠️ [FORMATTING ERROR] ⚠️\n\n${plainMsg}`,
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
      });
      if (cleanupImage && imagePath && fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
      return true;
    } catch (retryErr) {
      logger.error(`Complete signal failure for ${signal.symbol || 'PAIR'}: ${retryErr.message}`);
      return false;
    }
  }
}

async function sendTelegramStatus(text) {
  const chatId = config.telegram.chatId;
  if (!chatId || !config.telegram.botToken) return false;

  try {
    await telegramApiRequest('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
    return true;
  } catch (err) {
    logger.error(`Failed to send Telegram status: ${err.message}. Retrying as plain text...`);
    try {
      await telegramApiRequest('sendMessage', {
        chat_id: chatId,
        text: text.replace(/[*_`]/g, ''),
        disable_web_page_preview: true,
      });
      return true;
    } catch (retryErr) {
      logger.error(`Complete status failure: ${retryErr.message}`);
      return false;
    }
  }
}

async function sendSignal(signal, imagePath = null, options = {}) {
  const cleanupImage = options.cleanupImage !== false;
  const delivery = await fanout('sendSignal', [signal, imagePath, { cleanupImage: false }]);

  if (cleanupImage && imagePath) {
    const fs = require('fs');
    if (fs.existsSync(imagePath)) {
      try {
        fs.unlinkSync(imagePath);
      } catch (err) {
        logger.warn(`[Notify] Failed to clean up chart image ${imagePath}: ${err.message}`);
      }
    }
  }

  return delivery.delivered;
}

async function sendStatus(text) {
  const delivery = await fanout('sendStatus', [text]);
  return delivery.delivered;
}

module.exports = {
  sendSignal,
  sendStatus,
};
