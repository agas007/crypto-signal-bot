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
   * Get PnL and Win Rate for a specific timeframe.
   * 
   * @param {'daily' | 'weekly' | 'monthly' | 'all'} period 
   * @returns {Promise<Object>} Performance stats
   */
  async getPerformance(period = 'all') {
    const startTime = this._getStartTime(period);
    const pairs = await fetchTopPairs(30);
    
    let totalPnl = 0;
    let tradesCount = 0;
    let wins = 0;
    let losses = 0;

    logger.info(`📊 Syncing Binance trades for period: ${period}...`);

    for (const symbol of pairs) {
      const trades = await fetchUserTrades(symbol, startTime);
      if (trades.length < 2) continue;

      const pnlData = await this._calculateAndLearn(symbol, trades);
      totalPnl += pnlData.pnl;
      tradesCount += pnlData.count;
      wins += pnlData.wins;
      losses += pnlData.losses;

      await sleep(100);
    }

    const winRate = tradesCount > 0 ? (wins / tradesCount) * 100 : 0;

    return {
      period,
      totalPnl: totalPnl.toFixed(2),
      tradesCount,
      winRate: winRate.toFixed(2) + '%',
      wins,
      losses
    };
  }

  /**
   * Calculate PnL and learn from mistakes.
   */
  async _calculateAndLearn(symbol, trades) {
    let pnl = 0;
    let count = 0;
    let wins = 0;
    let losses = 0;

    const sorted = [...trades].sort((a, b) => a.time - b.time);
    let inventoryQty = 0;
    let avgCost = 0;

    for (const t of sorted) {
      if (t.isBuyer) {
        const newTotalCost = (inventoryQty * avgCost) + t.quoteQty;
        inventoryQty += t.qty;
        avgCost = inventoryQty > 0 ? newTotalCost / inventoryQty : 0;
      } else {
        if (inventoryQty > 0) {
          const sellQty = Math.min(t.qty, inventoryQty);
          const realizedPnl = (t.price - (avgCost / (inventoryQty / sellQty))) * sellQty;
          
          pnl += realizedPnl;
          count++;
          if (realizedPnl > 0) {
            wins++;
          } else if (realizedPnl < -0.1) { // Only analyze losses > $0.1 to avoid dust
            losses++;
            // LOSS DETECTED: Call AI Reviewer async to not block
            this._triggerAiLesson(symbol, avgCost, t.price, realizedPnl, t.time);
          } else {
            losses++;
          }

          inventoryQty -= sellQty;
        }
      }
    }

    return { pnl, count, wins, losses };
  }

  /**
   * Asynchronously fetch candles and analyze the trade.
   */
  async _triggerAiLesson(symbol, entry, exit, pnl, tradeTime) {
    try {
        // Fetch context around the trade time
        const candles = await fetchOHLCV(symbol, '1h', 20); // 20 candles for context
        const review = await analyzeRealTrade(symbol, entry.toFixed(4), exit.toFixed(4), 'LONG/SHORT', pnl, candles);
        
        if (review) {
            const lessonText = `[REAL TRADE] ${review.mistake_type}: ${review.analysis}`;
            const bias = pnl < 0 ? 'LOSS_REVIEW' : 'WIN_REVIEW';
            
            tracker.saveLesson(symbol, bias, lessonText);
            logger.info(`🧠 [BinanceSync] New AI Lesson added for ${symbol} real trade.`);
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
      default: return now - (90 * dayMs); // Max 90 days for performance scan
    }
  }
}

module.exports = new BinancePerformance();
