/**
 * Simple Retest Detection:
 * 1. Check if price broke a level (S/R)
 * 2. Check if price touched back that level without breaking it significantly
 */
function detectRetest(candles, breakoutLevel, bias) {
    if (!breakoutLevel || !candles || candles.length < 5) return 'NONE';

    const recent = candles.slice(-5);
    let touchCount = 0;
    const threshold = breakoutLevel * 0.005; // 0.5% margin

    for (const c of recent) {
        if (bias === 'LONG') {
            // Price should stay ABOVE breakoutLevel (now support)
            // But touch/near it
            if (c.low >= breakoutLevel - threshold && c.low <= breakoutLevel + threshold) {
                touchCount++;
            }
        } else {
            // Price should stay BELOW breakoutLevel (now resistance)
            if (c.high >= breakoutLevel - threshold && c.high <= breakoutLevel + threshold) {
                touchCount++;
            }
        }
    }

    return touchCount > 0 ? 'CONFIRMED' : 'PENDING';
}

module.exports = { detectRetest };
