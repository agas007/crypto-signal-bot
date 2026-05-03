/**
 * Cloudflare Worker — Discord Slash Command Handler
 *
 * Handles:
 *  /active    — list active trades (read from Upstash Redis)
 *  /history   — last 10 trade results
 *  /lessons   — recent AI lessons
 *  /watchlist — last cycle watchlist
 *  /status    — bot status summary
 *  /log       — last scan cycle summary and error samples
 *
 * Secrets needed (set via: wrangler secret put <NAME>):
 *   DISCORD_PUBLIC_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 */

// ─── Discord Interaction Types ────────────────────────────────────────────────
const InteractionType    = { PING: 1, APPLICATION_COMMAND: 2 };
const InteractionResType = { PONG: 1, CHANNEL_MESSAGE: 4 };

// ─── Redis helpers (Upstash REST, no SDK needed in Workers) ──────────────────

async function redisGet(env, key) {
  const res = await fetch(env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(['GET', key]),
  });
  const data = await res.json();
  return data.result ? JSON.parse(data.result) : null;
}

function formatWibTime(timestamp) {
  if (!timestamp) return 'N/A';
  try {
    return new Date(timestamp).toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta',
      hour12: false,
    });
  } catch (_) {
    return 'N/A';
  }
}

// ─── Discord signature verification ──────────────────────────────────────────

async function verifyDiscordSignature(request, publicKey) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp  = request.headers.get('X-Signature-Timestamp');
  if (!signature || !timestamp) return false;

  const body = await request.clone().arrayBuffer();
  const key = await crypto.subtle.importKey(
    'raw',
    hexToBytes(publicKey),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );

  const data = new TextEncoder().encode(timestamp + new TextDecoder().decode(body));
  return crypto.subtle.verify('Ed25519', key, hexToBytes(signature), data);
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Command Handlers ─────────────────────────────────────────────────────────

async function handleActive(env) {
  const signals = await redisGet(env, 'bot:signals') || {};
  const actives = Object.values(signals).filter(s => s.status === 'ACTIVE');

  if (actives.length === 0) {
    return '😴 **No active signals** at the moment.';
  }

  const lines = actives.map((s, i) => {
    const ageMin = Math.floor((Date.now() - (s.entryAt || Date.now())) / 60000);
    const ageStr = ageMin > 60 ? `${(ageMin / 60).toFixed(1)}h` : `${ageMin}m`;
    const rr = s.take_profit && s.entry && s.stop_loss
      ? (Math.abs(s.take_profit - s.entry) / Math.abs(s.entry - s.stop_loss)).toFixed(2)
      : 'N/A';
    const biasEmoji = s.bias === 'LONG' ? '🟢' : '🔴';
    return `**${i + 1}. ${biasEmoji} ${s.symbol}** (${s.bias})\n` +
           `  Entry: \`${s.entry}\` | TP: \`${s.take_profit}\` | SL: \`${s.stop_loss}\`\n` +
           `  R:R: \`${rr}\` | Age: \`${ageStr}\``;
  });

  return `⏳ **ACTIVE SIGNALS (${actives.length})**\n\n${lines.join('\n\n')}`;
}

async function handleHistory(env) {
  const history = await redisGet(env, 'bot:history') || [];
  if (history.length === 0) return '📜 **No trade history** yet.';

  const recent = history.slice(-10).reverse();
  const lines = recent.map((t, i) => {
    const emoji = t.close_reason === 'TP_HIT' ? '✅' : t.close_reason === 'SL_HIT' ? '🚨' : '⚪';
    return `**${i + 1}. ${emoji} ${t.symbol}** (${t.bias})\n  In: \`${t.entry}\` → Out: \`${t.exit_price || 'N/A'}\` | \`${t.close_reason}\``;
  });

  return `📜 **LAST ${recent.length} TRADE RESULTS**\n\n${lines.join('\n\n')}`;
}

async function handleLessons(env) {
  const lessons = await redisGet(env, 'bot:lessons') || [];
  if (lessons.length === 0) return '🧠 **No lessons learned** yet. Keep trading!';

  const recent = lessons.slice(-5).reverse();
  const lines = recent.map((l, i) =>
    `**${i + 1}. ${l.symbol}** (${l.bias})\n*${l.analysis}*`
  );

  return `🧠 **RECENT AI LESSONS (Post-Mortem)**\n\n${lines.join('\n\n')}`;
}

async function handleWatchlist(env) {
  const list = await redisGet(env, 'bot:watchlist') || [];
  if (list.length === 0) return '😴 **Watchlist is empty.** Wait for next scan cycle...';

  const top = list.slice(0, 8);
  const lines = top.map((s, i) => {
    const rr = s.riskReward?.rr ? s.riskReward.rr.toFixed(2) : 'N/A';
    const typeEmoji = s.quality === 'WATCHLIST' ? '📋' : '🚫';
    const reason = (s.reason || 'No reason').slice(0, 120);
    return `**${i + 1}. ${typeEmoji} ${s.symbol}** (${s.bias || 'N/A'})\n  Score: \`${s.score}/100\` | R:R: \`${rr}\`\n  *${reason}*`;
  });

  return `📡 **HIGH ALERT WATCHLIST (${top.length})**\n*Close but didn't meet strict criteria.*\n\n${lines.join('\n\n')}\n\n🛡️ **Status:** Standing by.`;
}

async function handleStatus(env) {
  const [signals, history] = await Promise.all([
    redisGet(env, 'bot:signals'),
    redisGet(env, 'bot:history'),
  ]);

  const actives  = Object.values(signals || {}).filter(s => s.status === 'ACTIVE');
  const slToday  = (history || []).filter(t => {
    const reset = new Date();
    reset.setHours(2, 0, 0, 0); // 09:00 WIB = 02:00 UTC
    if (reset > new Date()) reset.setDate(reset.getDate() - 1);
    return t.close_reason === 'SL_HIT' && t.closedAt > reset.getTime();
  }).length;

  const statusEmoji = slToday >= 3 ? '🚫' : '🟢';
  return `${statusEmoji} **Bot Status**\n\n` +
         `🎯 **Active Trades:** ${actives.length}\n` +
         `🚨 **SL Hits Today:** ${slToday}/3\n` +
         `📊 **Total History:** ${(history || []).length} trades\n` +
         `⌛ **Scan:** GitHub Actions cron (hourly)\n` +
         `🕒 **Commands:** Cloudflare Workers`;
}

async function handleLog(env) {
  const report = await redisGet(env, 'bot:scan_report');
  if (!report) {
    return '🧾 **No scan report yet.** Wait for the next scan cycle to complete.';
  }

  const started = formatWibTime(report.startedAt);
  const finished = formatWibTime(report.finishedAt);
  const durationSec = typeof report.durationMs === 'number'
    ? (report.durationMs / 1000).toFixed(1)
    : 'N/A';
  const checks = report.checks || {};
  const summary = report.summary || {};
  const errorSamples = Array.isArray(report.errors) ? report.errors.slice(0, 5) : [];
  const providerHealth = report.providerHealth || {};
  const providerEvents = Array.isArray(providerHealth.recentEvents) ? providerHealth.recentEvents.slice(-4) : [];
  const preferredByMethod = providerHealth.preferredByMethod || {};
  const methods = providerHealth.methods || {};
  const statusEmoji = report.status === 'ERROR' || report.status === 'GLOBAL_KILLSWITCH'
    ? '🚨'
    : report.errorCount > 0
      ? '⚠️'
      : '🟢';

  const lines = [
    `${statusEmoji} **LAST SCAN REPORT**`,
    '',
    `• **Status:** \`${report.status || 'UNKNOWN'}\``,
    `• **Started:** \`${started}\``,
    `• **Finished:** \`${finished}\``,
    `• **Duration:** \`${durationSec}s\``,
    `• **Signals sent:** \`${report.signalCount ?? 0}\``,
    `• **Watchlist:** \`${report.watchlistCount ?? 0}\``,
    `• **Candidates:** \`${report.candidateCount ?? 0}\``,
    `• **Rejected:** \`${report.rejectedCount ?? 0}\``,
    `• **Filtered:** \`${report.filteredCount ?? 0}\``,
    `• **Errors:** \`${report.errorCount ?? 0}\``,
  ];

  if (checks.dailyCount !== undefined || checks.globalSlToday !== undefined || checks.pairs !== undefined) {
    lines.push('');
    lines.push('**Checks**');
    if (checks.dailyCount !== undefined) lines.push(`• Daily Count: \`${checks.dailyCount}\``);
    if (checks.globalSlToday !== undefined) lines.push(`• SL Today: \`${checks.globalSlToday}/3\``);
    if (checks.pairs !== undefined) lines.push(`• Pairs Fetched: \`${checks.pairs}\``);
    if (checks.btcTrend) lines.push(`• BTC Trend: \`${checks.btcTrend}\``);
  }

  if (errorSamples.length > 0) {
    lines.push('');
    lines.push('**Error Samples**');
    for (const err of errorSamples) {
      lines.push(`• ${String(err).slice(0, 180)}`);
    }
    if (report.errorCount > errorSamples.length) {
      lines.push(`• ...and ${report.errorCount - errorSamples.length} more`);
    }
  } else {
    lines.push('');
    lines.push('**Errors:** None captured in the last cycle.');
  }

  if (summary && Object.keys(summary).length > 0) {
    lines.push('');
    lines.push('**Summary**');
    if (summary.dailyCount !== undefined) lines.push(`• Daily Count: \`${summary.dailyCount}\``);
    if (summary.globalSlToday !== undefined) lines.push(`• SL Today: \`${summary.globalSlToday}/3\``);
  }

  if (providerHealth.blockedProviders?.length || providerEvents.length) {
    lines.push('');
    lines.push('**Provider Health**');
    const methodNames = Object.keys(methods);
    if (methodNames.length) {
      const tickerHealth = methods.fetch24hTicker || methods.fetchOHLCV || methods.fetchExchangeSpecs || {};
      const healthSummary = Object.entries(tickerHealth)
        .slice(0, 4)
        .map(([provider, stats]) => `${provider}:${stats.blocked ? 'blocked' : stats.lastOutcome || 'idle'}:${Math.round(stats.score || 0)}`)
        .join(' | ');
      if (healthSummary) {
        lines.push(`• Health: \`${healthSummary}\``);
      }
    }
    if (Object.keys(preferredByMethod).length) {
      const preferredSummary = Object.entries(preferredByMethod)
        .slice(0, 4)
        .map(([method, provider]) => `${method}→${provider}`)
        .join(' | ');
      if (preferredSummary) {
        lines.push(`• Preferred: \`${preferredSummary}\``);
      }
    }
    if (providerHealth.blockedProviders?.length) {
      lines.push(`• Blocked: \`${providerHealth.blockedProviders.join(', ')}\``);
    }
    if (providerEvents.length) {
      for (const evt of providerEvents) {
        const time = formatWibTime(evt.ts);
        lines.push(`• [${time}] \`${evt.provider}\` / \`${evt.method}\` -> \`${evt.status}\``);
      }
    }
  }

  return lines.join('\n');
}

// ─── Command Router ───────────────────────────────────────────────────────────

const COMMANDS = {
  active:    handleActive,
  history:   handleHistory,
  lessons:   handleLessons,
  watchlist: handleWatchlist,
  status:    handleStatus,
  log:       handleLog,
};

// ─── Main Worker Handler ──────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Verify Discord signature
    const isValid = await verifyDiscordSignature(request, env.DISCORD_PUBLIC_KEY);
    if (!isValid) return new Response('Invalid signature', { status: 401 });

    const body = await request.json();

    // Handle Discord PING (required for verification)
    if (body.type === InteractionType.PING) {
      return json({ type: InteractionResType.PONG });
    }

    // Handle Slash Commands
    if (body.type === InteractionType.APPLICATION_COMMAND) {
      const commandName = body.data?.name?.toLowerCase();
      const handler = COMMANDS[commandName];

      if (!handler) {
        return json({
          type: InteractionResType.CHANNEL_MESSAGE,
          data: { content: `❌ Unknown command: \`/${commandName}\`` },
        });
      }

      try {
        const content = await handler(env);
        // Truncate if over Discord's 2000 char limit
        const safe = content.length > 1900 ? content.slice(0, 1900) + '\n...[truncated]' : content;
        return json({ type: InteractionResType.CHANNEL_MESSAGE, data: { content: safe } });
      } catch (err) {
        console.error(`Command /${commandName} failed:`, err);
        return json({
          type: InteractionResType.CHANNEL_MESSAGE,
          data: { content: `❌ Command failed: \`${err.message}\`` },
        });
      }
    }

    return new Response('Unknown interaction type', { status: 400 });
  },
};
