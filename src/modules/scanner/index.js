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
  await checkActiveTrades();

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

      // Passed filter → fetch multi-TF data
      logger.info(`📊 ${symbol} passed pre-filters, fetching multi-TF data...`);
      const mtfData = await fetchMultiTimeframe(symbol);
      if (!mtfData) {
        errors++;
        continue;
      }

      // Run strategy evaluation (includes hard kill-switches + R:R check)
      const signal = evaluateSignal(symbol, mtfData);
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
        // If same bias and prices are close enough, just send update
        const diffEntry = Math.abs(refined.entry - active.entry) / active.entry;
        logger.info(`🧠 [Tracker] Found ${candidate.symbol} active. Price diff: ${(diffEntry*100).toFixed(2)}%`);
        
        if (refined.bias === active.bias && diffEntry < 0.01) {
          logger.info(`🔄 ${candidate.symbol}: Skipping duplicate full signal.`);
          await sendStatus(`🔄 *UPDATE ${candidate.symbol}*\n_Sinyal sebelumnya masih VALID._\n• *Entry:* \`${refined.entry}\` (±${(diffEntry*100).toFixed(1)}%)\n• *Status:* Ongoing trade.`);
          continue;
        } else {
          // If bias changed or prices shifted significantly, update the tracker
          logger.info(`⚠️ ${candidate.symbol}: Updating levels shifting by ${(diffEntry*100).toFixed(2)}%. Sending NEW signal message.`);
          tracker.remove(candidate.symbol, 'UPDATING');
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

  await sendStatus('🤖 *Crypto Signal Bot v3.1* started!\n_Signal Memory, AI Learning & Active Tracker active._\n_Multi-TF: D1 · H4 · H1 — scanning every 1 hour..._');

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
 */
async function checkActiveTrades() {
  const actives = tracker.getAllActive();
  if (actives.length === 0) return;

  logger.info(`🧠 Monitoring ${actives.length} active trades for SL/TP...`);

  for (const trade of actives) {
    try {
      const ticker = await fetch24hTicker(trade.symbol);
      if (!ticker) continue;

      const currentPrice = parseFloat(ticker.lastPrice);
      let hit = null;

      if (trade.bias === 'LONG') {
        if (currentPrice >= trade.take_profit) hit = 'TP';
        else if (currentPrice <= trade.stop_loss) hit = 'SL';
      } else {
        if (currentPrice <= trade.take_profit) hit = 'TP';
        else if (currentPrice >= trade.stop_loss) hit = 'SL';
      }

      if (hit) {
        logger.info(`🎯 ${trade.symbol}: ${hit} HIT! Price: ${currentPrice}`);
        const emoji = hit === 'TP' ? '✅' : '🚨';
        
        let learningInfo = '';
        if (hit === 'SL') {
          logger.info(`🧠 Requesting AI post-mortem for ${trade.symbol}...`);
          learningInfo = `\n\n📖 *PELAJARAN (AI Analysis):*\n_` + await analyzePostMortem(trade, currentPrice) + `_`;
        }

        const msg = `${emoji} *${hit} HIT: ${trade.symbol}*\n\n` +
                    `📊 *Bias:* \`${trade.bias}\`\n` +
                    `💰 *Final Price:* \`${currentPrice}\`` + learningInfo;
        
        await sendStatus(msg);
        tracker.remove(trade.symbol, `${hit}_HIT`);
      }
    } catch (err) {
      logger.error(`Failed to monitor ${trade.symbol}:`, err.message);
    }
  }
}

module.exports = { startScanner, runScanCycle };
