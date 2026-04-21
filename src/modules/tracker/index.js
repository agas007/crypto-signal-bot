const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');
const { getJakartaResetTime } = require('../../utils/time');

const DATA_DIR = process.env.DATA_DIR || process.cwd();
const STORAGE_PATH = path.join(DATA_DIR, 'active_signals.json');
const LESSONS_PATH = path.join(DATA_DIR, 'history_lessons.json');
const HISTORY_PATH = path.join(DATA_DIR, 'trade_history.json');
const WATCHLIST_PATH = path.join(DATA_DIR, 'latest_watchlist.json');
const BINANCE_SNAPSHOT_PATH = path.join(DATA_DIR, 'binance_trade_snapshot.json');
const DASHBOARD_STATE_PATH = path.join(DATA_DIR, 'dashboard_state.json');

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
    this.latestWatchlist = this._loadWatchlist();
    this.latestBinanceSnapshot = this._loadBinanceSnapshot();
    this.dashboardState = this._loadDashboardState();
    this.manualResetAt = 0;
  }

  getEffectiveResetTime() {
    return Math.max(getJakartaResetTime(), this.manualResetAt);
  }

  resetCooldown() {
    this.manualResetAt = Date.now();
    logger.info('🧠 [Tracker] Cooldown manually reset.');
    return true;
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

  _loadWatchlist() {
    try {
      if (fs.existsSync(WATCHLIST_PATH)) {
        return JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
      }
    } catch (err) { logger.error('Failed to load watchlist:', err.message); }
    return [];
  }

  _loadBinanceSnapshot() {
    try {
      if (fs.existsSync(BINANCE_SNAPSHOT_PATH)) {
        return JSON.parse(fs.readFileSync(BINANCE_SNAPSHOT_PATH, 'utf8'));
      }
    } catch (err) { logger.error('Failed to load Binance snapshot:', err.message); }
    return null;
  }

  _loadDashboardState() {
    try {
      if (fs.existsSync(DASHBOARD_STATE_PATH)) {
        return JSON.parse(fs.readFileSync(DASHBOARD_STATE_PATH, 'utf8'));
      }
    } catch (err) { logger.error('Failed to load dashboard state:', err.message); }
    return { lastAutoDashboardSentAt: 0 };
  }

  _save() {
    try {
      fs.writeFileSync(STORAGE_PATH, JSON.stringify(this.signals, null, 2));
    } catch (err) { logger.error('Failed to save signals:', err.message); }
  }

  _saveLessons() {
    try {
      // Keep only last 15 lessons to keep AI prompts focused
      this.lessons = this.lessons.slice(-15);
      fs.writeFileSync(LESSONS_PATH, JSON.stringify(this.lessons, null, 2));
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
   * Deduplicates: skips if the same symbol+bias already has a lesson within 24h.
   */
  saveLesson(symbol, bias, analysis) {
    const now = Date.now();
    const dayAgo = now - (24 * 60 * 60 * 1000);
    const duplicate = this.lessons.find(l => 
      l.symbol === symbol && l.bias === bias && l.timestamp > dayAgo
    );
    if (duplicate) {
      logger.debug(`🧠 [Tracker] Skipping duplicate lesson for ${symbol} (${bias}) - already learned today.`);
      return;
    }

    this.lessons.push({ symbol, bias, analysis, timestamp: now });
    this._saveLessons();
    logger.info(`🧠 [Tracker] Lesson saved for ${symbol}. Total memory: ${this.lessons.length}`);
  }

  getRecentLessons() {
    return this.lessons.slice(-10); // Return last 10 lessons for AI prompt
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
    const resetTime = this.getEffectiveResetTime();
    const activeCount = Object.keys(this.signals).length;
    const completedRecently = this.history.filter(t => t.closedAt > resetTime).length;
    return activeCount + completedRecently;
  }
  getGlobalSLCountToday() {
    const resetTime = this.getEffectiveResetTime();
    return this.history.filter(t => t.close_reason === 'SL_HIT' && t.closedAt > resetTime).length;
  }

  /**
   * Check stats for a specific base asset (e.g. NMR from NMRUSDT, NMRBTC).
   */
  getAssetStats(symbol) {
    const resetTime = this.getEffectiveResetTime();
    // Extract base asset (Naive approach: remove USDT, BTC, etc. from end)
    const baseAsset = symbol.toUpperCase().replace(/(USDT|BTC|ETH|BNB|PERP)$/, '');
    
    // Count SL hits for this base asset in any pair
    const slHits = this.history.filter(t => {
      const tBase = t.symbol.toUpperCase().replace(/(USDT|BTC|ETH|BNB|PERP)$/, '');
      return tBase === baseAsset && t.close_reason === 'SL_HIT' && t.closedAt > resetTime;
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
    const resetTime = this.getEffectiveResetTime();
    const sym = symbol.toUpperCase();
    
    // 1. Count attempts (Active + History)
    const activeAttempt = this.signals[sym] && this.signals[sym].bias === bias ? 1 : 0;
    const historyAttempts = this.history.filter(t => 
      t.symbol === sym && 
      t.bias === bias && 
      t.closedAt > resetTime
    ).length;

    // 2. Count SL hits at ASSET level (e.g. any NMR pair)
    const assetStats = this.getAssetStats(sym);

    return {
      attempts: activeAttempt + historyAttempts,
      slHits: assetStats.slHits, // Global SL hits for this asset
      baseAsset: assetStats.baseAsset
    };
  }

  /**
   * Store the latest watchlist for the /watchlist command.
   */
  saveWatchlist(list) {
    this.latestWatchlist = list || [];
    try {
      fs.writeFileSync(WATCHLIST_PATH, JSON.stringify(this.latestWatchlist, null, 2));
    } catch (err) {
      logger.error('Failed to save watchlist:', err.message);
    }
  }

  getWatchlist() {
    return this.latestWatchlist;
  }

  saveBinanceSnapshot(snapshot) {
    this.latestBinanceSnapshot = snapshot || null;
    try {
      fs.writeFileSync(BINANCE_SNAPSHOT_PATH, JSON.stringify(this.latestBinanceSnapshot, null, 2));
    } catch (err) {
      logger.error('Failed to save Binance snapshot:', err.message);
    }
  }

  getBinanceSnapshot() {
    return this.latestBinanceSnapshot;
  }

  getDashboardState() {
    return this.dashboardState || { lastAutoDashboardSentAt: 0 };
  }

  setDashboardState(nextState = {}) {
    this.dashboardState = {
      ...(this.dashboardState || { lastAutoDashboardSentAt: 0 }),
      ...nextState,
    };
    try {
      fs.writeFileSync(DASHBOARD_STATE_PATH, JSON.stringify(this.dashboardState, null, 2));
    } catch (err) {
      logger.error('Failed to save dashboard state:', err.message);
    }
  }
}

module.exports = new SignalTracker();
