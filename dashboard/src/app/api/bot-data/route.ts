import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const debugInfo: any = {
    cwd: process.cwd(),
    dataDir: process.env.DATA_DIR || null,
    testedPaths: {},
    errors: {}
  };

  try {
    const resolvePath = (filename: string) => {
      const possiblePaths = [];
      
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
      try { data.history = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch (e: any) { debugInfo.errors.history = e.message; }
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

    return NextResponse.json({ success: true, ...data, debug: debugInfo });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ success: false, error: message, debug: debugInfo }, { status: 500 });
  }
}
