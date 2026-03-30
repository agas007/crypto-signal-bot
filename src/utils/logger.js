const { formatJakartaTime } = require('./time');

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;

const timestamp = () => formatJakartaTime(new Date(), 'terminal');

const logger = {
  error: (...args) => {
    if (currentLevel >= LOG_LEVELS.error) console.error(`[${timestamp()}] ❌ ERROR:`, ...args);
  },
  warn: (...args) => {
    if (currentLevel >= LOG_LEVELS.warn) console.warn(`[${timestamp()}] ⚠️  WARN:`, ...args);
  },
  info: (...args) => {
    if (currentLevel >= LOG_LEVELS.info) console.log(`[${timestamp()}] ℹ️  INFO:`, ...args);
  },
  debug: (...args) => {
    if (currentLevel >= LOG_LEVELS.debug) console.log(`[${timestamp()}] 🐛 DEBUG:`, ...args);
  },
};

module.exports = logger;
