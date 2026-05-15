const test = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';
process.env.TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || 'test-chat';

const config = require('../src/config');

function makeCandles(length = 60) {
  return Array.from({ length }, (_, index) => ({
    open: 100 + index * 0.1,
    high: 101 + index * 0.1,
    low: 99 + index * 0.1,
    close: 100.5 + index * 0.1,
    volume: 1000,
  }));
}

function loadStrategyWithMock(overrides = {}) {
  const indicatorsPath = require.resolve('../src/modules/indicators');
  const strategyPath = require.resolve('../src/modules/strategy');
  delete require.cache[strategyPath];
  delete require.cache[indicatorsPath];

  const levels = overrides.levels || {
    currentPrice: 100,
    wick: { support: 80, resistance: 120, supportTouches: 2, resistanceTouches: 2 },
    body: { support: 82, resistance: 118, supportTouches: 2, resistanceTouches: 2 },
    trend: {},
    pattern: { detected: false, breakout: false, breakoutDirection: null },
  };

  require.cache[indicatorsPath] = {
    id: indicatorsPath,
    filename: indicatorsPath,
    loaded: true,
    exports: {
      analyzeTrend: () => overrides.trend || { direction: 'bullish', strength: 0.7 },
      calculateStochastic: () => ({ signal: 'neutral', k: 50, d: 50, kSeries: [50, 50], dSeries: [50, 50] }),
      findSupportResistance: () => levels,
      analyzeStructure: () => overrides.structure || { structure: 'bullish', bos: false, bosType: null },
      detectAtSpike: () => ({ atr: overrides.atr ?? 1, spike: false, ratio: 1 }),
      detectRetest: () => overrides.retest || 'NONE',
      detectCompression: () => ({ compressed: false, breakout: false }),
      detectEma1321: () => ({ bias: 'bullish', goldenCross: false, deathCross: false, ema13AboveEma21: true }),
      detectStochCross: () => ({ crossBullish: false, crossBearish: false, crossInZone: false }),
      detectOrderBlocks: () => ({ inBullishOB: false, inBearishOB: false }),
      detectEngulfing: () => ({ bull: false, bear: false }),
      detectPinBar: () => ({ bullPin: false, bearPin: false }),
    },
  };

  return require('../src/modules/strategy');
}

test('normalizes impossible SL bounds when minSlPct exceeds maxSlPct', () => {
  const { calculateRiskReward } = loadStrategyWithMock();
  const result = calculateRiskReward('LONG', 100, {
    wick: { support: 80, resistance: 140 },
    body: { support: 82, resistance: 140 },
    trend: {},
  }, {
    symbol: 'TESTUSDT',
    atr: 10,
    accountBalance: 1000,
    minNotional: 5,
    stepSize: 0.001,
  });

  assert.equal(result.debug.normalized, true);
  assert.equal(result.debug.minSlPct > result.debug.oldMaxSlPct, true);
  assert.equal(result.debug.maxSlPct, result.debug.minSlPct * 1.25);
});

test('good score with SL out of bounds becomes WATCHLIST, not REJECT', () => {
  const { evaluateSignal } = loadStrategyWithMock({
    atr: 1,
    levels: {
      currentPrice: 100,
      wick: { support: 80, resistance: 120, supportTouches: 2, resistanceTouches: 2 },
      body: { support: 82, resistance: 120, supportTouches: 2, resistanceTouches: 2 },
      trend: {},
      pattern: { detected: false, breakout: false, breakoutDirection: null },
    },
  });

  const result = evaluateSignal('SLFAILUSDT', {
    D1: makeCandles(),
    H4: makeCandles(),
    H1: makeCandles(),
    M15: makeCandles(),
  }, {
    accountBalance: 1000,
    minNotional: 5,
    stepSize: 0.001,
    minFinalScore: 18,
    minRrRatio: 2,
    includeRejectionReason: true,
  });

  assert.equal(result.signal, undefined);
  assert.equal(result.standbyOnly, true);
  assert.equal(result.watchlistReason, 'WATCHLIST_SL_OUT_OF_BOUNDS');
  assert.equal(Number.isFinite(result.riskReward.rr), true);
  assert.equal(result.diagnostics.strategyDebug.decision, 'WATCHLIST');
});

test('good score with low notional becomes WATCHLIST_LOW_BALANCE', () => {
  const oldMaxPositionPercentage = config.strategy.maxPositionPercentage;
  config.strategy.maxPositionPercentage = 0.001;

  try {
    const { evaluateSignal } = loadStrategyWithMock({
      atr: 0.6,
      levels: {
        currentPrice: 100,
        wick: { support: 99, resistance: 108, supportTouches: 2, resistanceTouches: 2 },
        body: { support: 99, resistance: 108, supportTouches: 2, resistanceTouches: 2 },
        trend: {},
        pattern: { detected: false, breakout: false, breakoutDirection: null },
      },
    });

    const result = evaluateSignal('LOWBALUSDT', {
      D1: makeCandles(),
      H4: makeCandles(),
      H1: makeCandles(),
      M15: makeCandles(),
    }, {
      accountBalance: 5.15,
      minNotional: 5,
      stepSize: 0.001,
      minFinalScore: 1,
      minRrRatio: 2,
      includeRejectionReason: true,
    });

    assert.equal(result.standbyOnly, true);
    assert.equal(result.watchlistReason, 'WATCHLIST_LOW_BALANCE');
    assert.equal(Number.isFinite(result.riskReward.rr), true);
    assert.equal(result.riskReward.debug.cappedByBalance, true);
    assert.equal(result.diagnostics.strategyDebug.notional < result.diagnostics.strategyDebug.minNotional, true);
  } finally {
    config.strategy.maxPositionPercentage = oldMaxPositionPercentage;
  }
});

test('high-priced symbol with coarse step size reports min tradable notional instead of zero', () => {
  const oldMaxPositionPercentage = config.strategy.maxPositionPercentage;
  config.strategy.maxPositionPercentage = 3.0;

  try {
    const { calculateRiskReward } = loadStrategyWithMock();
    const result = calculateRiskReward('SHORT', 289.33, {
      wick: { support: 249.0, resistance: 304.0 },
      body: { support: 249.0, resistance: 304.0 },
      trend: {},
    }, {
      symbol: 'TAOUSDT',
      atr: 5,
      accountBalance: 5.15,
      minNotional: 5,
      stepSize: 0.1,
    });

    assert.equal(result.failureType, 'NOTIONAL_BELOW_MIN_AFTER_CAP');
    assert.match(result.failureReason, /Min tradable unit exceeds max position cap/);
    assert.equal(result.debug.calculatedNotional > 0, true);
    assert.equal(result.debug.calculatedNotional.toFixed(2), '28.93');
    assert.equal(Number.isFinite(result.rr), true);
  } finally {
    config.strategy.maxPositionPercentage = oldMaxPositionPercentage;
  }
});

test('low score still gets hard rejected', () => {
  const { evaluateSignal } = loadStrategyWithMock();
  const result = evaluateSignal('LOWSCOREUSDT', {
    D1: makeCandles(),
    H4: makeCandles(),
    H1: makeCandles(),
    M15: makeCandles(),
  }, {
    accountBalance: 1000,
    minNotional: 5,
    stepSize: 0.001,
    minFinalScore: 999,
    includeRejectionReason: true,
  });

  assert.equal(result.signal, null);
  assert.equal(result.reasonKey, 'score_low');
  assert.equal(result.diagnostics.strategyDebug.decision, 'REJECT');
});

test('fatal candle data errors still get hard rejected', () => {
  const { evaluateSignal } = loadStrategyWithMock();
  const result = evaluateSignal('BADDATAUSDT', {
    D1: [],
    H4: makeCandles(),
    H1: makeCandles(),
  }, {
    includeRejectionReason: true,
  });

  assert.equal(result.signal, null);
  assert.equal(result.reasonKey, 'invalid_data');
  assert.equal(result.diagnostics.strategyDebug.decision, 'REJECT');
  assert.deepEqual(result.diagnostics.strategyDebug.failedChecks, ['INVALID_CANDLE_DATA']);
});
