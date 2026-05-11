import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function resolveScanLogPath() {
  const candidates = [
    process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'scan_audit.log') : null,
    path.join(process.cwd(), 'scan_audit.log'),
    path.join(process.cwd(), '../scan_audit.log'),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

export async function GET(request: Request) {
  const logPath = resolveScanLogPath();
  if (!logPath) {
    return NextResponse.json({ success: false, error: 'scan_audit.log not found' }, { status: 404 });
  }

  try {
    const content = fs.readFileSync(logPath, 'utf8');
    const url = new URL(request.url);
    const download = url.searchParams.get('download') === '1';
    const filename = `scan_audit_${new Date().toISOString().slice(0, 10)}.txt`;

    return new NextResponse(content || '', {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        ...(download
          ? { 'Content-Disposition': `attachment; filename="${filename}"` }
          : {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read scan audit log';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
