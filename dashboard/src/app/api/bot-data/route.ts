import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const resolvePath = (filename: string) => {
      const possiblePaths = [
        path.join(process.cwd(), filename),
        path.join(process.cwd(), '../' + filename),
        path.join(__dirname, '../../../../../../', filename) // Fallback for deep Next.js dist paths
      ];
      return possiblePaths.find(p => fs.existsSync(p));
    };

    const data: any = {
      signals: [],
      history: [],
      lessons: [],
      logs: ""
    };

    const signalsPath = resolvePath('active_signals.json');
    if (signalsPath) {
      try { data.signals = JSON.parse(fs.readFileSync(signalsPath, 'utf8')); } catch (e) { }
    }

    const historyPath = resolvePath('trade_history.json');
    if (historyPath) {
      try { data.history = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch (e) { }
    }

    const lessonsPath = resolvePath('history_lessons.json');
    if (lessonsPath) {
      try { data.lessons = JSON.parse(fs.readFileSync(lessonsPath, 'utf8')); } catch (e) { }
    }

    const logsPath = resolvePath('scan_audit.log');
    if (logsPath) {
      try { 
        // Read only last 50 lines of logs to save bandwidth/memory
        const fullLogs = fs.readFileSync(logsPath, 'utf8'); 
        data.logs = fullLogs.trim().split('\n').slice(-50).join('\n');
      } catch (e) { }
    }

    // Normalize signal object if it's stored as keyed object instead of array
    if (data.signals && !Array.isArray(data.signals)) {
      data.signals = Object.values(data.signals);
    }

    return NextResponse.json({ success: true, ...data });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
