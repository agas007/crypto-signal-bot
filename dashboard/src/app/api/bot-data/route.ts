import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { aggregatePositionHistory } from '../../../../../src/utils/trade_aggregation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function normalizeCloseReason(trade: any) {
  if (!trade) return trade;
  if (trade.close_reason) return trade;

  const pnl = Number(trade.pnl);
  if (Number.isFinite(pnl)) {
    return {
      ...trade,
      close_reason: pnl >= 0 ? 'TP_HIT' : 'SL_HIT',
    };
  }

  return trade;
}

async function fetchLiveTicker(symbol: string) {
  const normalized = symbol.toUpperCase();
  const response = await fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(normalized)}`, {
    cache: 'no-store',
  });

  if (!response.ok) return null;

  const payload = await response.json();
  return {
    symbol: payload.symbol,
    lastPrice: Number(payload.lastPrice),
    priceChangePercent: Number(payload.priceChangePercent),
    quoteVolume: Number(payload.quoteVolume),
    updatedAt: Date.now(),
  };
}

export async function GET() {
  const debugInfo: any = {
    cwd: process.cwd(),
    dataDir: process.env.DATA_DIR || null,
    testedPaths: {},
    errors: {}
  };

  try {
    const resolvePath = (filename: string) => {
      const possiblePaths: string[] = [];
      
      if (process.env.DATA_DIR) {
        possiblePaths.push(path.join(process.env.DATA_DIR, filename));
      }
      possiblePaths.push(path.join(process.cwd(), filename));
      possiblePaths.push(path.join(process.cwd(), '../' + filename));
      possiblePaths.push(path.join(__dirname, '../../../../../../', filename));
      
      debugInfo.testedPaths[filename] = possiblePaths;

      for (const p of possiblePaths) {
        if (fs.existsSync(p)) return p;
      }
      return null;
    };

    const data: any = {
      signals: [],
      history: [],
      lessons: [],
      logs: "",
      watchlist: [],
      binanceSnapshot: null
    };

    const signalsPath = resolvePath('active_signals.json');
    if (signalsPath) {
      debugInfo.resolvedSignalsPath = signalsPath;
      try { data.signals = JSON.parse(fs.readFileSync(signalsPath, 'utf8')); } catch (e: any) { debugInfo.errors.signals = e.message; }
    }

    const historyPath = resolvePath('trade_history.json');
    if (historyPath) {
      debugInfo.resolvedHistoryPath = historyPath;
      try {
        const rawHistory = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
        data.history = aggregatePositionHistory(Array.isArray(rawHistory) ? rawHistory : []);
      } catch (e: any) { debugInfo.errors.history = e.message; }
    }

    const lessonsPath = resolvePath('history_lessons.json');
    if (lessonsPath) {
      debugInfo.resolvedLessonsPath = lessonsPath;
      try { data.lessons = JSON.parse(fs.readFileSync(lessonsPath, 'utf8')); } catch (e: any) { debugInfo.errors.lessons = e.message; }
    }

    const logsPath = resolvePath('scan_audit.log');
    if (logsPath) {
      debugInfo.resolvedLogsPath = logsPath;
      try { 
        const fullLogs = fs.readFileSync(logsPath, 'utf8'); 
        data.logs = fullLogs.trim().split('\n').slice(-50).join('\n');
      } catch (e: any) { debugInfo.errors.logs = e.message; }
    }

    const watchlistPath = resolvePath('latest_watchlist.json');
    if (watchlistPath) {
      debugInfo.resolvedWatchlistPath = watchlistPath;
      try { data.watchlist = JSON.parse(fs.readFileSync(watchlistPath, 'utf8')); } catch (e: any) { debugInfo.errors.watchlist = e.message; }
    }

    const binanceSnapshotPath = resolvePath('binance_trade_snapshot.json');
    if (binanceSnapshotPath) {
      debugInfo.resolvedBinanceSnapshotPath = binanceSnapshotPath;
      try { data.binanceSnapshot = JSON.parse(fs.readFileSync(binanceSnapshotPath, 'utf8')); } catch (e: any) { debugInfo.errors.binanceSnapshot = e.message; }
    }

    // Normalize signal object if it's stored as keyed object instead of array
    if (data.signals && !Array.isArray(data.signals)) {
      data.signals = Object.values(data.signals);
    }

    if (Array.isArray(data.signals)) {
      const livePricePairs = await Promise.allSettled(
        data.signals
          .filter((signal: any) => signal && (signal.bias === 'LONG' || signal.bias === 'SHORT'))
          .slice(0, 10)
          .map(async (signal: any) => {
            const ticker = await fetchLiveTicker(signal.symbol);
            return [signal.symbol, ticker];
          })
      );

      data.livePrices = livePricePairs.reduce((acc: Record<string, unknown>, result) => {
        if (result.status !== 'fulfilled') return acc;
        const [symbol, ticker] = result.value as [string, Awaited<ReturnType<typeof fetchLiveTicker>>];
        if (ticker) {
          acc[symbol] = ticker;
        }
        return acc;
      }, {});
    }

    if (data.binanceSnapshot) {
      data.binanceSnapshot = {
        ...data.binanceSnapshot,
        latestTrade: normalizeCloseReason(data.binanceSnapshot.latestTrade),
        tradeLog: Array.isArray(data.binanceSnapshot.tradeLog)
          ? data.binanceSnapshot.tradeLog.map((trade: any) => normalizeCloseReason(trade))
          : [],
      };
    }

    return NextResponse.json({ success: true, ...data, debug: debugInfo });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ success: false, error: message, debug: debugInfo }, { status: 500 });
  }
}
