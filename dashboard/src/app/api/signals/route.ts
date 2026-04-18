import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
  try {
    // Look for active_signals.json in root or current dir
    const possiblePaths = [
      path.join(process.cwd(), 'active_signals.json'),
      path.join(process.cwd(), '../active_signals.json')
    ];
    
    const filePath = possiblePaths.find(p => fs.existsSync(p));
    
    if (filePath) {
      const data = fs.readFileSync(filePath, 'utf8');
      return NextResponse.json({ success: true, signals: JSON.parse(data) });
    } else {
      return NextResponse.json({ success: true, signals: [] });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
