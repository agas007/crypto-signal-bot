const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const STORAGE_PATH = path.join(process.cwd(), 'active_signals.json');

/**
 * Memory module to track active trade signals.
 */
class SignalTracker {
  constructor() {
    this.signals = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(STORAGE_PATH)) {
        const data = fs.readFileSync(STORAGE_PATH, 'utf8');
        return JSON.parse(data);
      }
    } catch (err) {
      logger.error('Failed to load active signals:', err.message);
    }
    return {};
  }

  _save() {
    try {
      fs.writeFileSync(STORAGE_PATH, JSON.stringify(this.signals, null, 2));
    } catch (err) {
      logger.error('Failed to save active signals:', err.message);
    }
  }

  /**
   * Save a newly sent signal as active.
   */
  track(signal) {
    const symbol = signal.symbol.toUpperCase();
    this.signals[symbol] = {
      ...signal,
      symbol,
      timestamp: Date.now(),
      status: 'ACTIVE'
    };
    this._save();
    logger.info(`🧠 [Tracker] Tracking ${symbol} as ACTIVE.`);
  }

  /**
   * Get an active signal by symbol.
   */
  getActive(symbol) {
    const s = this.signals[symbol.toUpperCase()];
    if (s && s.status === 'ACTIVE') {
        logger.debug(`🧠 [Tracker] Found active signal for ${symbol.toUpperCase()}`);
        return s;
    }
    return null;
  }

  /**
   * Remove a signal (TP/SL Hit or Manual).
   */
  remove(symbol, reason = 'CLEANUP') {
    const sym = symbol.toUpperCase();
    if (this.signals[sym]) {
      delete this.signals[sym];
      this._save();
      logger.info(`🧠 [Tracker] Removed ${sym} from memory: ${reason}`);
    }
  }

  /**
   * List all currently active symbols.
   */
  getAllActive() {
    return Object.values(this.signals).filter(s => s.status === 'ACTIVE');
  }
}

module.exports = new SignalTracker();
