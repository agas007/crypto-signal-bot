const config = require('../../config');
const logger = require('../../utils/logger');
const sleep = require('../../utils/sleep');
const { fetchTopPairs, fetchMultiTimeframe, fetch24hTicker } = require('../data/binance');
const { analyzeTrend } = require('../indicators');
const { applyFilters } = require('../filter');
const { evaluateSignal } = require('../strategy');
const { refineSignal } = require('../ai/openrouter');
const { sendSignal, sendStatus } = require('../telegram');

/**
 * Run a single scan cycle:
 * 1. Fetch top pairs
 * 2. Filter by volume/trend/volatility
 * 3. Run strategy evaluation (with hard kill-switches)
 * 4. Send survivors to AI for final validation
 * 5. Send validated signals to Telegram
 *
 * @returns {Promise<number>} Number of signals sent
 */
async function runScanCycle() {
  const startTime = Date.now();
  logger.info('═══════════════════════════════════════════════');
  logger.info('🔍 Starting scan cycle...');

  // 1. Fetch top pairs by volume
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

  logger.info(`Scan: ${candidates.length} candidates, ${filtered} pre-filtered, ${rejected} strategy-rejected, ${errors} errors / ${pairs.length} pairs`);

  if (!candidates.length) {
    logger.info('⛔ No trade candidates survived filtering this cycle');
    return 0;
  }

  // 3. Sort by score and take top N
  candidates.sort((a, b) => b.score - a.score);
  const topCandidates = candidates.slice(0, config.scanner.topSignalsToAi);

  logger.info(`🤖 Sending top ${topCandidates.length} candidates to AI for VALIDATION...`);

  // 4. AI validation + Telegram delivery
  let sentCount = 0;

  for (const candidate of topCandidates) {
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

      // Confidence threshold (0-100 scale, need 75+)
      if (refined.confidence < 75) {
        logger.info(`⚠️ ${candidate.symbol}: AI confidence too low ${refined.confidence}/100 — ${refined.reason}`);
        continue;
      }

      // Quality gate: only HIGH and MEDIUM pass
      if (refined.quality === 'LOW') {
        logger.info(`⚠️ ${candidate.symbol}: AI quality LOW — ${refined.reason}`);
        continue;
      }

      await sendSignal(refined);
      sentCount++;
    } catch (err) {
      logger.error(`AI validation failed for ${candidate.symbol}:`, err.message);
    }

    await sleep(2000); // space out AI calls
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(`🏁 Cycle: ${sentCount} signals sent, ${topCandidates.length - sentCount} rejected by AI, ${elapsed}s`);
  logger.info('═══════════════════════════════════════════════');

  return sentCount;
}

/**
 * Start the scanner loop. Runs a cycle immediately, then every `intervalMs`.
 */
async function startScanner() {
  logger.info(`🚀 Scanner starting — interval: ${config.scanner.intervalMs / 1000}s, max pairs: ${config.scanner.maxPairs}`);

  await sendStatus('🤖 *Crypto Signal Bot v2* started!\n_Conservative mode — quality over quantity\._\n_Scanning every 15 minutes\.\.\._');

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

module.exports = { startScanner, runScanCycle };
