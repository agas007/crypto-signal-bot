/**
 * Retest Detection with bounce confirmation:
 * 1. Price broke a level (S/R)
 * 2. A wick touched back the level within 0.3% margin
 * 3. Candle CLOSED on the correct side (bounce/rejection confirmed)
 * 4. Current price is still on the correct side of the level
 */
function detectRetest(candles, breakoutLevel, bias) {
    if (!breakoutLevel || !candles || candles.length < 5) return 'NONE';

    const recent = candles.slice(-8); // wider look-back window
    let touchCount = 0;
    const threshold = breakoutLevel * 0.003; // tightened: 0.3% margin (was 0.5%)
    const lastCandle = candles[candles.length - 1];

    for (const c of recent) {
        if (bias === 'LONG') {
            // Wick touched support zone AND candle closed above it (bounce confirmed)
            if (
                c.low >= breakoutLevel - threshold &&
                c.low <= breakoutLevel + threshold &&
                c.close > breakoutLevel
            ) {
                touchCount++;
            }
        } else {
            // Wick touched resistance zone AND candle closed below it (rejection confirmed)
            if (
                c.high >= breakoutLevel - threshold &&
                c.high <= breakoutLevel + threshold &&
                c.close < breakoutLevel
            ) {
                touchCount++;
            }
        }
    }

    if (touchCount === 0) return 'PENDING';

    // Current price must still be on the correct side
    if (bias === 'LONG' && lastCandle.close > breakoutLevel) return 'CONFIRMED';
    if (bias === 'SHORT' && lastCandle.close < breakoutLevel) return 'CONFIRMED';

    return 'PENDING';
}

module.exports = { detectRetest };
