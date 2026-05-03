const { getDiscordCommandDefinitions } = require('../../src/services/discord_commands');

async function main() {
  const appId = process.env.DISCORD_APPLICATION_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!appId) {
    throw new Error('DISCORD_APPLICATION_ID is required');
  }

  if (!botToken) {
    throw new Error('DISCORD_BOT_TOKEN is required');
  }

  const endpoint = guildId
    ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${appId}/commands`;

  const commands = getDiscordCommandDefinitions();

  const res = await fetch(endpoint, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Discord API ${res.status}: ${JSON.stringify(body)}`);
  }

  console.log(`Registered ${Array.isArray(body) ? body.length : commands.length} command(s)`);
  console.log(`Scope: ${guildId ? `guild ${guildId}` : 'global'}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
