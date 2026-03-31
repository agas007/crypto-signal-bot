const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const STORAGE_PATH = path.join(process.cwd(), 'active_signals.json');
const LESSONS_PATH = path.join(process.cwd(), 'history_lessons.json');

/**
 * Memory module to track active trade signals.
 */
class SignalTracker {
  constructor() {
    this.signals = this._load();
    this.lessons = this._loadLessons();
  }

  _load() {
    try {
      if (fs.existsSync(STORAGE_PATH)) {
        return JSON.parse(fs.readFileSync(STORAGE_PATH, 'utf8'));
      }
    } catch (err) { logger.error('Failed to load signals:', err.message); }
    return {};
  }

  _loadLessons() {
    try {
      if (fs.existsSync(LESSONS_PATH)) {
        return JSON.parse(fs.readFileSync(LESSONS_PATH, 'utf8'));
      }
    } catch (err) { logger.error('Failed to load lessons:', err.message); }
    return [];
  }

  _save() {
    try {
      fs.writeFileSync(STORAGE_PATH, JSON.stringify(this.signals, null, 2));
    } catch (err) { logger.error('Failed to save signals:', err.message); }
  }

  _saveLessons() {
    try {
      // Keep only last 20 lessons to avoid bloating prompt
      const trimmed = this.lessons.slice(-20);
      fs.writeFileSync(LESSONS_PATH, JSON.stringify(trimmed, null, 2));
    } catch (err) { logger.error('Failed to save lessons:', err.message); }
  }

  /**
   * Keep a lesson learned from a failed trade.
   */
  saveLesson(symbol, bias, analysis) {
    this.lessons.push({
      symbol,
      bias,
      analysis,
      timestamp: Date.now()
    });
    this._saveLessons();
    logger.info(`🧠 [Tracker] Lesson saved for ${symbol}. Total memory: ${this.lessons.length}`);
  }

  getRecentLessons() {
    return this.lessons.slice(-10); // Return last 10 lessons
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
