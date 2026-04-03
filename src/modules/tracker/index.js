const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const DATA_DIR = process.env.DATA_DIR || process.cwd();
const STORAGE_PATH = path.join(DATA_DIR, 'active_signals.json');
const LESSONS_PATH = path.join(DATA_DIR, 'history_lessons.json');
const HISTORY_PATH = path.join(DATA_DIR, 'trade_history.json');

// Ensure directory exists if it's not the root or current directory
if (DATA_DIR !== process.cwd() && !fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    logger.error(`Failed to create DATA_DIR: ${DATA_DIR}`, err.message);
  }
}

/**
 * Memory module to track active trade signals and history.
 */
class SignalTracker {
  constructor() {
    this.signals = this._load();
    this.lessons = this._loadLessons();
    this.history = this._loadHistory();
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

  _loadHistory() {
    try {
      if (fs.existsSync(HISTORY_PATH)) {
        return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
      }
    } catch (err) { logger.debug('No trade history file found, creating new one...'); }
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

  _saveHistory() {
    try {
      // Keep performance history (e.g. last 100 trades for performance monitoring)
      const trimmed = this.history.slice(-100);
      fs.writeFileSync(HISTORY_PATH, JSON.stringify(trimmed, null, 2));
    } catch (err) { logger.error('Failed to save trade history:', err.message); }
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
    const now = Date.now();
    this.signals[symbol] = {
      ...signal,
      symbol,
      signalAt: signal.timestamp || now, // Original fetched time
      entryAt: now,                     // Time when bot started tracking it as active
      status: 'ACTIVE'
    };
    this._save();
    logger.info(`🧠 [Tracker] Tracking ${symbol} as ACTIVE @ entry: ${signal.entry}`);
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
   * Remove a signal and move it to history.
   */
  remove(symbol, reason = 'CLEANUP', finalPrice = null) {
    const sym = symbol.toUpperCase();
    if (this.signals[sym]) {
      const now = Date.now();
      const signal = this.signals[sym];
      
      const trade = {
        ...signal,
        closedAt: now,
        close_reason: reason,
        exit_price: finalPrice || null,
        status: reason.includes('HIT') ? 'COMPLETED' : 'INVALID',
        durationMs: now - signal.entryAt,
        durationMinutes: ((now - signal.entryAt) / 60000).toFixed(2),
        timeToEntrySeconds: ((signal.entryAt - signal.signalAt) / 1000).toFixed(1)
      };

      // Add to history
      this.history.push(trade);
      this._saveHistory();

      // Remove from active
      delete this.signals[sym];
      this._save();
      
      logger.info(`🧠 [Tracker] Removed ${sym} from memory (${reason}). Moved to history.`);
    }
  }

  /**
   * List all currently active symbols.
   */
  getAllActive() {
    return Object.values(this.signals).filter(s => s.status === 'ACTIVE');
  }

  /**
   * Mark an active signal as a taken trade.
   */
  markAsTaken(symbol) {
    const sym = symbol.toUpperCase();
    if (this.signals[sym]) {
      this.signals[sym].isTaken = true;
      this._save();
      logger.info(`🧠 [Tracker] ${sym} marked as TAKEN trade.`);
      return true;
    }
    return false;
  }

  /**
   * Get performance monitoring stats.
   * Now includes separate stats for user-taken trades.
   */
  getStats() {
    const completed = this.history.filter(t => t.status === 'COMPLETED');
    const takenCompleted = completed.filter(t => t.isTaken);

    const calcWinRate = (list) => {
      if (list.length === 0) return '0.00%';
      const wins = list.filter(t => t.close_reason === 'TP_HIT').length;
      return ((wins / list.length) * 100).toFixed(2) + '%';
    };

    return {
      global: {
        total: this.history.length,
        active: this.getAllActive().length,
        winRate: calcWinRate(completed)
      },
      user: {
        total: this.history.filter(t => t.isTaken || t.status === 'COMPLETED' && t.isTaken).length,
        active: this.getAllActive().filter(s => s.isTaken).length,
        winRate: calcWinRate(takenCompleted)
      }
    };
  }

  /**
   * Adjust TP and SL for an active signal.
   */
  adjustSignal(symbol, tp, sl) {
    const sym = symbol.toUpperCase();
    if (this.signals[sym]) {
      this.signals[sym].take_profit = parseFloat(tp);
      this.signals[sym].stop_loss = parseFloat(sl);
      this._save();
      logger.info(`🧠 [Tracker] Adjusted ${sym} -> TP: ${tp}, SL: ${sl}`);
      return true;
    }
    return false;
  }

  /**
   * Reset the "TAKEN" marks without clearing the whole signal list.
   */
  clearMyTrades() {
    Object.keys(this.signals).forEach(sym => {
        delete this.signals[sym].isTaken;
    });
    this.history = this.history.filter(t => !t.isTaken); // Also clear taken history?
    this._save();
    this._saveHistory();
    logger.info('🧠 [Tracker] User trades cleared.');
  }

  /**
   * Reset all active signals.
   */
  clearActive() {
    this.signals = {};
    this._save();
    logger.info('🧠 [Tracker] Active signals cleared.');
  }

  /**
   * Reset trade history.
   */
  clearHistory() {
    this.history = [];
    this._saveHistory();
    logger.info('🧠 [Tracker] Trade history cleared.');
  }

  /**
   * Reset AI lessons.
   */
  clearLessons() {
    this.lessons = [];
    this._saveLessons();
    logger.info('🧠 [Tracker] AI lessons cleared.');
  }
  /**
   * Check if we are over the daily trade limit (Global).
   */
  getDailyTradeCount() {
    const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
    const activeCount = Object.keys(this.signals).length;
    const completedRecently = this.history.filter(t => t.closedAt > dayAgo).length;
    return activeCount + completedRecently;
  }
  getGlobalSLCountToday() {
    const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
    return this.history.filter(t => t.close_reason === 'SL_HIT' && t.closedAt > dayAgo).length;
  }

  /**
   * Check stats for a specific base asset (e.g. NMR from NMRUSDT, NMRBTC).
   */
  getAssetStats(symbol) {
    const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
    // Extract base asset (Naive approach: remove USDT, BTC, etc. from end)
    const baseAsset = symbol.toUpperCase().replace(/(USDT|BTC|ETH|BNB|PERP)$/, '');
    
    // Count SL hits for this base asset in any pair
    const slHits = this.history.filter(t => {
      const tBase = t.symbol.toUpperCase().replace(/(USDT|BTC|ETH|BNB|PERP)$/, '');
      return tBase === baseAsset && t.close_reason === 'SL_HIT' && t.closedAt > dayAgo;
    }).length;

    return { slHits, baseAsset };
  }

  /**
   * Calculate win rates for different technical score brackets.
   */
  getScorePerformanceBrackets() {
    const completed = this.history.filter(t => t.status === 'COMPLETED');
    
    const analyzeBracket = (min, max) => {
      const items = completed.filter(t => t.score >= min && (max ? t.score < max : true));
      const wins = items.filter(t => t.close_reason === 'TP_HIT').length;
      const winRate = items.length > 0 ? (wins / items.length * 100).toFixed(1) : 'N/A';
      return { count: items.length, winRate };
    };

    return {
      bracket60_70: analyzeBracket(60, 70),
      bracket70_80: analyzeBracket(70, 80),
      bracket80_plus: analyzeBracket(80, null)
    };
  }

  /**
   * Check stats for a specific pair and direction.
   * Now incorporates base-asset level SL cooldown.
   */
  getPairStats(symbol, bias) {
    const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
    const sym = symbol.toUpperCase();
    
    // 1. Count attempts (Active + History)
    const activeAttempt = this.signals[sym] && this.signals[sym].bias === bias ? 1 : 0;
    const historyAttempts = this.history.filter(t => 
      t.symbol === sym && 
      t.bias === bias && 
      t.closedAt > dayAgo
    ).length;

    // 2. Count SL hits at ASSET level (e.g. any NMR pair)
    const assetStats = this.getAssetStats(sym);

    return {
      attempts: activeAttempt + historyAttempts,
      slHits: assetStats.slHits, // Global SL hits for this asset
      baseAsset: assetStats.baseAsset
    };
  }

}

module.exports = new SignalTracker();
