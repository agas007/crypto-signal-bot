const fs = require('fs');
const path = require('path');
const config = require('../../config');
const logger = require('../../utils/logger');
const { getJakartaResetTime } = require('../../utils/time');
const { getState, setState, isEnabled: redisEnabled } = require('../../utils/redis');

// Redis key prefix
const R = {
  signals:   'bot:signals',
  lessons:   'bot:lessons',
  lessonStats: 'bot:lesson_stats',
  history:   'bot:history',
  watchlist: 'bot:watchlist',
  dashboard: 'bot:dashboard_state',
  scanReport: 'bot:scan_report',
  adaptiveTuning: 'bot:adaptive_tuning',
};

const DATA_DIR = process.env.DATA_DIR || process.cwd();
const IS_SERVERLESS = Boolean(process.env.VERCEL || process.env.VERCEL_ENV || process.env.AWS_LAMBDA_FUNCTION_NAME);
const STORAGE_PATH = path.join(DATA_DIR, 'active_signals.json');
const LESSONS_PATH = path.join(DATA_DIR, 'history_lessons.json');
const LESSON_STATS_PATH = path.join(DATA_DIR, 'lesson_stats.json');
const HISTORY_PATH = path.join(DATA_DIR, 'trade_history.json');
const WATCHLIST_PATH = path.join(DATA_DIR, 'latest_watchlist.json');
const BINANCE_SNAPSHOT_PATH = path.join(DATA_DIR, 'binance_trade_snapshot.json');
const DASHBOARD_STATE_PATH = path.join(DATA_DIR, 'dashboard_state.json');
const SCAN_REPORT_PATH = path.join(DATA_DIR, 'scan_report.json');
const ADAPTIVE_TUNING_PATH = path.join(DATA_DIR, 'adaptive_tuning.json');

// Ensure directory exists if it's not the root or current directory
if (DATA_DIR !== process.cwd() && !fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    logger.error(`Failed to create DATA_DIR: ${DATA_DIR}`, err.message);
  }
}

function getLessonDayKey(timestamp = Date.now()) {
  return new Date(timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
}

function normalizeLessonReasonKey(value) {
  const text = String(value || '').toLowerCase();

  if (!text) return 'other';
  if (text.includes('trend conflict') || text.includes('timeframe utama berlawanan')) return 'trend_conflict';
  if (text.includes('low volume') || text.includes('volume')) return 'low_volume';
  if (text.includes('low volatility') || text.includes('atr terlalu kecil') || text.includes('market flat')) return 'low_volatility';
  if (text.includes('weak trend') || text.includes('trend terlalu lemah')) return 'weak_trend';
  if (text.includes('middle zone') || text.includes('tanpa edge struktural') || text.includes('tidak ada edge')) return 'middle_zone';
  if (text.includes('support/resistance belum kuat') || text.includes('sudah dites') || text.includes('touch')) return 'level_touch_low';
  if (text.includes('retest belum terkonfirmasi') || text.includes('retest pending')) return 'retest_pending';
  if (text.includes('structure tidak terbentuk') || text.includes('struktur h1 belum valid') || text.includes('h1 structure tidak terbentuk')) return 'structure_weak';
  if (text.includes('dekat resistance tanpa retest') || text.includes('dekat support tanpa retest') || text.includes('entry unconfirmed')) return 'entry_unconfirmed';
  if (text.includes('fomo') || text.includes('terlalu jauh dari key level')) return 'fomo';
  if (text.includes('atr spike') || text.includes('candle abnormal')) return 'atr_spike';
  if (text.includes('invalid r:r setup') || text.includes('sl distance out of bounds') || text.includes('notional below min after cap') || text.includes('margin above balance') || text.includes('r:r too high / likely unrealistic tp')) return 'rr_invalid';
  if (text.includes('poor r:r') || text.includes('need min 2.0') || text.includes('r:r ke') || text.includes('r:r ratio')) return 'poor_rr';
  if (text.includes('weighted score too low') || text.includes('score terlalu rendah') || text.includes('score 0/100')) return 'score_low';
  if (text.includes('standby')) return 'standby';
  if (text.includes('signal lolos validasi') || text.includes('terkirim')) return 'accepted';
  if (text.includes('no pairs')) return 'no_pairs';
  if (text.includes('error')) return 'error';
  if (text.includes('no signal')) return 'no_signal';
  return 'other';
}

function resolveLessonReasonKey(lesson = {}) {
  const explicit = String(lesson.reasonKey || '').toLowerCase();
  if (explicit && explicit !== 'other') {
    return explicit;
  }

  return normalizeLessonReasonKey(
    lesson.analysis || lesson.lessonReason || lesson.rejectionReason || lesson.reasonKey || ''
  );
}

function labelLessonReasonKey(key) {
  const map = {
    trend_conflict: 'Trend conflict D1/H4',
    low_volume: 'Volume 24h terlalu kecil',
    low_volatility: 'ATR terlalu kecil',
    weak_trend: 'Trend terlalu lemah',
    middle_zone: 'Middle zone / tanpa edge',
    level_touch_low: 'Support/Resistance belum kuat',
    retest_pending: 'Retest belum confirmed',
    structure_weak: 'Struktur H1 belum valid',
    entry_unconfirmed: 'Entry belum confirmed di level kuat',
    rr_invalid: 'RR setup invalid / SL-TP bounds',
    fomo: 'Entry terlalu jauh dari level',
    atr_spike: 'ATR spike / candle abnormal',
    poor_rr: 'R:R terlalu kecil',
    score_low: 'Weighted score terlalu rendah',
    standby: 'Setup standby',
    accepted: 'Signal lolos',
    no_pairs: 'Tidak ada pair',
    no_signal: 'Cycle no signal',
    error: 'Error runtime',
    other: 'Lainnya',
  };

  return map[key] || map.other;
}

function createLessonStatsDayBucket(dayKey) {
  return {
    dayKey,
    totalLessons: 0,
    rejectCount: 0,
    byReason: {},
    updatedAt: Date.now(),
  };
}

function accumulateLessonStatsBucket(bucket, lesson) {
  if (!bucket || !lesson || lesson.kind !== 'reject') return bucket;

  const reasonKey = resolveLessonReasonKey(lesson);
  const reasonBucket = bucket.byReason[reasonKey] || {
    key: reasonKey,
    label: labelLessonReasonKey(reasonKey),
    count: 0,
    symbols: [],
    lastTimestamp: 0,
    lastAnalysis: '',
  };

  reasonBucket.count += 1;
  reasonBucket.lastTimestamp = lesson.timestamp || Date.now();
  reasonBucket.lastAnalysis = String(lesson.analysis || lesson.lessonReason || lesson.rejectionReason || '').slice(0, 180);
  if (!reasonBucket.symbols.includes(lesson.symbol)) {
    reasonBucket.symbols.push(lesson.symbol);
    reasonBucket.symbols = reasonBucket.symbols.slice(-3);
  }

  bucket.byReason[reasonKey] = reasonBucket;
  bucket.rejectCount += 1;
  bucket.totalLessons += 1;
  bucket.updatedAt = Date.now();
  return bucket;
}

function buildRejectLessonBucket(dayKey, lessons = []) {
  const bucket = createLessonStatsDayBucket(dayKey);

  for (const lesson of lessons || []) {
    accumulateLessonStatsBucket(bucket, lesson);
  }

  return bucket;
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function pickAllowedScoreWeights(source = {}) {
  const limits = config.strategy.tuning?.limits?.scoreWeights || {};
  const defaults = config.strategy.scoreWeights || {};
  const result = {};

  for (const key of Object.keys(limits)) {
    const range = limits[key] || {};
    result[key] = clampNumber(
      source[key],
      range.min ?? -Infinity,
      range.max ?? Infinity,
      defaults[key],
    );
  }

  return result;
}

function normalizeAdaptiveTuningSuggestion(suggestion = {}) {
  const limits = config.strategy.tuning?.limits || {};
  const current = {
    minFinalScore: config.strategy.minFinalScore || 22,
    minRrRatio: config.strategy.minRrRatio || 2.0,
    standbyMinRr: config.strategy.standbyMinRr || config.strategy.minRrRatio || 2.0,
  };
  const thresholds = suggestion.thresholds || {};
  const rawConfidence = Number(suggestion.confidence);
  const normalizedConfidence = Number.isFinite(rawConfidence) && rawConfidence > 1 ? rawConfidence / 100 : rawConfidence;
  const status = ['APPLY', 'HOLD', 'NO_CHANGE'].includes(String(suggestion.status || '').toUpperCase())
    ? String(suggestion.status).toUpperCase()
    : 'HOLD';

  return {
    version: 1,
    status,
    reason: String(suggestion.reason || '').trim(),
    confidence: clampNumber(normalizedConfidence, 0, 1, 0),
    thresholds: {
      minFinalScore: clampNumber(
        thresholds.minFinalScore,
        limits.minFinalScore?.min ?? 18,
        limits.minFinalScore?.max ?? 28,
        current.minFinalScore,
      ),
      minRrRatio: clampNumber(
        thresholds.minRrRatio,
        limits.minRrRatio?.min ?? 1.5,
        limits.minRrRatio?.max ?? 2.6,
        current.minRrRatio,
      ),
      standbyMinRr: clampNumber(
        thresholds.standbyMinRr,
        limits.standbyMinRr?.min ?? 1.5,
        limits.standbyMinRr?.max ?? 2.6,
        current.standbyMinRr,
      ),
    },
    scoreWeights: pickAllowedScoreWeights(suggestion.scoreWeights || {}),
    notes: Array.isArray(suggestion.notes)
      ? suggestion.notes.map((note) => String(note).trim()).filter(Boolean).slice(0, 5)
      : [],
    sourceDayKey: suggestion.sourceDayKey || null,
    sourceRejectCount: Number.isFinite(Number(suggestion.sourceRejectCount)) ? Number(suggestion.sourceRejectCount) : null,
    sourceTopFailurePhase: suggestion.sourceTopFailurePhase || null,
    generatedAt: suggestion.generatedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Memory module to track active trade signals and history.
 */
class SignalTracker {
  constructor() {
    this.signals = this._load();
    this.lessons = this._loadLessons();
    this.lessonStats = this._loadLessonStats();
    this.history = this._loadHistory();
    this.latestWatchlist = this._loadWatchlist();
    this.latestBinanceSnapshot = this._loadBinanceSnapshot();
    this.dashboardState = this._loadDashboardState();
    this.latestScanReport = this._loadScanReport();
    this.adaptiveTuning = this._loadAdaptiveTuning();
    this.manualResetAt = 0;

    this._migrateLessonStatsFromLessons();
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

  _loadLessonStats() {
    try {
      if (fs.existsSync(LESSON_STATS_PATH)) {
        const parsed = JSON.parse(fs.readFileSync(LESSON_STATS_PATH, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return { daily: {}, statsVersion: 2 };
        if (!parsed.daily || typeof parsed.daily !== 'object') parsed.daily = {};
        return parsed;
      }
    } catch (err) { logger.error('Failed to load lesson stats:', err.message); }
    return { daily: {}, statsVersion: 2 };
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

  _loadScanReport() {
    try {
      if (fs.existsSync(SCAN_REPORT_PATH)) {
        return JSON.parse(fs.readFileSync(SCAN_REPORT_PATH, 'utf8'));
      }
    } catch (err) { logger.error('Failed to load scan report:', err.message); }
    return null;
  }

  _loadAdaptiveTuning() {
    try {
      if (fs.existsSync(ADAPTIVE_TUNING_PATH)) {
        return JSON.parse(fs.readFileSync(ADAPTIVE_TUNING_PATH, 'utf8'));
      }
    } catch (err) { logger.error('Failed to load adaptive tuning:', err.message); }
    return null;
  }

  _save() {
    if (IS_SERVERLESS) {
      if (redisEnabled()) setState(R.signals, this.signals).catch(e => logger.error('[Redis] save signals:', e.message));
      return;
    }

    try {
      fs.writeFileSync(STORAGE_PATH, JSON.stringify(this.signals, null, 2));
    } catch (err) { logger.error('Failed to save signals:', err.message); }
    if (redisEnabled()) setState(R.signals, this.signals).catch(e => logger.error('[Redis] save signals:', e.message));
  }

  _saveLessons() {
    if (IS_SERVERLESS) {
      if (redisEnabled()) setState(R.lessons, this.lessons).catch(e => logger.error('[Redis] save lessons:', e.message));
      return;
    }

    try {
      // Keep only last 15 lessons to keep AI prompts focused
      this.lessons = this.lessons.slice(-15);
      fs.writeFileSync(LESSONS_PATH, JSON.stringify(this.lessons, null, 2));
    } catch (err) { logger.error('Failed to save lessons:', err.message); }
    if (redisEnabled()) setState(R.lessons, this.lessons).catch(e => logger.error('[Redis] save lessons:', e.message));
  }

  _saveLessonStats() {
    if (IS_SERVERLESS) {
      if (redisEnabled()) setState(R.lessonStats, this.lessonStats).catch(e => logger.error('[Redis] save lesson stats:', e.message));
      return;
    }

    try {
      fs.writeFileSync(LESSON_STATS_PATH, JSON.stringify(this.lessonStats, null, 2));
    } catch (err) { logger.error('Failed to save lesson stats:', err.message); }
    if (redisEnabled()) setState(R.lessonStats, this.lessonStats).catch(e => logger.error('[Redis] save lesson stats:', e.message));
  }

  _saveHistory() {
    if (IS_SERVERLESS) {
      if (redisEnabled()) setState(R.history, this.history.slice(-100)).catch(e => logger.error('[Redis] save history:', e.message));
      return;
    }

    try {
      // Keep performance history (e.g. last 100 trades for performance monitoring)
      const trimmed = this.history.slice(-100);
      fs.writeFileSync(HISTORY_PATH, JSON.stringify(trimmed, null, 2));
    } catch (err) { logger.error('Failed to save trade history:', err.message); }
    if (redisEnabled()) setState(R.history, this.history.slice(-100)).catch(e => logger.error('[Redis] save history:', e.message));
  }

  /**
   * Keep a lesson learned from a failed trade.
   * Deduplicates: skips if the same symbol+bias already has a lesson within 24h.
   */
  saveLesson(symbol, bias, analysis, meta = {}) {
    const now = Date.now();
    const dayAgo = now - (24 * 60 * 60 * 1000);
    const kind = meta.kind || 'general';
    const reasonKey = resolveLessonReasonKey({
      reasonKey: meta.reasonKey,
      analysis,
      lessonReason: meta.lessonReason,
      rejectionReason: meta.rejectionReason,
    });
    const duplicate = this.lessons.find(l => 
      l.symbol === symbol && l.bias === bias && l.kind === kind && l.reasonKey === reasonKey && l.timestamp > dayAgo
    );
    if (duplicate) {
      logger.debug(`🧠 [Tracker] Skipping duplicate lesson for ${symbol} (${bias}) - already learned today.`);
      return;
    }

    const lesson = {
      symbol,
      bias,
      analysis,
      timestamp: now,
      kind,
      reasonKey,
      score: meta.score ?? null,
      source: meta.source || null,
    };

    this.lessons.push(lesson);
    this._recordLessonStats(lesson);
    this._saveLessons();
    logger.info(`🧠 [Tracker] Lesson saved for ${symbol}. Total memory: ${this.lessons.length}`);
  }

  getRecentLessons() {
    return this.lessons.slice(-10); // Return last 10 lessons for AI prompt
  }

  getLessonsSince(resetTime = this.getEffectiveResetTime()) {
    return this.lessons.filter((lesson) => (lesson.timestamp || 0) > resetTime);
  }

  _getLessonStatsDay(dayKey = getLessonDayKey()) {
    if (!this.lessonStats.daily) this.lessonStats.daily = {};
    if (!this.lessonStats.daily[dayKey]) {
      this.lessonStats.daily[dayKey] = createLessonStatsDayBucket(dayKey);
    }
    return this.lessonStats.daily[dayKey];
  }

  _recordLessonStats(lesson) {
    if (!lesson || lesson.kind !== 'reject') return;

    const dayKey = getLessonDayKey(lesson.timestamp);
    const bucket = this._getLessonStatsDay(dayKey);
    accumulateLessonStatsBucket(bucket, lesson);
    this.lessonStats.daily[dayKey] = bucket;
    this._saveLessonStats();
  }

  _migrateLessonStatsFromLessons(force = false) {
    if (!this.lessonStats) this.lessonStats = { daily: {}, statsVersion: 2 };
    if (!force && Number(this.lessonStats.statsVersion || 1) >= 2) {
      return false;
    }

    const rebuiltDaily = {};
    for (const lesson of this.lessons || []) {
      if (!lesson || lesson.kind !== 'reject') continue;
      const dayKey = getLessonDayKey(lesson.timestamp || Date.now());
      const bucket = rebuiltDaily[dayKey] || createLessonStatsDayBucket(dayKey);
      rebuiltDaily[dayKey] = accumulateLessonStatsBucket(bucket, lesson);
    }

    this.lessonStats.daily = rebuiltDaily;
    this.lessonStats.statsVersion = 2;
    this.lessonStats.migratedFromLessonsAt = Date.now();
    this._saveLessonStats();
    logger.info(`🧠 [Tracker] Lesson stats migrated from ${Object.keys(rebuiltDaily).length} day buckets.`);
    return true;
  }

  getDailyLessonSummary(resetTime = this.getEffectiveResetTime()) {
    const dayKey = getLessonDayKey(resetTime);
    const todaysRejectLessons = this.getLessonsSince(resetTime).filter((lesson) => lesson.kind === 'reject');
    const bucket = buildRejectLessonBucket(dayKey, todaysRejectLessons);

    const normalizedReasons = {};
    for (const entry of Object.values(bucket.byReason || {})) {
      if (!entry) continue;
      const inferredKey = resolveLessonReasonKey({
        reasonKey: entry.key,
        analysis: entry.lastAnalysis,
        lessonReason: entry.lastAnalysis,
        rejectionReason: entry.lastAnalysis,
      });
      const reasonKey = inferredKey === 'other' ? (entry.key || 'other') : inferredKey;
      const reasonBucket = normalizedReasons[reasonKey] || {
        key: reasonKey,
        label: labelLessonReasonKey(reasonKey),
        count: 0,
        symbols: [],
        lastTimestamp: 0,
        lastAnalysis: '',
      };

      reasonBucket.count += Number(entry.count) || 0;
      reasonBucket.lastTimestamp = Math.max(reasonBucket.lastTimestamp || 0, entry.lastTimestamp || 0);
      if (entry.lastAnalysis && (!reasonBucket.lastAnalysis || (entry.lastTimestamp || 0) >= reasonBucket.lastTimestamp)) {
        reasonBucket.lastAnalysis = String(entry.lastAnalysis).slice(0, 180);
      }
      for (const symbol of entry.symbols || []) {
        if (!reasonBucket.symbols.includes(symbol)) {
          reasonBucket.symbols.push(symbol);
          reasonBucket.symbols = reasonBucket.symbols.slice(-3);
        }
      }

      normalizedReasons[reasonKey] = reasonBucket;
    }
    bucket.byReason = normalizedReasons;

    const topRejectReasons = Object.values(bucket.byReason || {})
      .sort((a, b) => b.count - a.count || b.lastTimestamp - a.lastTimestamp)
      .slice(0, 3)
      .map((entry, index) => ({
        rank: index + 1,
        key: entry.key,
        label: entry.label,
        count: entry.count,
        symbols: entry.symbols || [],
        example: entry.lastAnalysis || '',
      }));

    return {
      dayKey,
      totalLessons: bucket.totalLessons || 0,
      rejectCount: bucket.rejectCount || 0,
      topRejectReasons,
      thresholds: this.getAdaptiveStrategyThresholds(topRejectReasons, bucket.rejectCount || 0),
    };
  }

  getAdaptiveStrategyThresholds(topRejectReasons = [], rejectCount = 0) {
    const baseMinRr = config.strategy.minRrRatio || 2.0;
    const baseStandbyMinRr = config.strategy.standbyMinRr || baseMinRr;
    const baseMinScore = config.strategy.minFinalScore || 25;
    const baseWeights = config.strategy.scoreWeights || {};
    const thresholds = {
      minRrRatio: baseMinRr,
      standbyMinRr: baseStandbyMinRr,
      minFinalScore: baseMinScore,
      scoreWeights: {},
    };

    if (!Array.isArray(topRejectReasons) || rejectCount < 5) {
      return thresholds;
    }

    const dominant = topRejectReasons[0] || null;
    const secondary = topRejectReasons[1] || null;
    const dominantShare = dominant ? dominant.count / rejectCount : 0;
    const secondaryShare = secondary ? secondary.count / rejectCount : 0;

    if (dominant?.key === 'poor_rr' && dominantShare >= 0.35) {
      const drop = rejectCount >= 12 ? 0.35 : 0.2;
      thresholds.minRrRatio = Math.max(1.6, baseMinRr - drop);
      thresholds.standbyMinRr = Math.max(1.6, baseStandbyMinRr - drop);
    }

    if (dominant?.key === 'score_low' && dominantShare >= 0.35) {
      const drop = rejectCount >= 12 ? 5 : 3;
      thresholds.minFinalScore = Math.max(20, baseMinScore - drop);
    }

    if (dominant?.key === 'middle_zone' && dominantShare >= 0.35) {
      const drop = rejectCount >= 12 ? 4 : 2;
      thresholds.minFinalScore = Math.max(18, baseMinScore - drop);
      thresholds.scoreWeights.middleZonePenalty = Math.max(0, (baseWeights.middleZonePenalty ?? 1) - 1);
      thresholds.scoreWeights.noStructurePenalty = Math.max(1, (baseWeights.noStructurePenalty ?? 2) - 1);
    }

    if (dominant?.key === 'low_volatility' && dominantShare >= 0.35) {
      const drop = rejectCount >= 12 ? 3 : 2;
      thresholds.minFinalScore = Math.max(18, baseMinScore - drop);
      thresholds.scoreWeights.lowVolPenalty = Math.max(2, (baseWeights.lowVolPenalty ?? 4) - 1);
    }

    if (dominant?.key === 'weak_trend' && dominantShare >= 0.35) {
      const drop = rejectCount >= 12 ? 2 : 1;
      thresholds.minFinalScore = Math.max(18, baseMinScore - drop);
      thresholds.scoreWeights.nearLevelDirectionalBias = Math.min(14, (baseWeights.nearLevelDirectionalBias ?? 12) + 1);
    }

    if (
      dominant?.key === 'poor_rr' &&
      secondary?.key === 'score_low' &&
      dominantShare >= 0.25 &&
      secondaryShare >= 0.25
    ) {
      thresholds.minRrRatio = Math.max(1.6, Math.min(thresholds.minRrRatio, baseMinRr - 0.3));
      thresholds.minFinalScore = Math.max(20, Math.min(thresholds.minFinalScore, baseMinScore - 4));
    }

    if (dominant?.key === 'trend_conflict' && dominantShare >= 0.4) {
      thresholds.minFinalScore = Math.max(thresholds.minFinalScore, 24);
    }

    return thresholds;
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
    this.lessonStats = { daily: {} };
    this._saveLessons();
    this._saveLessonStats();
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
    if (IS_SERVERLESS) {
      if (redisEnabled()) setState(R.watchlist, this.latestWatchlist).catch(e => logger.error('[Redis] save watchlist:', e.message));
      return;
    }

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
    if (IS_SERVERLESS) {
      return;
    }

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
    if (IS_SERVERLESS) {
      if (redisEnabled()) setState(R.dashboard, this.dashboardState).catch(e => logger.error('[Redis] save dashboard:', e.message));
      return;
    }

    try {
      fs.writeFileSync(DASHBOARD_STATE_PATH, JSON.stringify(this.dashboardState, null, 2));
    } catch (err) {
      logger.error('Failed to save dashboard state:', err.message);
    }
    if (redisEnabled()) setState(R.dashboard, this.dashboardState).catch(e => logger.error('[Redis] save dashboard:', e.message));
  }

  saveScanReport(report) {
    this.latestScanReport = report || null;
    if (IS_SERVERLESS) {
      if (redisEnabled()) setState(R.scanReport, this.latestScanReport).catch(e => logger.error('[Redis] save scan report:', e.message));
      return;
    }

    try {
      fs.writeFileSync(SCAN_REPORT_PATH, JSON.stringify(this.latestScanReport, null, 2));
    } catch (err) {
      logger.error('Failed to save scan report:', err.message);
    }
    if (redisEnabled()) setState(R.scanReport, this.latestScanReport).catch(e => logger.error('[Redis] save scan report:', e.message));
  }

  saveAdaptiveTuning(suggestion) {
    this.adaptiveTuning = normalizeAdaptiveTuningSuggestion(suggestion || {});
    if (IS_SERVERLESS) {
      if (redisEnabled()) setState(R.adaptiveTuning, this.adaptiveTuning).catch(e => logger.error('[Redis] save adaptive tuning:', e.message));
      return this.adaptiveTuning;
    }

    try {
      fs.writeFileSync(ADAPTIVE_TUNING_PATH, JSON.stringify(this.adaptiveTuning, null, 2));
    } catch (err) {
      logger.error('Failed to save adaptive tuning:', err.message);
    }
    if (redisEnabled()) setState(R.adaptiveTuning, this.adaptiveTuning).catch(e => logger.error('[Redis] save adaptive tuning:', e.message));
    return this.adaptiveTuning;
  }

  getAdaptiveTuning() {
    return this.adaptiveTuning || null;
  }

  shouldRefreshAdaptiveTuning(lessonSummary = null) {
    const tuning = this.getAdaptiveTuning();
    const rejectCount = Number(lessonSummary?.rejectCount) || 0;
    const dayKey = lessonSummary?.dayKey || null;
    const minLessons = config.strategy.tuning?.minLessonsForSuggestion || 5;

    if (rejectCount < minLessons) return false;
    if (!tuning) return true;
    if (dayKey && tuning.sourceDayKey && dayKey !== tuning.sourceDayKey) return true;
    if (Number.isFinite(tuning.sourceRejectCount) && rejectCount >= tuning.sourceRejectCount + (config.strategy.tuning?.refreshDeltaRejects || 5)) {
      return true;
    }
    return false;
  }

  getEffectiveAdaptiveThresholds(lessonSummary = null) {
    const base = lessonSummary?.thresholds || {
      minRrRatio: config.strategy.minRrRatio,
      standbyMinRr: config.strategy.standbyMinRr,
      minFinalScore: config.strategy.minFinalScore || 22,
    };
    const tuning = this.getAdaptiveTuning();
    if (!tuning || tuning.status !== 'APPLY') {
      return {
        ...base,
      };
    }

    return {
      minRrRatio: tuning.thresholds?.minRrRatio ?? base.minRrRatio,
      standbyMinRr: tuning.thresholds?.standbyMinRr ?? base.standbyMinRr,
      minFinalScore: tuning.thresholds?.minFinalScore ?? base.minFinalScore,
      scoreWeights: {
        ...(config.strategy.scoreWeights || {}),
        ...(base.scoreWeights || {}),
        ...(tuning.scoreWeights || {}),
      },
    };
  }

  getScanReport() {
    return this.latestScanReport || null;
  }

  /**
   * Load all state from Upstash Redis (called at startup in run_once.js).
   * Local JSON files are used as fallback when Redis data is absent.
   */
  async syncFromRedis() {
    if (!redisEnabled()) return;
    logger.info('📥 [Tracker] Loading state from Upstash Redis...');

    const [signals, lessons, lessonStats, history, watchlist, dashboard, scanReport, adaptiveTuning] = await Promise.all([
      getState(R.signals),
      getState(R.lessons),
      getState(R.lessonStats),
      getState(R.history),
      getState(R.watchlist),
      getState(R.dashboard),
      getState(R.scanReport),
      getState(R.adaptiveTuning),
    ]);

    if (signals)   { this.signals = signals;           logger.info(`  ✅ signals: ${Object.keys(signals).length} active`); }
    if (lessons)   { this.lessons = lessons;           logger.info(`  ✅ lessons: ${lessons.length}`); }
    if (lessonStats) { this.lessonStats = lessonStats;  logger.info('  ✅ lesson stats loaded'); }
    if (history)   { this.history = history;           logger.info(`  ✅ history: ${history.length} trades`); }
    if (watchlist) { this.latestWatchlist = watchlist; logger.info(`  ✅ watchlist: ${watchlist.length}`); }
    if (dashboard) { this.dashboardState = dashboard; }
    if (scanReport) { this.latestScanReport = scanReport; }
    if (adaptiveTuning) { this.adaptiveTuning = adaptiveTuning; logger.info('  ✅ adaptive tuning loaded'); }

    logger.info('✅ [Tracker] Redis sync complete.');
  }

  /**
   * Force-push all current state to Redis (called at end of run_once.js).
   */
  async syncToRedis() {
    if (!redisEnabled()) return;
    logger.info('📤 [Tracker] Pushing state to Upstash Redis...');
    await Promise.all([
      setState(R.signals,   this.signals),
      setState(R.lessons,   this.lessons),
      setState(R.lessonStats, this.lessonStats),
      setState(R.history,   this.history.slice(-100)),
      setState(R.watchlist, this.latestWatchlist),
      setState(R.dashboard, this.dashboardState),
      setState(R.scanReport, this.latestScanReport),
      setState(R.adaptiveTuning, this.adaptiveTuning),
    ]);
    logger.info('✅ [Tracker] Redis push complete.');
  }
}

module.exports = new SignalTracker();
