import { NextResponse } from 'next/server';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const require = createRequire(import.meta.url);
const { getState, isEnabled: isRedisEnabled } = require('../../../../../../src/utils/redis');
const { buildLatestScanReportExport, cleanupExportFile } = require('../../../../../../src/services/scan_export');
const tracker = require('../../../../../../src/modules/tracker');

async function resolveRawScanReport() {
  try {
    if (isRedisEnabled()) {
      await tracker.syncFromRedis().catch(() => {});
      const fromTracker = buildLatestScanReportExport(tracker);
      if (fromTracker) {
        return fromTracker;
      }

      const redisScanReport = await getState('bot:scan_report');
      if (redisScanReport) {
        const tempTracker = {
          getScanReport: () => redisScanReport,
        };
        return buildLatestScanReportExport(tempTracker);
      }
    }

    const candidates = [
      process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'scan_report.json') : null,
      path.join(process.cwd(), 'scan_report.json'),
      path.join(process.cwd(), '../scan_report.json'),
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      return buildLatestScanReportExport({
        getScanReport: () => raw,
      });
    }

    return null;
  } catch (err) {
    throw err;
  }
}

export async function GET(request: Request) {
  try {
    const exportData = await resolveRawScanReport();
    if (!exportData) {
      return NextResponse.json({ success: false, error: 'scan_report.json not found' }, { status: 404 });
    }

    const url = new URL(request.url);
    const download = url.searchParams.get('download') === '1';
    const filename = exportData.fileName || `scan_report_raw_${new Date().toISOString().slice(0, 10)}.json`;
    const body = JSON.stringify(exportData.payload, null, 2);

    if (exportData.filePath) {
      cleanupExportFile(exportData.filePath);
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...(download
          ? { 'Content-Disposition': `attachment; filename="${filename}"` }
          : {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read raw scan report';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
