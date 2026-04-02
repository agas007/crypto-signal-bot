const config = require('../../config');
const logger = require('../../utils/logger');
const sleep = require('../../utils/sleep');
const { fetchTopPairs, fetchMultiTimeframe, fetch24hTicker } = require('../data/binance');
const { analyzeTrend } = require('../indicators');
const { applyFilters } = require('../filter');
const { evaluateSignal } = require('../strategy');
const { refineSignal, analyzePostMortem } = require('../ai/openrouter');
const { sendSignal, sendStatus } = require('../telegram');
const { generateChartImage } = require('../chart');
const tracker = require('../tracker');

/**
 * Run a single scan cycle:
 * 1. Monitor active trades for TP/SL
 * 2. Fetch top pairs
 * 3. Filter and evaluate
 * 4. Send to AI and Telegram
 *
 * @returns {Promise<number>} Number of signals sent
 */
async function runScanCycle() {
  const startTime = Date.now();
  logger.info('═══════════════════════════════════════════════');
  logger.info('🔍 Starting scan cycle...');

  // ─── 0. Monitor Active Trades ──────────────────────────
  // Now returns symbols that hit TP/SL to prevent re-tracking in SAME cycle
  const hitSymbols = await checkActiveTrades();

  // ─── 1. Fetch top pairs by volume ──────────────────────
  const pairs = await fetchTopPairs();
  if (!pairs.length) {
    logger.warn('No pairs fetched, aborting cycle');
    return 0;
  }

  // 2. Filter + evaluate each pair
  const candidates = [];
  let filtered = 0;
  let rejected = 0;
  let errors = 0;

  for (const symbol of pairs) {
    // Skip if just hit TP/SL in this cycle to avoid duplicate signals
    if (hitSymbols.includes(symbol.toUpperCase())) {
      logger.info(`⏭️ Skipping ${symbol} - just hit TP/SL in this cycle.`);
      continue;
    }

    try {
      // Quick filter: fetch ticker first (cheap API call)
      const ticker = await fetch24hTicker(symbol);
      if (!ticker) {
        errors++;
        continue;
      }

      // Fetch D1 candles for trend check (only D1 for pre-filter)
      const d1Candles = await (async () => {
        const { fetchOHLCV } = require('../data/binance');
        return fetchOHLCV(symbol, config.timeframes.D1, 50);
      })();

      if (!d1Candles.length) {
        errors++;
        continue;
      }

      await sleep(config.binance.rateLimitMs);

      const d1Trend = analyzeTrend(d1Candles, config.indicators.ema);
      const filterResult = applyFilters({
        symbol,
        ticker,
        trend: d1Trend,
        candles: d1Candles,
      });

      if (!filterResult.pass) {
        filtered++;
        continue;
      }

      // Passed filter → fetch multi-TF data + Funding Rate
      logger.info(`📊 ${symbol} passed pre-filters, fetching multi-TF data...`);
      const mtfData = await fetchMultiTimeframe(symbol);
      const fundingRate = await fetchFundingRate(symbol);
      
      if (!mtfData) {
        errors++;
        continue;
      }

      // Run strategy evaluation (includes hard kill-switches + R:R check)
      const signal = evaluateSignal(symbol, mtfData, { fundingRate });
      if (signal) {
        signal.candles = mtfData.H1; // Save candles for the chart later
        candidates.push(signal);
        logger.info(`✅ ${symbol}: ${signal.bias} (score: ${signal.score}, R:R: ${signal.riskReward.rr.toFixed(2)})`);
      } else {
        rejected++;
      }

      await sleep(config.binance.rateLimitMs);
    } catch (err) {
      logger.error(`Error processing ${symbol}:`, err.message);
      errors++;
    }
  }

  // Split strict vs fallback candidates
  const strictCandidates = candidates.filter(c => c.isStrict);
  const fallbackCandidates = candidates.filter(c => !c.isStrict);

  logger.info(`Scan: ${strictCandidates.length} strict, ${fallbackCandidates.length} low-confidence, ${filtered} pre-filtered, ${errors} errors / ${pairs.length} pairs`);

  if (!candidates.length) {
    logger.info('⛔ No trade candidates found at all this cycle');
    await sendStatus('😴 *Scan Cycle:* No directional candidates found across all pairs.');
    return 0;
  }

  // 3. Build mixed pool: all strict first, then fill with best available
  const totalSlots = config.scanner.topSignalsToAi;

  strictCandidates.sort((a, b) => b.score - a.score);
  fallbackCandidates.sort((a, b) => b.score - a.score);

  const pool = [
    ...strictCandidates,
    ...fallbackCandidates.slice(0, Math.max(0, totalSlots - strictCandidates.length)),
  ];

  const isMixedMode = strictCandidates.length > 0 && fallbackCandidates.length > 0;
  const isFallbackOnly = strictCandidates.length === 0;

  if (isFallbackOnly) {
    logger.info(`⚠️  No strict signals — sending top ${pool.length} BEST AVAILABLE to AI...`);
    await sendStatus(`⚠️ *Scan Cycle:* No high-conviction signals. Sending top ${pool.length} best available (lower quality).`);
  } else if (isMixedMode) {
    logger.info(`🤖 Mixed pool: ${strictCandidates.length} strict + ${pool.length - strictCandidates.length} best available → ${pool.length} total to AI...`);
  } else {
    logger.info(`🤖 Sending top ${pool.length} STRICT candidates to AI for validation...`);
  }

  // 4. AI validation + Telegram delivery
  let sentCount = 0;

  for (const candidate of pool) {
    try {
      const refined = await refineSignal(candidate);

      if (!refined) {
        logger.info(`AI returned no response for ${candidate.symbol}`);
        continue;
      }

      // AI said NO TRADE
      if (refined.bias === 'NO TRADE' || refined.bias === 'NO_TRADE') {
        logger.info(`🚫 ${candidate.symbol}: AI rejected — ${refined.reason}`);
        continue;
      }

      // Relax confidence for best-available candidates
      const minConfidence = candidate.lowConfidence ? 45 : 60;
      if (refined.confidence < minConfidence) {
        logger.info(`⚠️ ${candidate.symbol}: AI confidence too low ${refined.confidence}/100 — ${refined.reason}`);
        continue;
      }

      // Quality gate: only reject LOW quality with very low confidence
      if (refined.quality === 'LOW' && refined.confidence < (candidate.lowConfidence ? 35 : 40)) {
        logger.info(`⚠️ ${candidate.symbol}: AI quality LOW + low confidence — ${refined.reason}`);
        continue;
      }

      refined.isFallback = candidate.lowConfidence;

      // ─── Deduplication / Update Check ───
      const active = tracker.getActive(candidate.symbol);
      if (active) {
        const ticker = await fetch24hTicker(candidate.symbol);
        const currentPrice = ticker ? parseFloat(ticker.lastPrice) : refined.entry;

        // Check if trade is "Running in Profit"
        const isRunningInProfit = active.bias === 'LONG' 
            ? currentPrice > active.entry 
            : currentPrice < active.entry;

        if (isRunningInProfit) {
            logger.info(`🧠 [Tracker] ${candidate.symbol} is already running in profit. Skipping update message.`);
            continue; // Don't send anything if already winning
        }

        // If same bias and prices are close enough, just send update
        const diffEntry = Math.abs(refined.entry - active.entry) / active.entry;
        logger.info(`🧠 [Tracker] Found ${candidate.symbol} active. Price diff: ${(diffEntry*100).toFixed(2)}%`);
        
        if (refined.bias === active.bias && diffEntry < 0.01) {
          logger.info(`🔄 ${candidate.symbol}: Skipping duplicate full signal.`);
          await sendStatus(`🔄 *UPDATE ${candidate.symbol}*\n_Sinyal sebelumnya masih VALID._\n• *Entry:* \`${refined.entry}\` (±${(diffEntry*100).toFixed(1)}%)\n• *Status:* Ongoing trade.`);
          continue;
        } else {
          // If bias changed or prices shifted significantly, invalidate and update
          logger.info(`⚠️ ${candidate.symbol}: Invalidating old setup due to new market conditions.`);
          
          let invalidateReason = refined.bias !== active.bias 
            ? `Perubahan BIAS dari ${active.bias} ke ${refined.bias}`
            : `Penyesuaian Level (Entry/SL/TP) karena volatilitas market (diff: ${(diffEntry*100).toFixed(1)}%)`;

          await sendStatus(`🚫 *SIGNAL INVALID: ${candidate.symbol}*\n_Sinyal sebelumnya sudah tidak valid._\n• *Alasan:* ${invalidateReason}\n\n_Stay tuned, setup baru sedang dikirim..._`);
          tracker.remove(candidate.symbol, 'INVALIDATED_BY_NEW_SETUP');
        }
      }

      // ─── Generate and Send Chart ───
      const chartPath = await generateChartImage(candidate.symbol, candidate.candles, refined);

      await sendSignal(refined, chartPath);
      tracker.track(refined); // Save to memory
      sentCount++;
    } catch (err) {
      logger.error(`AI validation failed for ${candidate.symbol}:`, err.message);
    }

    await sleep(2000); // space out AI calls
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(`🏁 Cycle: ${sentCount} signals sent, ${pool.length - sentCount} rejected by AI, ${elapsed}s`);
  logger.info('═══════════════════════════════════════════════');

  if (sentCount === 0) {
    await sendStatus('🛡️ *Scan Cycle:* Candidates were found but rejected by AI validation.');
  }

  return sentCount;
}

/**
 * Start the scanner loop. Runs a cycle immediately, then every `intervalMs`.
 */
async function startScanner() {
  logger.info(`🚀 Scanner starting — interval: ${config.scanner.intervalMs / 1000}s, max pairs: ${config.scanner.maxPairs}`);

  await sendStatus('🤖 *Crypto Signal Bot v4.1.0* started!\n_Binance Sync, AI Performance Coach & Trading Types active._\n_Scanning Spot & Futures Market every 1 hour..._');

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

  const { fetchOHLCV } = require('../data/binance');
  logger.info(`🧠 Monitoring ${actives.length} active trades for SL/TP (Wick Detection active)...`);

  for (const trade of actives) {
    try {
      // Fetch last 60 1-minute candles to check for any wicks in the last hour
      const candles = await fetchOHLCV(trade.symbol, '1m', 60);
      if (!candles || candles.length === 0) continue;

      const ageMs = Date.now() - trade.timestamp;
      const movePercent = (Math.abs(currentPrice - trade.entry) / trade.entry) * 100;

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

      // 2. Break-Even Check (Move SL to Entry if 50% of TP distance is reached)
      const totalTpDist = Math.abs(trade.take_profit - trade.entry);
      const currentProgress = Math.abs(currentPrice - trade.entry);
      const progressPercent = (currentProgress / totalTpDist) * 100;
      const isInProfit = trade.bias === 'LONG' ? currentPrice > trade.entry : currentPrice < trade.entry;

      if (progressPercent >= 50.0 && isInProfit && !trade.slMovedToEntry) {
          const oldSl = trade.stop_loss;
          trade.stop_loss = trade.entry; // Move SL to Entry
          trade.slMovedToEntry = true;
          
          await sendStatus(`🛡️ *PROTECT PROFIT: MOVE SL TO ENTRY* \n\n` +
                         `• *Symbol:* \`${trade.symbol}\`\n` +
                         `• *Progress:* \`${progressPercent.toFixed(1)}%\` nuju TP\n` +
                         `• *Keterangan:* Harga sudah jalan setengah jalan. SL otomatis digeser ke Entry [\`${trade.entry}\`] untuk menjaga modal.`);
          tracker._save();
      }

      let hit = null;
      if (trade.bias === 'LONG') {
        if (currentPrice >= trade.take_profit) hit = 'TP';
        else if (currentPrice <= trade.stop_loss) hit = 'SL';
      } else {
        if (currentPrice <= trade.take_profit) hit = 'TP';
        else if (currentPrice >= trade.stop_loss) hit = 'SL';
      }

      if (hit) {
        logger.info(`🎯 ${trade.symbol}: ${hit} HIT! (Wick detected at ${hitPrice})`);
        const emoji = hit === 'TP' ? '✅' : '🚨';
        hitInThisScan.push(trade.symbol.toUpperCase());
        
        logger.info(`🧠 Requesting AI post-mortem for ${trade.symbol} (${hit})...`);
        const lesson = await analyzePostMortem(trade, hitPrice, hit);
        
        const learningInfo = `\n\n📖 *PELAJARAN (AI Analysis):*\n_` + lesson + `_`;
        tracker.saveLesson(trade.symbol, trade.bias, lesson);

        const msg = `${emoji} *${hit} HIT: ${trade.symbol}*\n\n` +
                    `📊 *Bias:* \`${trade.bias}\`\n` +
                    `💰 *Target Price:* \`${hit === 'TP' ? trade.take_profit : trade.stop_loss}\`\n` +
                    `📍 *Hit Price:* \`${hitPrice}\`` + learningInfo;
        
        await sendStatus(msg);
        tracker.remove(trade.symbol, `${hit}_HIT`);
      }
    } catch (err) {
      logger.error(`Failed to monitor ${trade.symbol}:`, err.message);
    }
  }

  return hitInThisScan;
}

module.exports = { startScanner, runScanCycle };
