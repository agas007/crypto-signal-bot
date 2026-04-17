const config = require('../../config');
const logger = require('../../utils/logger');
const sleep = require('../../utils/sleep');
const { 
  fetchTopPairs, fetchMultiTimeframe, fetch24hTicker, fetchFundingRate, 
  fetchFuturesBalance, fetchOHLCV, fetchExchangeSpecs, toFuturesSymbol,
  fetchOpenInterest, fetchOpenInterestHistory, fetchGlobalLongShortRatio,
  fetchTopTraderLongShortRatio, fetchOrderBookDepth, fetchLiquidationOrders,
} = require('../data/binance');
const { analyzeTrend } = require('../indicators');
const { applyFilters } = require('../filter');
const { evaluateSignal } = require('../strategy');
const { refineSignal, analyzePostMortem } = require('../ai/openrouter');
const { sendSignal, sendStatus } = require('../telegram');
const { generateChartImage } = require('../chart');
const tracker = require('../tracker');
const { logAudit, initAudit } = require('../../utils/audit');

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
 
  // ─── -1. Global Daily Limit Check ───
  const dailyCount = tracker.getDailyTradeCount();
  const globalSlToday = tracker.getGlobalSLCountToday();

  // ─── 0. Early Exit Check (Hard Killswitch) ───
  // Rule: Stop all trades if we hit 3 SLs globally in a day (Resets 00:00 WIB)
  if (globalSlToday >= 3) {
    logger.info(`🚫 Global Killswitch Active: ${globalSlToday}/3 Stop Loss hits today. Scanning suspended until 00:00 WIB reset.`);
    await checkActiveTrades(); // Still check existing trades for accuracy
    return 0;
  }

  logger.info(`📈 Daily Status: ${dailyCount}/5 total trades, ${globalSlToday}/3 SL hits.`);

  // ─── 0. Fetch Real Balance & Exchange Specs ───
  // We fetch specs to ensure Lot Size (Step size) and Min Notional compliance
  const [balance, exchangeSpecs] = await Promise.all([
      fetchFuturesBalance(),
      fetchExchangeSpecs()
  ]);
  
  const effectiveBalance = balance > 0 ? balance : config.strategy.accountBalance;
  if (balance > 0) {
    logger.info(`💰 Current Futures Balance: $${balance.toFixed(2)} USDT`);
  } else {
    logger.warn(`⚠️ Could not fetch real balance, using fallback: $${config.strategy.accountBalance}`);
  }

  // ─── 1. Monitor Active Trades ──────────────────────────
  // Now returns symbols that hit TP/SL to prevent re-tracking in SAME cycle
  const hitSymbols = await checkActiveTrades();

  // ─── 1. Fetch top pairs by volume ──────────────────────
  const pairs = await fetchTopPairs();
  if (!pairs.length) {
    logger.warn('No pairs fetched, aborting cycle');
    return 0;
  }

  // ─── Market Regime: Fetch BTC Trend ───
  let btcTrend = 'NEUTRAL';
  try {
      const btcCandles = await fetchOHLCV('BTCUSDT', config.timeframes.D1, 50);
      if (btcCandles.length > 0) {
          const trend = analyzeTrend(btcCandles);
          btcTrend = trend.direction;
          logger.info(`🌐 Market Regime: BTC D1 is ${btcTrend}`);
      }
  } catch (err) {
      logger.error('Failed to fetch BTC trend for market regime:', err.message);
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
        logAudit(symbol, 'PRE-FILTER', 'REJECTED', 0, filterResult.reasons.join(', '));
        continue;
      }

      // Passed filter → fetch multi-TF data + Funding Rate
      logger.info(`📊 ${symbol} passed pre-filters, fetching multi-TF data...`);
      logAudit(symbol, 'PRE-FILTER', 'PASSED', 0, 'Liquid & Volatile');
      const mtfData = await fetchMultiTimeframe(symbol);
      const fundingRate = await fetchFundingRate(symbol);
      
      if (!mtfData) {
        errors++;
        continue;
      }

      // ─── Market Microstructure Data (fetched in parallel, non-blocking) ───
      logger.info(`🔬 ${symbol} fetching market microstructure data...`);
      const [oiRes, oiHistRes, crowdRes, obRes] = await Promise.allSettled([
        fetchOpenInterest(symbol),
        fetchOpenInterestHistory(symbol, '1h', 12),
        fetchGlobalLongShortRatio(symbol, '1h', 6),
        fetchOrderBookDepth(symbol, 20),
      ]);

      const micro = {
        oi:           oiRes.status === 'fulfilled'   ? oiRes.value   : null,
        oiHistory:    oiHistRes.status === 'fulfilled' ? oiHistRes.value : [],
        crowdRatio:   crowdRes.status === 'fulfilled' ? crowdRes.value : [],
        orderBook:    obRes.status === 'fulfilled'   ? obRes.value   : null,
        // Removed TopTrader & Liquidations as per request
        topRatio:     [],
        liquidations: [],
      };

      // Cleaner micro summary for audit log
      const oiChg = micro.oiHistory.length >= 2
        ? (((micro.oiHistory.at(-1).sumOpenInterest - micro.oiHistory[0].sumOpenInterest) / micro.oiHistory[0].sumOpenInterest) * 100).toFixed(1)
        : null;
      const crowdLatest = micro.crowdRatio.at(-1);
      
      let microLog = `🔬 Micro[${symbol}]: `;
      if (oiChg !== null) microLog += `OI Δ${oiChg}% | `;
      if (crowdLatest) microLog += `Crowd L/S: ${(crowdLatest.longAccount*100).toFixed(0)}/${(crowdLatest.shortAccount*100).toFixed(0)}% | `;
      if (micro.orderBook) microLog += `OB: ${micro.orderBook.bias} (${(micro.orderBook.imbalance*100).toFixed(0)}%) | `;
      
      if (microLog.length > 20) logger.info(microLog);

      // Run strategy evaluation (includes hard kill-switches + R:R check)
      const futuresSym = toFuturesSymbol(symbol);
      const specs = exchangeSpecs[futuresSym] || { stepSize: 0.001, minNotional: 5.0 };

      const result = evaluateSignal(symbol, mtfData, { 
          fundingRate,
          micro,           // <-- full microstructure context
          accountBalance: effectiveBalance,
          stepSize: specs.stepSize,
          minNotional: specs.minNotional,
          includeRejectionReason: true
      });
      
      // evaluateSignal returns:
      //   Success: raw signal object { symbol, bias, score, ... }
      //   Rejection: { signal: null, rejectionReason: '...' }
      const isRejection = result && result.signal === null && result.rejectionReason;
      const signal = isRejection ? null : result;

      if (signal) {
        signal.candles = mtfData.H1; // Save candles for the chart later
        candidates.push(signal);
        logger.info(`✅ ${symbol}: ${signal.bias} (score: ${signal.score})`);
        logAudit(symbol, 'STRATEGY', 'PASSED', signal.score, signal.reasons.join(', '));
      } else {
        rejected++;
        const reason = isRejection ? result.rejectionReason : 'Technical requirements not met';
        logAudit(symbol, 'STRATEGY', 'REJECTED', 0, reason);
      }

      await sleep(config.binance.rateLimitMs);
    } catch (err) {
      logger.error(`Error processing ${symbol}:`, err.message);
      errors++;
    }
  }

  // 3. Selection & Batching
  const qualityCandidates = candidates.filter((c) => c.isStrict);
  const okCandidates = candidates.filter((c) => !c.isStrict);
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
  const rejections = [];

  // Inform user about technical candidates found
  if (sentCount === 0 && rejections.length > 0) {
    const watchlist = rejections.map(r => {
        const label = r.quality === 'WATCHLIST' ? '📋 *WATCHLIST*' : '🚫 *REJECTED*';
        return `• *${r.symbol}* (Score ${r.score}) ${label}: _${r.reason}_`;
    }).join('\n');

    const msg = `📡 *𝐑𝐞𝐬𝐮𝐥𝐭: 𝐇𝐢𝐠𝐡 𝐀𝐥𝐞𝐫𝐭 𝐖𝐚𝐭𝐜𝐡𝐥𝐢𝐬𝐭*\n\n` +
                `${watchlist}\n\n` +
                `🛡️ *Status:* Standing by. Waiting for Market Regime shift or better RR Ratio.`;

    await sendStatus(msg);
  }

  for (const candidate of finalPool) {
    try {
      const refined = await refineSignal(candidate, { btcTrend });

      if (!refined) {
        logger.info(`AI returned no response for ${candidate.symbol}`);
        logAudit(candidate.symbol, 'AI', 'ERROR', candidate.score, 'Empty AI Response');
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
      // Cek ulang kondisi harga beberapa saat sebelum dikirim (Anti-Fakeout)
      logger.info(`⏳ [Live Confirmation] Memantau pergerakan harga ${candidate.symbol} selama 3 menit...`);
      await sendStatus(`⏳ *LIVE CONFIRMATION: ${candidate.symbol}*\n_AI menyetujui setup. Bot sedang memantau pergerakan harga secara live (3 menit) untuk menghindari fakeout..._`);
      
      const sleep = require('../../utils/sleep');
      const { fetch24hTicker } = require('../data/binance');
      await sleep(3 * 60 * 1000); // Wait 3 minutes

      const latestTicker = await fetch24hTicker(candidate.symbol);
      const currentPriceLive = latestTicker ? parseFloat(latestTicker.lastPrice) : refined.entry;
      
      // Hitung slippage/pergeseran dari entry AI
      const slippage = Math.abs(currentPriceLive - refined.entry) / refined.entry;
      if (slippage > 0.015) {
          logger.warn(`🚫 [Live Confirmation Failed] ${candidate.symbol} price slipped ${(slippage*100).toFixed(2)}% during confirmation window.`);
          await sendStatus(`🚫 *SIGNAL DROPPED: ${candidate.symbol}*\n_Terdeteksi pergerakan harga terlalu volatile / fakeout (${(slippage*100).toFixed(1)}%) saat fase konfirmasi. Setup dibatalkan demi keamanan._`);
          logAudit(candidate.symbol, 'CONFIRMATION', 'REJECTED', refined.confidence, `Price moved too violently during 3m window (Slippage: ${(slippage*100).toFixed(1)}%)`);
          continue;
      }

      // ─── 1. Send Text Instan ───
      logAudit(candidate.symbol, 'AI', 'APPROVED', refined.confidence, `${isUpdate ? 'Update signal sent' : 'Fresh signal sent'} to Telegram.`);
      refined.freshness = Math.round((Date.now() - startTime) / 1000);
      await sendSignal(refined, null); 
      tracker.track(refined);
      sentCount++;

      // ─── 2. Queue Chart Generation (Sequential to save RAM) ───
      try {
          const chartPath = await generateChartImage(candidate.symbol, candidate.candles, refined);
          if (chartPath) {
              await sendSignal({ ...refined, isChartUpdate: true }, chartPath);
          }
      } catch (e) {
          logger.error(`Chart delivery failed for ${candidate.symbol}:`, e.message);
      }

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
    // Source: use AI-rejected pool first; fall back to all technical candidates
    const altPool = rejections.length > 0 ? rejections : candidates.map(c => ({
        ...c,
        reason: c.reasons ? c.reasons.join('; ') : 'Technical candidate (not AI-reviewed)',
    }));

    const bestAlt = altPool
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
      const entryPrice = rr ? (rr.entry || bestAlt.entry || 'N/A') : 'N/A';
      const slPrice = rr ? rr.sl.toFixed(5) : 'N/A';
      const tpPrice = rr ? rr.tp.toFixed(5) : 'N/A';
      const rrRatio = rr ? rr.rr.toFixed(2) : 'N/A';
      const label = bestAlt.quality === 'WATCHLIST' ? '(WATCHLIST)' : '(OBSERVATION)';

      logger.info(`💡 Found Best Alternative: ${bestAlt.symbol} (Score: ${bestAlt.score}, RR: ${rrRatio})`);
      await sendStatus(`💡 *BEST ALTERNATIVE: ${bestAlt.symbol}* ${label} | ${bestAlt.bias}\n` +
                     `_No high-quality signals this cycle. Best available setup below._\n\n` +
                     `• *Score:* \`${bestAlt.score}/100\` | *R:R:* \`${rrRatio}\`\n` +
                     `• *Entry:* \`${entryPrice}\`\n` +
                     `• *TP:* \`${tpPrice}\` | *SL:* \`${slPrice}\`\n\n` +
                     `🧠 *Analysis:* ${bestAlt.reason}\n\n` +
                     `⚠️ _Pantau manual saja — tidak masuk Active Trades._`);
    } else {
      logger.info('⛔ No Best Alternative found (all candidates failed R:R or quality checks).');
      await sendStatus('🛡️ *Scan Complete:* Market conditions do not favor any trade this cycle. Waiting for next scan.');
    }
  }

  // ─── Auto Dashboard Update ───
  try {
    const { generateAndSendDashboard } = require('../chart/dashboard');
    await generateAndSendDashboard();
  } catch (err) {
    logger.error('Dashboard auto-update failed:', err.message);
  }

  return sentCount;
}

/**
 * Start the scanner loop. Runs a cycle immediately, then every `intervalMs`.
 */
async function startScanner() {
  initAudit();
  logger.info(`🚀 Scanner starting — interval: ${config.scanner.intervalMs / 1000}s, max pairs: ${config.scanner.maxPairs}`);

  await sendStatus('🤖 *Crypto Signal Bot v4.4.1* started!\n_Adaptive Intelligence, Market Regime, Retest Guard & Memory Fix active._');

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

      const lastCandle = candles[candles.length - 1];
      const currentPrice = lastCandle.close;
      const ageMs = Date.now() - (trade.entryAt || trade.signalAt || Date.now());
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
        const summary = historyCandles.map(c => `H:${c.high}/L:${c.low}/C:${c.close}`).join(' | ');

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
