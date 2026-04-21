const { generateAndSendDashboard } = require('../modules/chart/dashboard');

async function run() {
  await generateAndSendDashboard();
}

run().catch((err) => console.error('Fatal dashboard generation error:', err));
