const config = require('../../config');
const logger = require('../../utils/logger');
const sleep = require('../../utils/sleep');
const { 
  fetchTopPairs, fetchMultiTimeframe, fetch24hTicker, 
  fetchFuturesBalance, fetchOHLCV, fetchExchangeSpecs, primePublicProviderChain, getProviderHealth, toFuturesSymbol,
} = require('../data/bybit');
const { analyzeTrend } = require('../indicators');
const { applyFilters } = require('../filter');
const { evaluateSignal, calculateRiskReward } = require('../strategy');
const { refineSignal, analyzePostMortem, generateAdaptiveTuningSuggestion } = require('../ai/openrouter');
const { sendSignal, sendStatus } = require('../../services/signal_delivery');
const { maybeSendDiscordNotifications } = require('../../services/discord_notifications');
const tracker = require('../tracker');
const { claimSignalDedupe, getSignalCandleTime, releaseSignalDedupe } = require('../../utils/signal_dedupe');
const { logAudit, initAudit } = require('../../utils/audit');
const IS_SERVERLESS = Boolean(process.env.VERCEL || process.env.VERCEL_ENV || process.env.AWS_LAMBDA_FUNCTION_NAME);

function normalizeLessonText(text, maxLength = 500) {
  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return normalized.slice(0, maxLength).trim();
}

function formatScoreHint(result) {
  const diagnostics = result?.diagnostics || {};
  const finalScore = Number.isFinite(diagnostics.finalScore) ? diagnostics.finalScore : null;
  const longScore = Number.isFinite(diagnostics.longScore) ? diagnostics.longScore : null;
  const shortScore = Number.isFinite(diagnostics.shortScore) ? diagnostics.shortScore : null;

  if (finalScore != null) return `score ${finalScore}/100`;
  if (longScore != null || shortScore != null) {
    return `score L${longScore ?? 0}/S${shortScore ?? 0}`;
  }
  return 'score n/a';
}

function classifyStrategyLessonReason(result = {}) {
  const text = [
    result?.lessonReason,
    result?.rejectionReason,
    result?.standbyReason,
    result?.diagnostics?.warnings?.join(' '),
    result?.diagnostics?.reasons?.join(' '),
    result?.diagnostics?.tags?.join(' '),
  ].filter(Boolean).join(' ').toLowerCase();

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
  if (text.includes('poor r:r') || text.includes('need min 2.0') || text.includes('r:r ratio')) return 'poor_rr';
  if (text.includes('weighted score too low') || text.includes('score terlalu rendah')) return 'score_low';
  if (text.includes('standby')) return 'standby';
  if (text.includes('signal lolos validasi') || text.includes('terkirim')) return 'accepted';
  if (text.includes('no pairs')) return 'no_pairs';
  if (text.includes('no signal')) return 'no_signal';
  if (text.includes('error')) return 'error';
  return 'other';
}

function buildOutcomeLessonDiagnostics(source, candidate = null) {
  const sourceAnalysis = source?.analysis || null;
  const candidateAnalysis = candidate?.analysis || null;
  const analysis = sourceAnalysis && Object.keys(sourceAnalysis).length > 0
    ? sourceAnalysis
    : candidateAnalysis;
  const scoreValue = Number.isFinite(source?.score)
    ? source.score
    : Number.isFinite(candidate?.score)
      ? candidate.score
      : null;

  return {
    bias: source?.bias || candidate?.bias || 'UNKNOWN',
    finalScore: scoreValue,
    longScore: scoreValue,
    shortScore: scoreValue,
    reasons: source?.reasons || candidate?.reasons || [],
    warnings: source?.warnings || candidate?.warnings || [],
    tags: source?.tags || candidate?.tags || [],
    analysis,
    riskReward: source?.riskReward || candidate?.riskReward || null,
    pricePosition: sourceAnalysis?.pricePosition || candidateAnalysis?.pricePosition || null,
    trends: {
      d1: sourceAnalysis?.d1Trend?.direction || candidateAnalysis?.d1Trend?.direction || null,
      h4: sourceAnalysis?.h4Trend?.direction || candidateAnalysis?.h4Trend?.direction || null,
      h1: sourceAnalysis?.h1Trend?.direction || candidateAnalysis?.h1Trend?.direction || null,
    },
    structure: sourceAnalysis?.h1Structure
      ? {
          structure: sourceAnalysis.h1Structure.structure || null,
          bos: Boolean(sourceAnalysis.h1Structure.bos),
          bosType: sourceAnalysis.h1Structure.bosType || null,
          pendingBosType: sourceAnalysis.h1Structure.pendingBosType || null,
        }
      : candidateAnalysis?.h1Structure
        ? {
            structure: candidateAnalysis.h1Structure.structure || null,
            bos: Boolean(candidateAnalysis.h1Structure.bos),
            bosType: candidateAnalysis.h1Structure.bosType || null,
            pendingBosType: candidateAnalysis.h1Structure.pendingBosType || null,
          }
        : null,
  };
}

function buildStrategyLessonText(symbol, result, scanReport = null, candidate = null) {
  const diagnostics = result?.diagnostics || {};
  const lessonReason = result?.lessonReason || result?.rejectionReason || 'Setup ditolak';
  const reasonKey = result?.reasonKey || classifyStrategyLessonReason(result);
  const bias = diagnostics.bias || candidate?.bias || 'UNKNOWN';
  const scoreHint = formatScoreHint(result);
  const rr = diagnostics.riskReward?.rr;
  const rrHint = Number.isFinite(rr) ? `R:R ${rr.toFixed(2)}` : 'R:R n/a';
  const trendHint = diagnostics.trends?.d1 && diagnostics.trends?.h4
    ? `D1 ${diagnostics.trends.d1} vs H4 ${diagnostics.trends.h4}`
    : null;
  const structureHint = diagnostics.structure?.structure
    ? `H1 ${diagnostics.structure.structure}${diagnostics.structure.bosType ? ` (${diagnostics.structure.bosType})` : ''}`
    : null;
  const extraHints = [
    trendHint,
    structureHint,
    diagnostics.pricePosition ? `posisi ${diagnostics.pricePosition}` : null,
    diagnostics.warnings?.[0] ? diagnostics.warnings[0].replace(/^⚠️\s*/, '') : null,
  ].filter(Boolean);

  const scanNote = scanReport && scanReport.status && !['RUNNING', 'SIGNALS_SENT'].includes(scanReport.status)
    ? `Scan ${scanReport.status}`
    : null;

  const reasonLeadMap = {
    trend_conflict: `Trend conflict ${diagnostics.trends?.d1 || 'n/a'} vs ${diagnostics.trends?.h4 || 'n/a'}`,
    low_volume: 'Volume 24h terlalu kecil',
    low_volatility: 'ATR terlalu kecil',
    weak_trend: 'Trend terlalu lemah',
    middle_zone: 'Middle zone / tanpa edge',
    level_touch_low: 'Support/Resistance belum kuat',
    retest_pending: 'Retest belum confirmed',
    structure_weak: 'Struktur H1 belum valid',
    entry_unconfirmed: 'Entry belum confirmed di level kuat',
    fomo: 'Entry terlalu jauh dari level',
    atr_spike: 'ATR spike / candle abnormal',
    poor_rr: `R:R terlalu kecil (${rrHint})`,
    score_low: `Score terlalu rendah (${scoreHint})`,
    standby: 'Setup masih standby',
    accepted: 'Signal lolos validasi',
    no_pairs: 'Tidak ada pair yang bisa diproses',
    no_signal: 'Cycle tanpa signal',
    error: 'Cycle error',
  };
  const reasonLead = reasonLeadMap[reasonKey] || lessonReason.replace(/\.$/, '');

  const text = [
    `${symbol}: ${reasonLead}`,
    `${scoreHint}, ${rrHint}, bias ${bias}`,
    extraHints.length > 0 ? extraHints.join('; ') : null,
    scanNote,
  ].filter(Boolean).join('. ');

  return normalizeLessonText(text);
}

function buildCycleLessonText(scanReport, sentCount) {
  const topErrors = Array.isArray(scanReport?.errors) ? scanReport.errors.slice(0, 2).join('; ') : '';
  const phases = scanReport?.phaseBreakdown || {};
  const topFailurePhase = summarizeTopFailurePhase(phases);
  const summary = [
    `Scan ${scanReport?.status || 'UNKNOWN'} selesai`,
    `signal ${sentCount || 0}`,
    `candidate ${scanReport?.candidateCount || 0}`,
    `watchlist ${scanReport?.watchlistCount || 0}`,
    `error ${scanReport?.errorCount || 0}`,
    topFailurePhase ? `top fail ${topFailurePhase}` : null,
    Number.isFinite(phases.preFilterRejected) ? `prefilter gagal ${phases.preFilterRejected}` : null,
    Number.isFinite(phases.strategyRejected) ? `strategy gagal ${phases.strategyRejected}` : null,
    Number.isFinite(phases.aiRejected) ? `AI gagal ${phases.aiRejected}` : null,
    topErrors || null,
  ].filter(Boolean).join('. ');

  return normalizeLessonText(summary);
}

function summarizeTopFailurePhase(phaseBreakdown = {}) {
  const phases = [
    { label: 'Pre-filter', count: Number(phaseBreakdown.preFilterRejected) || 0 },
    { label: 'Strategy', count: Number(phaseBreakdown.strategyRejected) || 0 },
    { label: 'AI', count: Number(phaseBreakdown.aiRejected) || 0 },
    { label: 'Confirmation', count: Number(phaseBreakdown.confirmationRejected) || 0 },
  ].sort((a, b) => b.count - a.count);

  const top = phases[0];
  if (!top || top.count <= 0) return null;
  return `${top.label} (${top.count})`;
}

function recordStrategyLesson(tracker, symbol, result, scanReport, candidate = null, meta = {}) {
  if (!tracker || typeof tracker.saveLesson !== 'function') return;
  const reasonKey = meta.reasonKey || result?.reasonKey || classifyStrategyLessonReason(result);
  const lessonText = buildStrategyLessonText(symbol, { ...result, reasonKey }, scanReport, candidate);
  const bias = result?.diagnostics?.bias || candidate?.bias || 'UNKNOWN';
  const kind = meta.kind || result?.kind || (['accepted', 'standby'].includes(reasonKey) ? reasonKey : 'reject');
  tracker.saveLesson(symbol, bias, lessonText, {
    kind,
    reasonKey,
    score: result?.diagnostics?.finalScore ?? result?.score ?? candidate?.score ?? null,
    source: meta.source || 'scanner',
  });
}

/**
 * Run a single scan cycle:
 * 1. Monitor active trades for TP/SL
 * 2. Fetch top pairs
 * 3. Filter and evaluate
 * 4. Send to AI and delivery channels
 *
 * @returns {Promise<number>} Number of signals sent
 */
async function runScanCycle() {
  const startTime = Date.now();
  const scanReport = {
    startedAt: startTime,
    finishedAt: null,
    durationMs: null,
    status: 'RUNNING',
    signalCount: 0,
    watchlistCount: 0,
    candidateCount: 0,
    strictCount: 0,
    filteredCount: 0,
    rejectedCount: 0,
    errorCount: 0,
    errors: [],
    checks: {},
    phaseBreakdown: {
      preFilterRejected: 0,
      preFilterPassed: 0,
      strategyRejected: 0,
      strategyWatchlist: 0,
      strategyCandidate: 0,
      aiRejected: 0,
      aiWatchlist: 0,
      confirmationRejected: 0,
      delivered: 0,
    },
  };
  logger.info('═══════════════════════════════════════════════');
  logger.info('🔍 Starting scan cycle...');
 
  let sentCount = 0;
  let dailyCount = 0;
  let globalSlToday = 0;
  const pushScanError = (message) => {
    scanReport.errorCount++;
    if (scanReport.errors.length < 8) {
      scanReport.errors.push(message);
    }
  };

  try {
    // ─── -1. Global Daily Limit Check ───
    dailyCount = tracker.getDailyTradeCount();
    globalSlToday = tracker.getGlobalSLCountToday();
    scanReport.checks.dailyCount = dailyCount;
    scanReport.checks.globalSlToday = globalSlToday;

    // ─── 0. Early Exit Check (Hard Killswitch) ───
    // Rule: Stop all trades if we hit 3 SLs globally in a day (Resets 00:00 WIB)
    if (globalSlToday >= 3) {
      logger.info(`🚫 Global Killswitch Active: ${globalSlToday}/3 Stop Loss hits today. Scanning suspended until 00:00 WIB reset.`);
      scanReport.status = 'GLOBAL_KILLSWITCH';
      scanReport.checks.killswitch = true;
      await checkActiveTrades(); // Still check existing trades for accuracy
      return 0;
    }

    logger.info(`📈 Daily Status: ${dailyCount}/5 total trades, ${globalSlToday}/3 SL hits.`);

    // ─── 0. Fetch Real Balance & Exchange Specs ───
    // We fetch specs to ensure Lot Size (Step size) and Min Notional compliance
    await primePublicProviderChain();
    const [balance, exchangeSpecs] = await Promise.all([
        fetchFuturesBalance(),
        fetchExchangeSpecs()
    ]);
    
    const effectiveBalance = balance > 0 ? balance : config.strategy.accountBalance;
    scanReport.checks.balance = balance > 0 ? balance : null;
    if (balance > 0) {
      logger.info(`💰 Current Futures Balance: $${balance.toFixed(2)} USDT`);
    } else {
      logger.warn(`⚠️ Could not fetch real balance, using fallback: $${config.strategy.accountBalance}`);
      pushScanError('Futures balance unavailable; fallback balance used.');
    }

    // ─── 1. Monitor Active Trades ──────────────────────────
    // Now returns symbols that hit TP/SL to prevent re-tracking in SAME cycle
    const hitSymbols = await checkActiveTrades();
    scanReport.checks.hitSymbols = hitSymbols.length;

    // ─── 1. Fetch top pairs by volume ──────────────────────
    const pairs = await fetchTopPairs();
    if (!pairs.length) {
      logger.warn('No pairs fetched, aborting cycle');
      scanReport.status = 'NO_PAIRS';
      scanReport.errors.push('No pairs fetched');
      return 0;
    }
    scanReport.checks.pairs = pairs.length;

    // ─── Market Regime: Fetch BTC Trend ───
    let btcTrend = 'NEUTRAL';
    try {
        const btcCandles = await fetchOHLCV('BTCUSDT', config.timeframes.D1, 50);
        if (Array.isArray(btcCandles) && btcCandles.length > 0) {
            const trend = analyzeTrend(btcCandles);
            btcTrend = trend.direction;
            logger.info(`🌐 Market Regime: BTC D1 is ${btcTrend}`);
        }
    } catch (err) {
      logger.error('Failed to fetch BTC trend for market regime:', err.message);
      pushScanError(`BTC regime fetch failed: ${err.message}`);
    }
    scanReport.checks.btcTrend = btcTrend;
    const lessonSummary = tracker.getDailyLessonSummary ? tracker.getDailyLessonSummary() : null;
    scanReport.adaptiveThresholds = lessonSummary?.thresholds || {
      minRrRatio: config.strategy.minRrRatio,
      standbyMinRr: config.strategy.standbyMinRr,
      minFinalScore: config.strategy.minFinalScore || 25,
    };

    // 2. Filter + evaluate each pair
    const candidates = [];
    const technicalWatchlist = [];
    let filtered = 0;
    let rejected = 0;
    let errors = 0;

    for (const symbol of pairs) {
    // Skip if just hit TP/SL in this cycle to avoid duplicate signals
    if (hitSymbols.includes(symbol.toUpperCase())) {
      logger.info(`⏭️ Skipping ${symbol} - just hit TP/SL in this cycle.`);
      continue;
    }

    // ─── Pair-Specific Constraints Check ───
    const sym = symbol.toUpperCase();
    const stats = tracker.getPairStats(sym, 'ANY'); 
    
    // Rule: After 2 SL on BASE ASSET -> 24h no trade
    if (stats.slHits >= 2) {
      logger.info(`🚫 Skipping ${sym}: Base Asset (${stats.baseAsset}) on cooldown (2 SL hits in 24h)`);
      logAudit(sym, 'PRE-FILTER', 'REJECTED', 0, 'Asset SL Cooldown (2 hits in 24h)');
      continue;
    }

    try {
      // Quick filter: fetch ticker first (cheap API call)
      const ticker = await fetch24hTicker(symbol);
      if (!ticker) {
        scanReport.checks.tickerUnavailable = (scanReport.checks.tickerUnavailable || 0) + 1;
        scanReport.phaseBreakdown.preFilterRejected++;
        continue;
      }

      // Fetch H4 candles for pre-filter so the early gate matches the actual
      // H4 support/resistance strategy.
      const h4Candles = await fetchOHLCV(symbol, config.timeframes.H4, 50);

      if (!Array.isArray(h4Candles) || h4Candles.length === 0) {
        errors++;
        pushScanError(`No H4 candles for ${symbol}`);
        scanReport.phaseBreakdown.preFilterRejected++;
        continue;
      }

      await sleep(config.binance.rateLimitMs);

      const h4Trend = analyzeTrend(h4Candles, config.indicators.ema);
      const filterResult = applyFilters({
        symbol,
        ticker,
        trend: h4Trend,
        candles: h4Candles,
      });

      if (!filterResult.pass) {
        filtered++;
        scanReport.filteredCount++;
        scanReport.phaseBreakdown.preFilterRejected++;
        logAudit(symbol, 'PRE-FILTER', 'REJECTED', 0, filterResult.reasons.join(', '));
        continue;
      }
      scanReport.phaseBreakdown.preFilterPassed++;

      // Passed filter → fetch multi-TF data for support/resistance + structure
      logger.info(`📊 ${symbol} passed pre-filters, fetching multi-TF data...`);
      logAudit(symbol, 'PRE-FILTER', 'PASSED', 0, 'Trend / support / resistance confirmed');
      const mtfData = await fetchMultiTimeframe(symbol);
      
      if (!mtfData) {
        errors++;
        pushScanError(`Multi-timeframe fetch failed for ${symbol}`);
        continue;
      }

      // Run strategy evaluation (includes hard kill-switches + R:R check)
      const futuresSym = toFuturesSymbol(symbol);
      const specs = exchangeSpecs[futuresSym] || { stepSize: 0.001, minNotional: 5.0 };

      const result = evaluateSignal(symbol, mtfData, { 
          accountBalance: effectiveBalance,
          stepSize: specs.stepSize,
          minNotional: specs.minNotional,
          minRrRatio: scanReport.adaptiveThresholds?.minRrRatio,
          minFinalScore: scanReport.adaptiveThresholds?.minFinalScore,
          standbyMinRr: scanReport.adaptiveThresholds?.standbyMinRr,
          scoreWeights: scanReport.adaptiveThresholds?.scoreWeights,
          includeRejectionReason: true
      });
      
      // evaluateSignal returns:
      //   Success: raw signal object { symbol, bias, score, ... }
      //   Rejection: { signal: null, rejectionReason: '...' }
      const isRejection = result && result.signal === null && result.rejectionReason;
      const signal = isRejection ? null : result;

      if (isRejection) {
        recordStrategyLesson(tracker, symbol, {
          ...result,
          lessonReason: result.rejectionReason,
        }, scanReport);
      }

      if (signal && signal.standbyOnly) {
        scanReport.watchlistCount++;
        scanReport.phaseBreakdown.strategyWatchlist++;
        recordStrategyLesson(tracker, signal.symbol || symbol, {
          lessonReason: signal.standbyReason || 'Setup masih standby',
          rejectionReason: signal.standbyReason || 'Setup masih standby',
          diagnostics: buildOutcomeLessonDiagnostics(signal),
        });
        technicalWatchlist.push({
          symbol: signal.symbol,
          score: signal.score,
          reason: signal.standbyReason,
          bias: 'WATCHLIST',
          entry: signal.riskReward?.entry,
          riskReward: signal.riskReward,
          quality: 'WATCHLIST',
          trading_type: signal.trading_type || 'MONITORING',
        });
        logger.info(`👀 ${symbol}: standby setup only (R:R ${signal.riskReward?.rr?.toFixed(2) || 'N/A'})`);
        logAudit(symbol, 'STRATEGY', 'WATCHLIST', signal.score, signal.standbyReason);
      } else if (signal) {
        signal.candles = mtfData.H1; // Save candles for the chart later
        candidates.push(signal);
        scanReport.candidateCount++;
        scanReport.phaseBreakdown.strategyCandidate++;
        logger.info(`✅ ${symbol}: ${signal.bias} (score: ${signal.score})`);
        logAudit(symbol, 'STRATEGY', 'PASSED', signal.score, signal.reasons.join(', '));
      } else {
        rejected++;
        scanReport.rejectedCount++;
        scanReport.phaseBreakdown.strategyRejected++;
        const reason = isRejection ? result.rejectionReason : 'Technical requirements not met';
        logAudit(symbol, 'STRATEGY', 'REJECTED', 0, reason);
      }

      await sleep(config.binance.rateLimitMs);
    } catch (err) {
      logger.error(`Error processing ${symbol}:`, err.message);
      errors++;
      pushScanError(`${symbol}: ${err.message}`);
    }
  }

  // 3. Selection & Batching
  const qualityCandidates = candidates.filter((c) => c.isStrict);
  const okCandidates = candidates.filter((c) => !c.isStrict);
  scanReport.checks.qualityCandidates = qualityCandidates.length;
  scanReport.checks.okCandidates = okCandidates.length;
  const isDailyLimitReached = dailyCount >= 5;
  
  const finalPool = isDailyLimitReached
    ? qualityCandidates.filter(c => c.score >= 82)
    : [...qualityCandidates, ...okCandidates].slice(0, 5 - dailyCount);

  if (isDailyLimitReached && finalPool.length > 0) {
    logger.info(`🌟 [Awesome Exception] Found ${finalPool.length} elite signals despite daily limit!`);
  }

  // NOTE: We no longer early-return here. Even if finalPool is empty, we still
  // want to run the Best Alternative logic at the end using `candidates` pool.
  if (!finalPool.length) {
    if (isDailyLimitReached) {
        logger.info('🚫 Daily trade limit reached (5/5). No elite signals found.');
    } else {
        logger.info('⛔ No strict signals. Will attempt Best Alternative from all candidates.');
    }
  }

  // 4. Validation & Delivery
  let sentCount = 0;
  const rejections = [...technicalWatchlist];

  // Inform user about technical candidates found
  if (sentCount === 0 && rejections.length > 0) {
    const watchlist = rejections.filter(r => r.quality === 'WATCHLIST');
    if (watchlist.length > 0) {
      const msg = `📡 *𝐑𝐞𝐬𝐮𝐥𝐭: 𝐇𝐢𝐠𝐡 𝐀𝐥𝐞𝐫𝐭 𝐖𝐚𝐭𝐜𝐡𝐥𝐢𝐬𝐭*\n\n` +
                  watchlist.map(r => {
                    const rr = r.riskReward?.rr ? r.riskReward.rr.toFixed(2) : 'N/A';
                    return `• *${r.symbol}* (Score ${r.score}) 📋 WATCHLIST | R:R: \`${rr}\`\n  _${r.reason}_`;
                  }).join('\n\n') +
                  `\n\n🛡️ *Status:* Standing by. Waiting for Market Regime shift or better RR Ratio.`;

      await sendStatus(msg);
    }
  }

  for (const candidate of finalPool) {
    try {
      const refined = await refineSignal(candidate, { btcTrend });

        if (!refined) {
          logger.info(`AI returned no response for ${candidate.symbol}`);
          logAudit(candidate.symbol, 'AI', 'ERROR', candidate.score, 'Empty AI Response');
          scanReport.phaseBreakdown.aiRejected++;
          continue;
        }

      // ─── Inherit Deterministic Risk/Reward ───
      if (refined.bias === 'LONG' || refined.bias === 'SHORT') {
          refined.riskReward = candidate.riskReward;
          refined.candles = candidate.candles; // for chart
          if (!refined.riskReward) {
              logger.warn(`⚠️ ${candidate.symbol}: Risk calculation missing from deterministic candidate.`);
              continue;
          }
      }

      // AI said NO TRADE or WATCHLIST
      if (refined.bias === 'NO TRADE' || refined.bias === 'NO_TRADE' || refined.bias === 'WATCHLIST') {
        const isWatchlist = refined.bias === 'WATCHLIST';
        logger.info(`${isWatchlist ? '👀' : '🚫'} ${candidate.symbol}: AI ${isWatchlist ? 'Watchlist' : 'Rejected'} — ${refined.reason}`);
        
        logAudit(candidate.symbol, 'AI', isWatchlist ? 'WATCHLIST' : 'REJECTED', candidate.score, refined.reason);
        if (isWatchlist) {
          scanReport.phaseBreakdown.aiWatchlist++;
        } else {
          scanReport.phaseBreakdown.aiRejected++;
        }
        rejections.push({ 
            symbol: candidate.symbol, 
            score: candidate.score, 
            reason: refined.reason, 
            bias: refined.bias && refined.bias !== 'NO TRADE' ? refined.bias : candidate.bias,
            entry: refined.entry || candidate.entry,
            riskReward: refined.riskReward || candidate.riskReward,
            quality: refined.quality || (isWatchlist ? 'WATCHLIST' : 'LOW') 
        });
        continue;
      }
      
      // ─── Deduplication / Update Check ───
      const active = tracker.getActive(candidate.symbol);
      let isUpdate = false;

      if (active) {
        const ticker = await fetch24hTicker(candidate.symbol);
        const currentPrice = ticker ? parseFloat(ticker.lastPrice) : refined.entry;

        // Check if trade is "Running in Profit"
        const isRunningInProfit = active.bias === 'LONG' 
            ? currentPrice > active.entry 
            : currentPrice < active.entry;

        if (isRunningInProfit) {
            logger.info(`🧠 [Tracker] ${candidate.symbol} is already running in profit. Skipping update message.`);
            logAudit(candidate.symbol, 'AI', 'SKIPPED', refined.confidence, 'Trade already active and running in profit.');
            continue; 
        }

        const diffEntry = Math.abs(refined.entry - active.entry) / active.entry;
        
        if (refined.bias === active.bias) {
          // SAME BIAS: Never invalidate an active trade. Just send an advisory update if entry shifted.
          if (diffEntry > 0.02) {
            logger.info(`🔄 ${candidate.symbol}: Entry shifted significantly (${(diffEntry*100).toFixed(1)}%), sending advisory update.`);
            await sendStatus(`🔄 *ADVISORY UPDATE: ${candidate.symbol}*\n_Setup teknikal sedikit geser, tapi trade awal lo masih VALID._\n• *New Entry Area:* \`${refined.entry}\`\n• *Status:* Ongoing trade (Keep your original SL/TP).`);
          } else {
             logger.info(`🔄 ${candidate.symbol}: Skipping duplicate signal for active trade.`);
          }
          logAudit(candidate.symbol, 'AI', 'SKIPPED', refined.confidence, `Already active (Bias Match) - Keeping original trade.`);
          continue; 
        } else {
          // BIAS CHANGED: Warn the user, but still don't force invalidate. They decide.
          logger.info(`⚠️ ${candidate.symbol}: Bias conflict detected (${active.bias} vs ${refined.bias})`);
          await sendStatus(`⚠️ *WARNING: BIAS CONFLICT ${candidate.symbol}*\n_Bot nemu setup baru dengan bias berlawanan (${active.bias} ke ${refined.bias})._\n• *Action:* Trade lama lo masih aktif di memori. Consider untuk manual close jika trend sudah patah.`);
          logAudit(candidate.symbol, 'AI', 'WARNING', refined.confidence, `Bias Conflict: ${active.bias} -> ${refined.bias}`);
          continue;
        }
      }

      // ─── Live Confirmation Engine ───
      // Serverless mode skips the 3m wait to keep the request bounded.
      const skipLiveConfirmation = process.env.SKIP_LIVE_CONFIRMATION === '1';
      const latestTicker = await fetch24hTicker(candidate.symbol);
      const currentPriceLive = latestTicker ? parseFloat(latestTicker.lastPrice) : refined.entry;

      if (!skipLiveConfirmation) {
        // Cek ulang kondisi harga beberapa saat sebelum dikirim (Anti-Fakeout)
        logger.info(`⏳ [Live Confirmation] Memantau pergerakan harga ${candidate.symbol} selama 3 menit...`);

        await sleep(3 * 60 * 1000); // Wait 3 minutes

        const recheckTicker = await fetch24hTicker(candidate.symbol);
        const recheckPrice = recheckTicker ? parseFloat(recheckTicker.lastPrice) : refined.entry;

        // Hitung slippage/pergeseran dari entry AI
        const slippage = Math.abs(recheckPrice - refined.entry) / refined.entry;

        // FIX: 0.5% dalam 3 menit adalah volatilitas abnormal (news/fakeout). Reject!
        if (slippage > 0.005) {
          logger.warn(`🚫 [Live Confirmation Failed] ${candidate.symbol} price slipped ${(slippage*100).toFixed(2)}% during 3m window.`);
          logAudit(candidate.symbol, 'CONFIRMATION', 'REJECTED', refined.confidence, `Price slipped ${(slippage*100).toFixed(1)}% in 3 mins.`);
          scanReport.phaseBreakdown.confirmationRejected++;
          continue;
        }
      }

      // FIX 1: Refresh data entry karena candle H1 sudah 'stale', apalagi setelah kena delay 3 menit Live Confirm
      const freshEntry = currentPriceLive;
      const futuresSym = toFuturesSymbol(candidate.symbol);
      const freshRR = calculateRiskReward(
        refined.bias, 
        freshEntry, 
        candidate.analysis?.h4SR,
        {
          atr: candidate.analysis?.h4OB?.atr || (freshEntry * 0.01), // Fallback ATR 1% jika tidak ada
          accountBalance: effectiveBalance,
          stepSize: exchangeSpecs?.[futuresSym]?.stepSize || 0,
          minNotional: exchangeSpecs?.[futuresSym]?.minNotional || 5.0
        }
      );

      if (!freshRR || freshRR.rr < config.strategy.minRrRatio) {
        const rrVal = freshRR?.rr?.toFixed(2) || 'N/A';
        const reason = !freshRR ? 'Safety/Distance bounds' : `Low R:R (${rrVal})`;
        
        logger.warn(`🚫 [Fresh RR Check] ${candidate.symbol}: Signal invalidated after 3m confirmation (${reason})`);
        logAudit(candidate.symbol, 'CONFIRMATION', 'REJECTED_RR', refined.confidence, `Invalidated: ${reason} at fresh entry ${freshEntry.toFixed(5)}`);
        scanReport.phaseBreakdown.confirmationRejected++;
        continue;
      }

      // Apply fresh calculation to the refined signal
      refined.riskReward = freshRR;
      refined.entry = freshRR.entry;
      refined.stop_loss = freshRR.sl;
      refined.take_profit = freshRR.tp;

      const signalTimeframe = config.timeframes.H1 || '1h';
      const signalCandleTime = getSignalCandleTime({
        ...refined,
        candles: refined.candles || candidate.candles,
      });
      const signalForDedupe = {
        ...refined,
        timeframe: refined.timeframe || signalTimeframe,
        candleTime: signalCandleTime,
        candles: refined.candles || candidate.candles,
      };
      const dedupeKeyResult = await claimSignalDedupe(signalForDedupe, { ttlSeconds: 7 * 24 * 60 * 60 });

      if (dedupeKeyResult.ok && dedupeKeyResult.deduped) {
        logger.info(`♻️ ${candidate.symbol}: duplicate signal on same candle, skipping delivery.`);
        logAudit(candidate.symbol, 'AI', 'SKIPPED', refined.confidence, 'Duplicate signal for same candle.');
        continue;
      }

      if (!dedupeKeyResult.ok) {
        logger.warn(`⚠️ ${candidate.symbol}: dedupe unavailable (${dedupeKeyResult.reason || 'unknown'}), sending signal without Redis guard.`);
      }

      // ─── 1. Send Text Instan ───
      logAudit(candidate.symbol, 'AI', 'APPROVED', refined.confidence, `${isUpdate ? 'Update signal sent' : 'Fresh signal sent'} to delivery channels.`);
      refined.freshness = Math.round((Date.now() - startTime) / 1000);
      refined.timeframe = refined.timeframe || signalTimeframe;
      refined.candleTime = signalCandleTime;
      const chartCandles = refined.candles || candidate.candles || [];
      let chartImagePath = null;
      const generateChartImage = globalThis.__cryptoSignalGenerateChartImage;
      if (!IS_SERVERLESS && typeof generateChartImage === 'function' && Array.isArray(chartCandles) && chartCandles.length > 0) {
        chartImagePath = await generateChartImage(refined.symbol || candidate.symbol, chartCandles, refined);
        if (chartImagePath) {
          logger.info(`📷 Chart generated for ${candidate.symbol}`);
        }
      }

      const delivered = await sendSignal(refined, chartImagePath);
      if (!delivered) {
        await releaseSignalDedupe(dedupeKeyResult.key).catch(() => {});
        logger.warn(`⚠️ ${candidate.symbol}: delivery failed, dedupe key released for retry.`);
        scanReport.phaseBreakdown.confirmationRejected++;
        continue;
      }

      recordStrategyLesson(tracker, refined.symbol || candidate.symbol, {
        lessonReason: 'Signal lolos validasi dan terkirim',
        diagnostics: buildOutcomeLessonDiagnostics(refined, candidate),
      }, scanReport, candidate);

      tracker.track(refined);
      scanReport.phaseBreakdown.delivered++;
      sentCount++;

    } catch (err) {
      logger.error(`AI validation failed for ${candidate.symbol}:`, err.message);
    }
  }

  // Save for /watchlist command
  tracker.saveWatchlist(rejections);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(`🏁 Cycle: ${sentCount} signals sent, ${finalPool.length - sentCount} rejected by AI, ${elapsed}s`);
  logger.info('═══════════════════════════════════════════════');

  // ─── Best Alternative (Fallback) ────────────────────────
  // Runs when no signals were sent in this cycle.
  // Searches ALL technical candidates (not just AI-reviewed ones) for the best setup.
  if (sentCount === 0) {
    const activeSymbols = tracker.getAllActive().map(p => p.symbol);

    // Source: use AI-rejected pool first; fall back to all technical candidates
    const altPool = rejections.length > 0 ? rejections : candidates.map(c => ({
        ...c,
        reason: c.reasons ? c.reasons.join('; ') : 'Technical candidate (not AI-reviewed)',
    }));

    const bestAlt = altPool
      .filter(r => !activeSymbols.includes(r.symbol)) // <--- PASTIKAN GAK ADA DI ACTIVE TRADES
      .filter(r => {
          const rr = r.riskReward;
          if (!rr || rr.rr < 1.5) return false; // Must have min R:R 1.5
          // Exclude setups where price is already too far into the target (> 60% of TP dist)
          // This prevents 'forced' signals like XPLUSDT where TP is historical and far away
          const entry = rr.entry || r.entry;
          const distToTp = entry && rr.tp ? Math.abs(rr.tp - entry) : Infinity;
          const distToSl = entry && rr.sl ? Math.abs(rr.sl - entry) : Infinity;
          // Reject if SL distance is less than 0.3% (too tight, will get hit by noise)
          const slPct = distToSl / entry;
          if (slPct < 0.003) return false;
          // Reject if RR > 10 (unrealistically high, likely a stale historical TP)
          if (rr.rr > 10) return false;
          return true;
      })
      .sort((a, b) => b.score - a.score)[0];

    if (bestAlt) {
      const rr = bestAlt.riskReward;
      const rrRatio = rr ? rr.rr.toFixed(2) : (bestAlt.score > 80 ? 'High' : 'Low');
      logger.info(`💡 Found Best Alternative: ${bestAlt.symbol} (Score: ${bestAlt.score}, RR: ${rrRatio})`);
    } else {
      logger.info('⛔ No Best Alternative found (all candidates failed R:R or quality checks).');
    }
  }

  scanReport.status = sentCount > 0
    ? 'SIGNALS_SENT'
    : scanReport.watchlistCount > 0
      ? 'WATCHLIST_ONLY'
      : scanReport.errorCount > 0
        ? 'NO_SIGNAL_WITH_ERRORS'
        : 'NO_SIGNAL';

  return sentCount;
  } catch (err) {
    scanReport.status = 'ERROR';
    scanReport.errorCount++;
    scanReport.errors.push(err.message);
    throw err;
  } finally {
    scanReport.finishedAt = Date.now();
    scanReport.durationMs = scanReport.finishedAt - startTime;
    scanReport.signalCount = sentCount;
    scanReport.summary = {
      dailyCount,
      globalSlToday,
      pairs: scanReport.checks.pairs || 0,
      preFilterPassed: scanReport.phaseBreakdown.preFilterPassed,
      candidates: scanReport.candidateCount,
      watchlist: scanReport.watchlistCount,
      filtered: scanReport.filteredCount,
      rejected: scanReport.rejectedCount,
      errors: scanReport.errorCount,
      topFailurePhase: summarizeTopFailurePhase(scanReport.phaseBreakdown),
    };
    scanReport.providerHealth = getProviderHealth ? getProviderHealth() : null;
    scanReport.lessonSummary = tracker.getDailyLessonSummary ? tracker.getDailyLessonSummary() : null;
    scanReport.adaptiveTuning = tracker.getAdaptiveTuning ? tracker.getAdaptiveTuning() : null;
    scanReport.adaptiveThresholds = tracker.getEffectiveAdaptiveThresholds
      ? tracker.getEffectiveAdaptiveThresholds(scanReport.lessonSummary)
      : (scanReport.lessonSummary?.thresholds || scanReport.adaptiveThresholds || {
          minRrRatio: config.strategy.minRrRatio,
          standbyMinRr: config.strategy.standbyMinRr,
          minFinalScore: config.strategy.minFinalScore || 22,
        });

    const tuningSuggestion = tracker.shouldRefreshAdaptiveTuning && tracker.shouldRefreshAdaptiveTuning(scanReport.lessonSummary)
      ? await generateAdaptiveTuningSuggestion(
          scanReport.lessonSummary,
          scanReport.adaptiveThresholds,
          scanReport.adaptiveTuning,
          scanReport.phaseBreakdown,
        )
      : null;

    if (tuningSuggestion) {
      const savedTuning = tracker.saveAdaptiveTuning({
        ...tuningSuggestion,
        sourceDayKey: scanReport.lessonSummary?.dayKey || null,
        sourceRejectCount: scanReport.lessonSummary?.rejectCount || 0,
        sourceTopFailurePhase: scanReport.summary?.topFailurePhase || null,
        phaseBreakdown: scanReport.phaseBreakdown,
      });
      scanReport.adaptiveTuning = savedTuning;
      scanReport.adaptiveThresholds = tracker.getEffectiveAdaptiveThresholds
        ? tracker.getEffectiveAdaptiveThresholds(scanReport.lessonSummary)
        : scanReport.adaptiveThresholds;
    }
    tracker.saveScanReport(scanReport);
    logger.info(`🧾 Scan report saved: ${scanReport.status} | signals=${scanReport.signalCount} | errors=${scanReport.errorCount}`);
    if (sentCount === 0 && (scanReport.candidateCount > 0 || scanReport.watchlistCount > 0 || scanReport.errorCount > 0)) {
      tracker.saveLesson(
        'SCAN',
        scanReport.status || 'NO_SIGNAL',
        buildCycleLessonText(scanReport, sentCount)
      );
    }
    await maybeSendDiscordNotifications(scanReport).catch((err) => {
      logger.warn(`[runScanCycle] cycle summary skipped: ${err.message}`);
    });
  }
}

/**
 * Start the scanner loop. Runs a cycle immediately, then every `intervalMs`.
 */
async function startScanner() {
  initAudit();
  logger.info(`🚀 Scanner starting — interval: ${config.scanner.intervalMs / 1000}s, max pairs: ${config.scanner.maxPairs}`);

  await sendStatus(
    `🤖 *Crypto Signal Bot v4.4.1 started*\n` +
    `_Scanner active: interval ${config.scanner.intervalMs / 1000}s, max pairs ${config.scanner.maxPairs}_`
  );
  logger.info('🤖 Crypto Signal Bot v4.4.1 started. Delivery startup notification sent.');

  // Run first cycle immediately
  await runScanCycle();

  // Schedule recurring cycles
  setInterval(async () => {
    try {
      await runScanCycle();
    } catch (err) {
      logger.error('Unhandled error in scan cycle:', err);
    }
  }, config.scanner.intervalMs);
}

/**
 * Check if active trades have hit SL or TP.
 * Returns a list of symbols that hit TP or SL in this check.
 *
 * @returns {Promise<string[]>}
 */
async function checkActiveTrades() {
  const actives = tracker.getAllActive();
  const hitInThisScan = [];

  if (actives.length === 0) return hitInThisScan;

  const { fetchOHLCV } = require('../data/bybit');
  logger.info(`🧠 Monitoring ${actives.length} active trades for SL/TP (Wick Detection active)...`);

  for (const trade of actives) {
    try {
      // Fetch last 60 1-minute candles to check for any wicks in the last hour
      const candles = await fetchOHLCV(trade.symbol, '1m', 60);
      if (!candles || candles.length === 0) continue;

      const lastCandle = candles[candles.length - 1];
      const currentPrice = lastCandle.close;
      const ageMs = Date.now() - (trade.entryAt || trade.signalAt || Date.now());
      const movePercent = (Math.abs(currentPrice - trade.entry) / trade.entry) * 100;

      // FIX 4: Minimum duration guard
      // Trade minimal berjalan 5 menit sebelum SL/TP dievaluasi untuk menghindari SL hit dari noise milidetik
      if (ageMs < 5 * 60 * 1000) {
        logger.debug(`⏭️ ${trade.symbol}: Trade too young (${(ageMs/1000).toFixed(0)}s), skipping SL/TP check.`);
        continue;
      }

      // 1. Time-Based Invalidation Check (Momentum Stalled after 24h)
      const oneDayMs = 24 * 60 * 60 * 1000;
      if (ageMs > oneDayMs && movePercent < 2.0 && !trade.stalledWarningSent) {
          await sendStatus(`⏳ *REVIEW POSITION: MOMENTUM STALLED* \n\n` + 
                         `• *Symbol:* \`${trade.symbol}\` (${trade.bias})\n` +
                         `• *Age:* \`${(ageMs / (60 * 60 * 1000)).toFixed(1)}h\`\n` +
                         `• *Movement:* \`${movePercent.toFixed(2)}%\` (< 2%)\n\n` +
                         `_Trade ini sudah jalan lebih dari 24 jam tanpa pergerakan signifikan. Consider untuk manual close atau adjust SL/TP._`);
          
          // Mark as warned to prevent spamming
          trade.stalledWarningSent = true;
          tracker._save();
      }

      // 2. Dynamic SL Management (BE & Trailing)
      const isInProfit = trade.bias === 'LONG' ? currentPrice > trade.entry : currentPrice < trade.entry;
      
      if (isInProfit) {
          // A. Move SL to Entry (Breakeven) at 1.5% Profit
          if (movePercent >= 1.5 && !trade.slMovedToEntry) {
              trade.stop_loss = trade.entry;
              trade.slMovedToEntry = true;
              await sendStatus(`🛡️ *PROTECT PROFIT: MOVE SL TO ENTRY* \n\n` +
                             `• *Symbol:* \`${trade.symbol}\`\n` +
                             `• *Profit:* \`+${movePercent.toFixed(2)}%\`\n` +
                             `• *Keterangan:* Harga sudah bergerak 1.5%. SL otomatis digeser ke Entry [\`${trade.entry}\`] untuk mengunci modal.`);
              tracker._save();
          }
          
          // B. Trailing Stop Alert at 3% Profit
          if (movePercent >= 3.0 && !trade.trailingAlertSent) {
              const newSl = trade.bias === 'LONG' ? trade.entry * 1.01 : trade.entry * 0.99;
              trade.trailingAlertSent = true;
              await sendStatus(`📈 *PROFIT SECURED: TRAILING STOP* \n\n` +
                             `• *Symbol:* \`${trade.symbol}\`\n` +
                             `• *Current Profit:* \`+${movePercent.toFixed(2)}%\`\n` +
                             `• *Rekomendasi:* Geser SL ke profit zone (Entry + 1%) di [\`${newSl.toFixed(5)}\`] untuk mengamankan cuan.`);
              tracker._save();
          }
      }

      // 3. SL/TP Check (including Wick Detection)
      let hit = null;
      let hitPrice = null;

      // Filter candles to only include price action AFTER entryAt (-60s buffer)
      const monitoringStart = (trade.entryAt || trade.signalAt || Date.now()) - 60000;
      const relevantCandles = candles.filter(c => c.openTime >= monitoringStart);

      for (const candle of relevantCandles) {
        if (trade.bias === 'LONG') {
          if (candle.high >= trade.take_profit) { hit = 'TP'; hitPrice = trade.take_profit; break; }
          if (candle.low <= trade.stop_loss) { hit = 'SL'; hitPrice = trade.stop_loss; break; }
        } else {
          if (candle.low <= trade.take_profit) { hit = 'TP'; hitPrice = trade.take_profit; break; }
          if (candle.high >= trade.stop_loss) { hit = 'SL'; hitPrice = trade.stop_loss; break; }
        }
      }

      if (hit) {
        logger.info(`🎯 ${trade.symbol}: ${hit} HIT! (Wick detected at ${hitPrice})`);
        const emoji = hit === 'TP' ? '✅' : '🚨';
        hitInThisScan.push(trade.symbol.toUpperCase());
        
        // --- 1. REMOVE FROM MEMORY IMMEDIATELY --- 
        // This ensures subsequent /active calls don't show the stale trade 
        // while AI and Telegram are still processing.
        tracker.remove(trade.symbol, `${hit}_HIT`, hitPrice);
        
        // --- 2. AI & TELEGRAM (MIGHT BE SLOW) ---
        logger.info(`🧠 Requesting AI post-mortem for ${trade.symbol} (${hit})...`);
        
        // Fetch full path candles (from start of signal until now)
        const startTime = (trade.entryAt || trade.signalAt || Date.now());
        const ageHours = Math.ceil((Date.now() - startTime) / (3600 * 1000));
        const historyCandles = await fetchOHLCV(trade.symbol, '1h', ageHours + 1, { startTime });
        const summary = Array.isArray(historyCandles)
          ? historyCandles.map(c => `H:${c.high}/L:${c.low}/C:${c.close}`).join(' | ')
          : '';

        const lesson = await analyzePostMortem(trade, hitPrice, hit, summary);
        
        const learningInfo = `\n\n📖 *PELAJARAN (AI Analysis):*\n_` + lesson + `_`;
        tracker.saveLesson(trade.symbol, trade.bias, lesson);

        const targetLabel = hit === 'TP' ? '🎯 *Take Profit Target:*' : '🛑 *Stop Loss Level:*';
        const targetPrice = hit === 'TP' ? trade.take_profit : trade.stop_loss;

        const msg = `${emoji} *${hit} HIT: ${trade.symbol}*\n\n` +
                    `📊 *Bias:* \`${trade.bias}\`\n` +
                    `${targetLabel} \`${targetPrice}\`\n` +
                    `📍 *Hit Price:* \`${hitPrice}\`` + learningInfo;
        
        await sendStatus(msg);
      }
    } catch (err) {
      logger.error(`Failed to monitor ${trade.symbol}:`, err.message);
    }
  }

  return hitInThisScan;
}

module.exports = { startScanner, runScanCycle };
