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

    const winRate = tradesCount > 0 ? (wins / tradesCount) * 100 : 0;

    return {
      period,
      market,
      totalPnl: totalPnl.toFixed(2),
      tradesCount,
      winRate: winRate.toFixed(2) + '%',
      wins,
      losses,
      tradeLog: tradeLog.reverse() // Return all trades, bot will slice for chat display
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
        trades.forEach(t => {
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

                details.push({
                    symbol: t.symbol,
                    market: 'FUT',
                    pnl: pnlValue.toFixed(2),
                    exitTime: t.time,
                    exitPrice: exitPrice,
                    entryPrice: signalRecord ? signalRecord.entry : estimatedEntry,
                    entryTime: signalRecord ? (signalRecord.entryAt || signalRecord.signalAt) : null,
                    sl: signalRecord ? signalRecord.stop_loss : null,
                    tp: signalRecord ? signalRecord.take_profit : null,
                    rr: signalRecord && signalRecord.riskReward ? signalRecord.riskReward.rr : null,
                    quoteQty: t.quoteQty
                });

                if (t.realizedPnl < -0.1) {
                    this._triggerAiLesson(t.symbol, t.price, t.price, t.realizedPnl, t.time, 'FUTURES');
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
              Math.abs(h.closedAt - t.time) < 24 * 60 * 60 * 1000
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
}

module.exports = new BinancePerformance();
