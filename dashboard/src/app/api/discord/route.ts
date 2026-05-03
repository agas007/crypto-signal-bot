import { createRequire } from 'module';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const require = createRequire(import.meta.url);
const {
  handleInteraction,
  hydrateTracker,
  verifyDiscordRequest,
} = require('../../../../../src/services/discord_commands');
const logger = require('../../../../../src/utils/logger');

export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get('x-signature-ed25519') || '';
  const timestamp = req.headers.get('x-signature-timestamp') || '';
  const publicKey = process.env.DISCORD_PUBLIC_KEY || '';

  if (!verifyDiscordRequest({ signature, timestamp, body: rawBody, publicKeyHex: publicKey })) {
    return Response.json(
      { ok: false, error: 'Invalid Discord signature' },
      { status: 401 }
    );
  }

  let interaction: any;
  try {
    interaction = JSON.parse(rawBody);
  } catch (err) {
    return Response.json(
      { ok: false, error: 'Invalid interaction payload' },
      { status: 400 }
    );
  }

  if (interaction?.type === 1) {
    return Response.json({ type: 1 });
  }

  try {
    await hydrateTracker();
    const payload = await handleInteraction(interaction, { logger });
    return Response.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error(`[dashboard/api/discord] Failed: ${message}`);

    return Response.json(
      {
        type: 4,
        data: {
          content: '❌ Command failed.',
          flags: 64,
          allowed_mentions: { parse: [] },
        },
      },
      { status: 500 }
    );
  }
}
