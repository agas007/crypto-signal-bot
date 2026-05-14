import { NextResponse } from 'next/server';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { aggregatePositionHistory } from '../../../../../src/utils/trade_aggregation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const require = createRequire(import.meta.url);
const { getState, isEnabled: isRedisEnabled } = require('../../../../../src/utils/redis');

const REDIS_KEYS = {
  signals: 'bot:signals',
  lessons: 'bot:lessons',
  history: 'bot:history',
  watchlist: 'bot:watchlist',
  dashboard: 'bot:dashboard_state',
  scanReport: 'bot:scan_report',
};

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

async function readRedisJson(key: string) {
  if (!isRedisEnabled()) return null;

  try {
    return await getState(key);
  } catch (err) {
    return null;
  }
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
      binanceSnapshot: null,
      dashboardState: null,
      scanReport: null,
    };

    const redisSignals = await readRedisJson(REDIS_KEYS.signals);
    if (redisSignals) {
      data.signals = redisSignals;
      debugInfo.resolvedSignalsPath = 'redis:bot:signals';
    } else {
      const signalsPath = resolvePath('active_signals.json');
      if (signalsPath) {
        debugInfo.resolvedSignalsPath = signalsPath;
        try { data.signals = JSON.parse(fs.readFileSync(signalsPath, 'utf8')); } catch (e: any) { debugInfo.errors.signals = e.message; }
      }
    }

    const redisHistory = await readRedisJson(REDIS_KEYS.history);
    if (redisHistory) {
      data.history = aggregatePositionHistory(Array.isArray(redisHistory) ? redisHistory : []);
      debugInfo.resolvedHistoryPath = 'redis:bot:history';
    } else {
      const historyPath = resolvePath('trade_history.json');
      if (historyPath) {
        debugInfo.resolvedHistoryPath = historyPath;
        try {
          const rawHistory = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
          data.history = aggregatePositionHistory(Array.isArray(rawHistory) ? rawHistory : []);
        } catch (e: any) { debugInfo.errors.history = e.message; }
      }
    }

    const redisLessons = await readRedisJson(REDIS_KEYS.lessons);
    if (redisLessons) {
      data.lessons = redisLessons;
      debugInfo.resolvedLessonsPath = 'redis:bot:lessons';
    } else {
      const lessonsPath = resolvePath('history_lessons.json');
      if (lessonsPath) {
        debugInfo.resolvedLessonsPath = lessonsPath;
        try { data.lessons = JSON.parse(fs.readFileSync(lessonsPath, 'utf8')); } catch (e: any) { debugInfo.errors.lessons = e.message; }
      }
    }

    const logsPath = resolvePath('scan_audit.log');
    if (logsPath) {
      debugInfo.resolvedLogsPath = logsPath;
      try { 
        const fullLogs = fs.readFileSync(logsPath, 'utf8'); 
        data.logs = fullLogs.trim().split('\n').slice(-50).join('\n');
      } catch (e: any) { debugInfo.errors.logs = e.message; }
    }

    const redisWatchlist = await readRedisJson(REDIS_KEYS.watchlist);
    if (redisWatchlist) {
      data.watchlist = redisWatchlist;
      debugInfo.resolvedWatchlistPath = 'redis:bot:watchlist';
    } else {
      const watchlistPath = resolvePath('latest_watchlist.json');
      if (watchlistPath) {
        debugInfo.resolvedWatchlistPath = watchlistPath;
        try { data.watchlist = JSON.parse(fs.readFileSync(watchlistPath, 'utf8')); } catch (e: any) { debugInfo.errors.watchlist = e.message; }
      }
    }

    const redisDashboardState = await readRedisJson(REDIS_KEYS.dashboard);
    if (redisDashboardState) {
      data.dashboardState = redisDashboardState;
      debugInfo.resolvedDashboardStatePath = 'redis:bot:dashboard_state';
    }

    const redisScanReport = await readRedisJson(REDIS_KEYS.scanReport);
    if (redisScanReport) {
      data.scanReport = redisScanReport;
      debugInfo.resolvedScanReportPath = 'redis:bot:scan_report';
    } else {
      const scanReportPath = resolvePath('scan_report.json');
      if (scanReportPath) {
        debugInfo.resolvedScanReportPath = scanReportPath;
        try { data.scanReport = JSON.parse(fs.readFileSync(scanReportPath, 'utf8')); } catch (e: any) { debugInfo.errors.scanReport = e.message; }
      }
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

    if (data.scanReport) {
      data.scanReport = {
        ...data.scanReport,
        errors: Array.isArray(data.scanReport.errors) ? data.scanReport.errors : [],
      };
    }

    return NextResponse.json({ success: true, ...data, debug: debugInfo });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ success: false, error: message, debug: debugInfo }, { status: 500 });
  }
}
