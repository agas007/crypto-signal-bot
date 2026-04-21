function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstDefined(target, keys) {
  for (const key of keys) {
    if (target[key] !== undefined && target[key] !== null) return target[key];
  }
  return null;
}

function buildPositionKey(trade) {
  const symbol = (trade.symbol || 'UNKNOWN').toUpperCase();
  const bias = trade.bias || 'N/A';
  const market = trade.market || trade.marketType || trade.type || 'N/A';

  const entryValue = firstDefined(trade, ['entryPrice', 'entry', 'avgEntry', 'openPrice']);
  const entryTimeValue = firstDefined(trade, ['entryTime', 'entryAt', 'signalAt', 'closedAt', 'exitTime', 'timestamp']);

  const entryKey = entryValue !== null ? toNumber(entryValue).toFixed(6) : 'na';
  const timeKey = entryTimeValue !== null ? Math.floor(toNumber(entryTimeValue) / 1000) : 'na';

  return [market, symbol, bias, entryKey, timeKey].join('|');
}

function aggregatePositionHistory(rows = []) {
  const buckets = new Map();

  for (const row of rows) {
    const key = buildPositionKey(row);
    const pnlValue = toNumber(firstDefined(row, ['pnl', 'realizedPnl']), 0);
    const fillCount = Math.max(1, toNumber(row.fills, 1));

    if (!buckets.has(key)) {
      buckets.set(key, {
        ...row,
        pnl: row.pnl !== undefined ? String(row.pnl) : (row.realizedPnl !== undefined ? String(row.realizedPnl) : row.pnl),
        fills: fillCount,
      });
      continue;
    }

    const current = buckets.get(key);
    current.fills += fillCount;

    if (row.pnl !== undefined || row.realizedPnl !== undefined) {
      const currentPnl = toNumber(firstDefined(current, ['pnl', 'realizedPnl']), 0);
      current.pnl = (currentPnl + pnlValue).toFixed(2);
    }

    if ((row.exitTime || row.closedAt || 0) > (current.exitTime || current.closedAt || 0)) {
      current.exitTime = row.exitTime ?? current.exitTime;
      current.exit_price = row.exit_price ?? current.exit_price;
      current.exitPrice = row.exitPrice ?? current.exitPrice;
      current.closedAt = row.closedAt ?? current.closedAt;
      current.close_reason = row.close_reason ?? current.close_reason;
    }

    for (const keyName of ['entry', 'entryPrice', 'stop_loss', 'take_profit', 'sl', 'tp', 'rr', 'quality', 'confidence', 'trading_type', 'market']) {
      if (current[keyName] === undefined || current[keyName] === null) {
        if (row[keyName] !== undefined && row[keyName] !== null) current[keyName] = row[keyName];
      }
    }
  }

  return [...buckets.values()].sort((a, b) => {
    const aTime = a.exitTime || a.closedAt || a.entryTime || a.entryAt || a.signalAt || 0;
    const bTime = b.exitTime || b.closedAt || b.entryTime || b.entryAt || b.signalAt || 0;
    return bTime - aTime;
  });
}

module.exports = { aggregatePositionHistory };
