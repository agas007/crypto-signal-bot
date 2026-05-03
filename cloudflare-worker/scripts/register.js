/**
 * Register Discord slash commands for the bot.
 *
 * Run ONCE after setup:
 *   DISCORD_BOT_TOKEN=... DISCORD_APP_ID=... node scripts/register.js
 */

const COMMANDS = [
  {
    name: 'active',
    description: '⏳ List all currently active trade signals',
  },
  {
    name: 'history',
    description: '📜 View last 10 trade results (TP/SL hits)',
  },
  {
    name: 'lessons',
    description: '🧠 View recent AI post-mortem lessons',
  },
  {
    name: 'watchlist',
    description: '📡 View last scan cycle high-alert watchlist',
  },
  {
    name: 'status',
    description: '📊 Bot health: active trades, SL count, scan info',
  },
  {
    name: 'log',
    description: '🧾 View the latest scan report and errors',
  },
];

async function register() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const appId = process.env.DISCORD_APP_ID;

  if (!token || !appId) {
    console.error('❌ Missing env vars: DISCORD_BOT_TOKEN and DISCORD_APP_ID are required.');
    process.exit(1);
  }

  const url = `https://discord.com/api/v10/applications/${appId}/commands`;

  console.log(`📡 Registering ${COMMANDS.length} global slash commands...`);

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(COMMANDS),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error('❌ Registration failed:', JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log(`✅ Registered ${data.length} commands successfully:`);
  data.forEach(cmd => console.log(`  /${cmd.name} — ${cmd.description}`));
}

register().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
