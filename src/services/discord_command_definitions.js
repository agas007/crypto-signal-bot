const COMMANDS = [
  {
    name: 'status',
    description: 'Show bot health, scan status, and runtime info',
    type: 1,
  },
  {
    name: 'scan-now',
    description: 'Trigger a fresh one-shot scan',
    type: 1,
  },
  {
    name: 'active',
    description: 'List currently active trades',
    type: 1,
  },
  {
    name: 'watchlist',
    description: 'Show the latest watchlist',
    type: 1,
  },
  {
    name: 'performance',
    description: 'Show cached performance summary',
    type: 1,
    options: [
      {
        name: 'period',
        description: 'Time range for cached summary',
        type: 3,
        required: false,
        choices: [
          { name: 'daily', value: 'daily' },
          { name: 'weekly', value: 'weekly' },
          { name: 'monthly', value: 'monthly' },
          { name: 'all', value: 'all' },
        ],
      },
      {
        name: 'market',
        description: 'Market scope',
        type: 3,
        required: false,
        choices: [
          { name: 'spot', value: 'spot' },
          { name: 'futures', value: 'futures' },
          { name: 'combined', value: 'combined' },
        ],
      },
    ],
  },
  {
    name: 'last-signal',
    description: 'Show the most recent signal or trade',
    type: 1,
  },
  {
    name: 'health',
    description: 'Show environment and service health',
    type: 1,
  },
  {
    name: 'help',
    description: 'Show available commands',
    type: 1,
  },
];

module.exports = { COMMANDS };
