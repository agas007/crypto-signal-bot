import { createRequire } from 'module';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const require = createRequire(import.meta.url);
const { runSignalCheck } = require('../../../../../src/services/run_signal_check');
const logger = require('../../../../../src/utils/logger');

function readSecret(req: Request) {
  const authHeader = req.headers.get('authorization') || '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  const url = new URL(req.url);
  return url.searchParams.get('secret')?.trim() || '';
}

export async function GET(req: Request) {
  const headers = { 'Cache-Control': 'no-store, max-age=0' };

  const expectedSecret = process.env.CRON_SECRET;
  if (!expectedSecret) {
    return Response.json(
      { ok: false, error: 'CRON_SECRET is not configured' },
      { status: 500, headers }
    );
  }

  const providedSecret = readSecret(req);
  if (!providedSecret || providedSecret !== expectedSecret) {
    return Response.json(
      { ok: false, error: 'Unauthorized' },
      { status: 401, headers }
    );
  }

  try {
    const result = await runSignalCheck();

    return Response.json(
      {
        ok: true,
        status: result.report?.status || 'UNKNOWN',
        signalCount: result.signalCount,
        durationMs: result.durationMs,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        report: result.report || null,
      },
      { status: 200, headers }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`[dashboard/api/check-signal] Failed: ${message}`);

    return Response.json(
      {
        ok: false,
        error: 'Signal check failed',
        message,
      },
      { status: 500, headers }
    );
  }
}
