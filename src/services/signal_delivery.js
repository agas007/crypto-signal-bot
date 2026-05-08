const config = require('../config');
const logger = require('../utils/logger');
const telegram = require('../modules/telegram');
const discord = require('../utils/discord');

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

  if (hasTelegramDelivery() && typeof telegram[method] === 'function') {
    jobs.push({
      channel: 'telegram',
      promise: telegram[method](...args),
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
