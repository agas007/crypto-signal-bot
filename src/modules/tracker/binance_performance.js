const { fetchUserTrades, fetchTopPairs, fetchOHLCV } = require('../data/binance');
const { analyzeRealTrade } = require('../ai/openrouter');
const tracker = require('./index');
const logger = require('../../utils/logger');
const sleep = require('../../utils/sleep');
const config = require('../../config');

/**
 * Module to calculate trading performance directly from Binance Trade History.
 */
class BinancePerformance {
  /**
   * Get PnL and Win Rate for a specific timeframe and market.
   * 
   * @param {'daily' | 'weekly' | 'monthly' | 'all'} period 
   * @param {'spot' | 'futures' | 'combined'} market
   * @returns {Promise<Object>} Performance stats
   */
  async getPerformance(period = 'all', market = 'combined') {
    const startTime = this._getStartTime(period);
    
    let totalPnl = 0;
    let tradesCount = 0;
    let wins = 0;
    let losses = 0;
    const tradeLog = [];

    const marketsToScan = market === 'combined' ? ['spot', 'futures'] : [market];
    logger.info(`📊 Global Binance ${market.toUpperCase()} sync starting (${period})...`);

    for (const mkt of marketsToScan) {
      if (mkt === 'futures') {
        try {
            const trades = await fetchUserTrades('', startTime, 'futures'); 
            const pnlData = await this._calculateAndLearn('GLOBAL_FUTURES', trades, 'futures');
            totalPnl += pnlData.pnl;
            tradesCount += pnlData.count;
            wins += pnlData.wins;
            losses += pnlData.losses;
            tradeLog.push(...pnlData.details); 
        } catch (err) {
            logger.warn(`⚠️ Skipping futures sync due to error: ${err.message}`);
        }
      } else {
        const scanPairs = await fetchTopPairs(50);
        let error451Count = 0;
        
        for (const symbol of scanPairs) {
            try {
                const trades = await fetchUserTrades(symbol, startTime, 'spot');
                if (trades.length === 0) continue;

                const pnlData = await this._calculateAndLearn(symbol, trades, 'spot');
                totalPnl += pnlData.pnl;
                tradesCount += pnlData.count;
                wins += pnlData.wins;
                losses += pnlData.losses;
                tradeLog.push(...pnlData.details);
                await sleep(50); 
            } catch (err) {
                const msg = err.message || '';
                if (msg.includes('451') || msg.includes('RESTRICTED')) {
                    logger.error(`🛑 CRITICAL: Binance IP block detected. Skipping remaining sync.`);
                    break; // Escape the loop entirely
                }
                logger.warn(`⚠️ Error fetching ${symbol}: ${msg}`);
            }
        }
      }
    }

    const positionLog = this._aggregatePositionTrades(tradeLog);
    const positionCount = positionLog.length;
    const positionWins = positionLog.filter(t => parseFloat(t.pnl) > 0).length;
    const positionLosses = positionLog.filter(t => parseFloat(t.pnl) < 0).length;
    const winRate = positionCount > 0 ? (positionWins / positionCount) * 100 : 0;

    const latestTrade = positionLog.length > 0
      ? [...positionLog].sort((a, b) => (b.exitTime || 0) - (a.exitTime || 0))[0]
      : null;

    tracker.saveBinanceSnapshot({
      period,
      market,
      generatedAt: Date.now(),
      totalPnl: totalPnl.toFixed(2),
      tradesCount: positionCount,
      winRate: winRate.toFixed(2) + '%',
      wins: positionWins,
      losses: positionLosses,
      latestTrade
    });

    return {
      period,
      market,
      totalPnl: totalPnl.toFixed(2),
      tradesCount: positionCount,
      winRate: winRate.toFixed(2) + '%',
      wins: positionWins,
      losses: positionLosses,
      tradeLog: positionLog.reverse(), // Return position-based ledger for chat display
      rawTradeLog: tradeLog.reverse()
    };
  }

  /**
   * Calculate PnL and learn from mistakes.
   */
  async _calculateAndLearn(symbol, trades, market = 'spot') {
    let pnl = 0;
    let count = 0;
    let wins = 0;
    let losses = 0;
    const details = [];

    if (market === 'futures') {
        const enrichedTrades = this._attachFuturesEntryContext(trades);

        enrichedTrades.forEach(t => {
            if (t.realizedPnl !== 0) {
                pnl += t.realizedPnl;
                count++;
                if (t.realizedPnl > 0) wins++; else losses++;
                
                const exitPrice = t.price;
                const pnlValue = t.realizedPnl;
                const qty = t.qty;
                // If it's a manual trade (signalRecord is null), estimate entry price
                // For Futures: isBuyer=true (Buy to Close Short), isBuyer=false (Sell to Close Long)
                const estimatedEntry = t.isBuyer ? (exitPrice + (pnlValue / qty)) : (exitPrice - (pnlValue / qty));

                // Find matching signal record in bot memory
                const signalRecord = tracker.history.find(h => 
                    h.symbol === t.symbol && 
                    Math.abs((h.closedAt || h.signalAt) - t.time) < 24 * 60 * 60 * 1000
                );

                details.push({
                    symbol: t.symbol,
                    market: 'FUT',
                    pnl: pnlValue.toFixed(2),
                    exitTime: t.time,
                    exitPrice: exitPrice,
                    entryPrice: signalRecord ? signalRecord.entry : (t.entryPrice || estimatedEntry),
                    entryTime: signalRecord ? (signalRecord.entryAt || signalRecord.signalAt) : (t.entryTime || null),
                    sl: signalRecord ? signalRecord.stop_loss : null,
                    tp: signalRecord ? signalRecord.take_profit : null,
                    rr: signalRecord && signalRecord.riskReward ? signalRecord.riskReward.rr : null,
                    quoteQty: t.quoteQty
                });

                if (t.realizedPnl < -0.1) {
                    const finalEntry = signalRecord ? signalRecord.entry : estimatedEntry;
                    this._triggerAiLesson(t.symbol, finalEntry, t.price, t.realizedPnl, t.time, 'FUTURES');
                }
            }
        });
        return { pnl, count, wins, losses, details };
    }

    const sorted = [...trades].sort((a, b) => a.time - b.time);
    let inventoryQty = 0;
    let avgCost = 0;
    let inventoryStartTime = null;

    for (const t of sorted) {
      if (t.isBuyer) {
        if (inventoryQty === 0) inventoryStartTime = t.time;
        const newTotalCost = (inventoryQty * avgCost) + t.quoteQty;
        inventoryQty += t.qty;
        avgCost = inventoryQty > 0 ? newTotalCost / inventoryQty : 0;
      } else {
        if (inventoryQty > 0) {
          const sellQty = Math.min(t.qty, inventoryQty);
          const realizedPnl = (t.price - (avgCost / (inventoryQty / sellQty))) * sellQty;
          
          pnl += realizedPnl;
          count++;
          if (realizedPnl > 0) wins++; else losses++;

          const signalRecord = tracker.history.find(h => 
              h.symbol === symbol && 
              Math.abs((h.closedAt || h.signalAt) - t.time) < 24 * 60 * 60 * 1000
          );

          details.push({
            symbol,
            market: 'SPOT',
            pnl: realizedPnl.toFixed(2),
            exitTime: t.time,
            exitPrice: t.price,
            entryPrice: signalRecord ? signalRecord.entry : avgCost,
            entryTime: signalRecord ? (signalRecord.entryAt || signalRecord.signalAt) : inventoryStartTime,
            sl: signalRecord ? signalRecord.stop_loss : null,
            tp: signalRecord ? signalRecord.take_profit : null,
            rr: signalRecord && signalRecord.riskReward ? signalRecord.riskReward.rr : null,
            quoteQty: t.quoteQty
          });

          if (realizedPnl < -0.1) {
            this._triggerAiLesson(symbol, avgCost, t.price, realizedPnl, t.time, 'SPOT');
          }
          inventoryQty -= sellQty;
        }
      }
    }

    return { pnl, count, wins, losses, details };
  }

  /**
   * Group fill-level trade rows into position-level rows.
   * This collapses multiple partial fills/close orders into a single ledger line.
   */
  _aggregatePositionTrades(details = []) {
    const buckets = new Map();

    for (const trade of details) {
      const entryPrice = trade.entryPrice != null ? parseFloat(trade.entryPrice) : null;
      const entryTime = trade.entryTime != null ? Number(trade.entryTime) : null;
      const timeKey = entryTime != null ? entryTime : (trade.exitTime != null ? Number(trade.exitTime) : 0);
      const entryKey = entryPrice != null ? entryPrice.toFixed(6) : 'na';
      const key = [
        trade.market || 'UNK',
        trade.symbol || 'PAIR',
        entryKey,
        timeKey
      ].join('|');

      const pnlValue = parseFloat(trade.pnl || 0);
      const quoteQtyValue = trade.quoteQty != null ? Number(trade.quoteQty) : 0;

      if (!buckets.has(key)) {
        buckets.set(key, {
          ...trade,
          pnl: pnlValue,
          quoteQty: quoteQtyValue,
          fills: 1
        });
        continue;
      }

      const current = buckets.get(key);
      current.pnl += pnlValue;
      current.quoteQty += quoteQtyValue;
      current.fills += 1;

      if ((trade.exitTime || 0) > (current.exitTime || 0)) {
        current.exitTime = trade.exitTime;
        current.exitPrice = trade.exitPrice;
      }

      if (current.entryTime == null && trade.entryTime != null) current.entryTime = trade.entryTime;
      if (current.entryPrice == null && trade.entryPrice != null) current.entryPrice = trade.entryPrice;
      if (trade.sl != null && current.sl == null) current.sl = trade.sl;
      if (trade.tp != null && current.tp == null) current.tp = trade.tp;
      if (trade.rr != null && current.rr == null) current.rr = trade.rr;
    }

    return [...buckets.values()]
      .map(t => ({
        ...t,
        pnl: Number(t.pnl).toFixed(2),
      }))
      .sort((a, b) => (b.exitTime || 0) - (a.exitTime || 0));
  }

  /**
   * Asynchronously fetch candles and analyze the trade.
   */
  async _triggerAiLesson(symbol, entry, exit, pnl, tradeTime, mktType = 'SPOT') {
    try {
        const candles = await fetchOHLCV(symbol, '1h', 20);
        const side = pnl > 0 ? 'WIN' : 'LOSS';
        const review = await analyzeRealTrade(symbol, entry.toFixed(4), exit.toFixed(4), `${mktType} ${side}`, pnl, candles);
        
        if (review) {
            const lessonText = `[${mktType}] ${review.mistake_type}: ${review.analysis}`;
            const bias = pnl < 0 ? 'LOSS_REVIEW' : 'WIN_REVIEW';
            tracker.saveLesson(symbol, bias, lessonText);
            logger.info(`🧠 [BinanceSync] New AI Lesson added for ${symbol} ${mktType} trade.`);
        }
    } catch (err) {
        logger.error(`Failed to trigger AI lesson: ${err.message}`);
    }
  }

  _getStartTime(period) {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    switch (period) {
      case 'daily': return now - dayMs;
      case 'weekly': return now - (7 * dayMs);
      case 'monthly': return now - (30 * dayMs);
      case 'all': return null; // Null means fetch the MOST RECENT trades from Binance
      default: return null;
    }
  }

  /**
   * Infer opening fill context for futures closing trades directly from Binance fills.
   * This lets the report show entryTime/entryPrice even when the trade did not come from tracker memory.
   */
  _attachFuturesEntryContext(trades = []) {
    const sorted = [...trades].sort((a, b) => a.time - b.time);
    const openLots = [];
    const enriched = [];

    for (const trade of sorted) {
      const signedQty = trade.isBuyer ? trade.qty : -trade.qty;
      let remainingQty = Math.abs(signedQty);
      const tradeSide = Math.sign(signedQty);
      const consumedLots = [];

      while (remainingQty > 0 && openLots.length > 0 && Math.sign(openLots[0].signedQty) !== tradeSide) {
        const lot = openLots[0];
        const availableQty = Math.abs(lot.signedQty);
        const matchedQty = Math.min(remainingQty, availableQty);

        consumedLots.push({
          qty: matchedQty,
          price: lot.price,
          time: lot.time
        });

        remainingQty -= matchedQty;
        const lotSign = Math.sign(lot.signedQty);
        const leftoverQty = availableQty - matchedQty;

        if (leftoverQty <= 0) {
          openLots.shift();
        } else {
          openLots[0] = {
            ...lot,
            signedQty: lotSign * leftoverQty
          };
        }
      }

      const totalConsumedQty = consumedLots.reduce((sum, lot) => sum + lot.qty, 0);
      const inferredEntryPrice = totalConsumedQty > 0
        ? consumedLots.reduce((sum, lot) => sum + (lot.price * lot.qty), 0) / totalConsumedQty
        : null;
      const inferredEntryTime = consumedLots.length > 0 ? consumedLots[0].time : null;

      if (remainingQty > 0) {
        openLots.push({
          signedQty: tradeSide * remainingQty,
          price: trade.price,
          time: trade.time
        });
      }

      enriched.push({
        ...trade,
        entryPrice: inferredEntryPrice,
        entryTime: inferredEntryTime
      });
    }

    return enriched;
  }
}

module.exports = new BinancePerformance();
