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

    const marketsToScan = market === 'combined' ? ['spot', 'futures'] : [market];
    logger.info(`📊 Global Binance ${market.toUpperCase()} sync starting (${period})...`);

    for (const mkt of marketsToScan) {
      if (mkt === 'futures') {
        // FUTURES: We can fetch ALL symbols in one go (very efficient)
        const trades = await fetchUserTrades('', startTime, 'futures'); 
        const pnlData = await this._calculateAndLearn('GLOBAL_FUTURES', trades, 'futures');
        totalPnl += pnlData.pnl;
        tradesCount += pnlData.count;
        wins += pnlData.wins;
        losses += pnlData.losses;
      } else {
        // SPOT: Individual symbol scan (need to broaden the search)
        const scanPairs = await fetchTopPairs(50); // Scan top 50 pairs
        for (const symbol of scanPairs) {
            const trades = await fetchUserTrades(symbol, startTime, 'spot');
            if (trades.length === 0) continue;

            const pnlData = await this._calculateAndLearn(symbol, trades, 'spot');
            totalPnl += pnlData.pnl;
            tradesCount += pnlData.count;
            wins += pnlData.wins;
            losses += pnlData.losses;
            await sleep(50); 
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
      losses
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

    if (market === 'futures') {
        // Futures provides realizedPnl directly
        trades.forEach(t => {
            if (t.realizedPnl !== 0) {
                pnl += t.realizedPnl;
                count++;
                if (t.realizedPnl > 0) wins++; else if (t.realizedPnl < -0.1) {
                    losses++;
                    this._triggerAiLesson(symbol, t.price, t.price, t.realizedPnl, t.time, 'FUTURES');
                } else losses++;
            }
        });
        return { pnl, count, wins, losses };
    }

    // Spot needs manual matching
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
          } else if (realizedPnl < -0.1) {
            losses++;
            this._triggerAiLesson(symbol, avgCost, t.price, realizedPnl, t.time, 'SPOT');
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
