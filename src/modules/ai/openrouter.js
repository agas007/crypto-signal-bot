const axios = require('axios');
const config = require('../../config');
const logger = require('../../utils/logger');
const tracker = require('../tracker');

const client = axios.create({
  baseURL: config.openRouter.baseUrl,
  timeout: 60_000,
  headers: {
    Authorization: `Bearer ${config.openRouter.apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://github.com/crypto-signal-bot',
    'X-Title': 'CryptoSignalBot v4.4',
  },
});

function buildSystemPrompt(options = {}) {
  const lessons = tracker.getRecentLessons();
  const lessonContext = lessons.length > 0 
    ? `\nLEARNED LESSONS FROM RECENT FAILURES (Do not repeat ini):\n${lessons.map(l => `- ${l.symbol} (${l.bias}): ${l.analysis}`).join('\n')}`
    : "";

  const performanceBrackets = tracker.getScorePerformanceBrackets();
  const performanceContext = `
CURRENT SYSTEM PERFORMANCE (Reality Check):
- Score 60-70: ${performanceBrackets.bracket60_70.winRate}% win rate across ${performanceBrackets.bracket60_70.count} trades
- Score 70-80: ${performanceBrackets.bracket70_80.winRate}% win rate across ${performanceBrackets.bracket70_80.count} trades
- Score 80+: ${performanceBrackets.bracket80_plus.winRate}% win rate across ${performanceBrackets.bracket80_plus.count} trades

Adjust your confidence threshold based on this data. If a bracket has low win rate, be EXTREMELY critical or REJECT.
  `;

  const marketContext = options.btcTrend 
    ? `\nCURRENT MARKET REGIME: BTC D1 is ${options.btcTrend.toUpperCase()}. Adjust conviction accordingly.\n`
    : "";

  let rrRule = `- R:R of ${config.strategy.minRrRatio}:1 or higher is acceptable`;
  if (options.btcTrend) {
    const trend = options.btcTrend.toLowerCase();
    if (trend === 'ranging') {
      rrRule = `- R:R > 2.5 is MANDATORY (Market is ranging, demand higher quality setups)`;
    } else {
      rrRule = `- R:R > 1.5 is acceptable to catch strong momentum (Market is trending: ${trend.toUpperCase()})`;
    }
  }

  return `You are a professional crypto trading signal VALIDATOR. Your job is to REJECT weak setups, not rubber-stamp them.

Your goal is to protect capital by filtering out low-conviction entries. Only approve setups with genuine, multi-factor confluence.
${lessonContext}

RULES:
- Evaluate the overall confluence of the setup holistically
- Only approve if confluence is GENUINE — all key factors align, not just a few
- When evidence is mixed or ambiguous, default to WATCHLIST, not approval
- Return NO TRADE if: trend conflict, price in middle zone with no clear level, retest not confirmed, or R:R borderline
${rrRule}
- If data timestamp is > 120 seconds (2 minutes) old, REJECT and request fresh data
- Retest Status: CONFIRMED means valid entry, PENDING means do NOT approve — set WATCHLIST

${performanceContext}
${marketContext}
QUALITY ASSESSMENT:
- HIGH: All factors align — trend, structure, S/R proximity, stoch, retest confirmed (APPROVE)
- MEDIUM: Most factors align, minor conflict acceptable (APPROVE)
- WATCHLIST: Setup developing but missing 1-2 key confirmations (WATCHLIST)
- LOW: Conflicting factors, weak structure, no clear level, or dangerous volatility (REJECT)

CONFIDENCE THRESHOLDS:
- 75-100: APPROVE (HIGH quality - execute trade)
- 65-74: APPROVE (MEDIUM quality - execute trade)
- 40-64: WATCHLIST (Do not execute, monitor for next cycle)
- Below 40: REJECT (Dangerous, ignore)

No 'trade with caution' allowed. Choose explicitly between APPROVE (Score 65+), WATCHLIST (Score 40-64), or REJECT (Below 40).

You MUST respond with ONLY valid JSON (no markdown, no explanation, no fences).`;
}

/**
 * Build the user prompt with all analysis data.
 *
 * @param {{ symbol, bias, score, reasons, analysis, riskReward }} signal
 * @returns {string}
 */
function buildPrompt(signal) {
  const { symbol, bias, score, reasons, analysis, riskReward } = signal;
  const { d1Trend, h4SR, h4Stoch, h4Trend, h1Trend, h1Structure, h1Stoch, pricePosition } = analysis;

  const pairHistory = tracker.history.filter(t => t.symbol === symbol && t.status === 'COMPLETED');
  const wins = pairHistory.filter(t => t.close_reason === 'TP_HIT').length;
  const losses = pairHistory.filter(t => t.close_reason === 'SL_HIT').length;
  const memoryContext = pairHistory.length > 0
    ? `\n🧠 PAIR MEMORY: System has traded ${symbol} before (${wins} Wins, ${losses} Losses). Use this to adjust confidence (e.g. lower confidence if historically bad).`
    : "";

  return `VALIDATE this pre-screened trade candidate. Assess the setup quality holistically.
  ${memoryContext}

Symbol: ${symbol}

D1:
- Trend: ${d1Trend.direction}
- Strength: ${d1Trend.strengthLabel} (spread: ${d1Trend.spreadPercent.toFixed(2)}%)
- HH count: ${d1Trend.hhCount}/9, LL count: ${d1Trend.llCount}/9

H4:
- Trend: ${h4Trend.direction} (${h4Trend.strengthLabel})
- Support (Wick): ${h4SR.wick && h4SR.wick.support ? h4SR.wick.support.toFixed(4) : 'N/A'}
- Support Touches: ${h4SR.wick?.supportTouches || 0} (${h4SR.wick?.supportStrength || 'none'})
- Resistance (Wick): ${h4SR.wick && h4SR.wick.resistance !== Infinity ? h4SR.wick.resistance.toFixed(4) : 'N/A'}
- Resistance Touches: ${h4SR.wick?.resistanceTouches || 0} (${h4SR.wick?.resistanceStrength || 'none'})
- Current Price: ${(h4SR.currentPrice || 0).toFixed(4)}
- Price Position: ${pricePosition}
- Stochastic: K=${h4Stoch.k.toFixed(1)}, D=${h4Stoch.d.toFixed(1)} (${h4Stoch.signal})

H1:
- Structure: ${h1Structure?.structure ?? 'N/A'}
- Break of Structure: ${h1Structure?.bos ?? false} ${h1Structure?.bosType ? `(${h1Structure.bosType})` : ''}
- Pending BoS: ${h1Structure?.pendingBosType ? h1Structure.pendingBosType : 'none'}
- BOS confirmation candles: ${config.strategy.bosConfirmationCandles || 2}
- Repeated level touches: ${config.strategy.repeatedLevelTouches || 3}
- Standby minimum R:R: ${config.strategy.standbyMinRr || 2.0}
- Trend: ${h1Trend.direction} (${h1Trend.strengthLabel})
- Stochastic: K=${h1Stoch.k.toFixed(1)}, D=${h1Stoch.d.toFixed(1)} (${h1Stoch.signal})

TECHNICAL REASONS:
${reasons.map((r, i) => `${i + 1}. ${r}`).join('\n')}

INSTRUCTIONS:
1. Evaluate whether the overall confluence supports the ${bias} bias.
2. DO NOT calculate exact prices. Evaluate the setup rationally. If the volatility or market context is dangerous, REJECT the trade (NO TRADE).
3. VERIFIKASI RETEST: Cek apakah sudah terjadi retest pada breakout level?
   - Jika BELUM (kenaikan vertikal/ngawang), set trading_type menjadi 'MOMENTUM SCALP' atau kembalikan sebagai 'WATCHLIST'.
   - Jika SUDAH ada retest jelas, set trading_type ke 'SWING' atau 'DAY TRADING'.
   - Jika price dekat resistance/support yang sudah berkali-kali disentuh, prioritaskan skenario rejection/bounce sebelum memilih breakout.
   - Breakout M15 belum boleh dianggap BoS kalau baru 1 candle break. Tunggu candle itu closed dan ada follow-through beberapa candle M15 setelahnya.
4. Confidence scale: 0-100. (60+ is tradeable, 40-59 is Watchlist).
5. IMPORTANT: Your "reason" MUST be written in INDONESIAN (Bahasa Indonesia). Provide explicit reasoning for your decision.

Respond with ONLY this JSON format:
{
  "symbol": "${symbol}",
  "bias": "LONG" | "SHORT" | "WATCHLIST" | "NO TRADE",
  "confidence": 0-100,
  "quality": "LOW" | "MEDIUM" | "WATCHLIST" | "HIGH",
  "trading_type": "SCALPING" | "DAY TRADING" | "SWING" | "MOMENTUM SCALP" | "MONITORING",
  "risk_warning": "Catatan bahaya atau anomali market microstructure (ex: volume tipis, divergensi M15).",
  "reason": "Penjelasan terperinci dalam Bahasa Indonesia. Wajib sebutkan status retest dan validasi confluence."
}`;
}

/**
 * Send a candidate signal to OpenRouter AI for validation.
 *
 * @param {{ symbol, bias, score, reasons, analysis, riskReward }} signal
 * @returns {Promise<{
 *   symbol: string, bias: string, confidence: number, quality: string,
 *   entry: number|null, stop_loss: number|null, take_profit: number|null, reason: string
 * } | null>}
 */
async function refineSignal(signal, options = {}) {
  const systemPrompt = buildSystemPrompt(options);
  const prompt = buildPrompt(signal);

  try {
    const { data } = await client.post('/chat/completions', {
      model: config.openRouter.model,
      messages: [
        { 
          role: 'system', 
          content: [
            {
              type: 'text',
              text: systemPrompt,
              cache_control: { type: 'ephemeral' }
            }
          ] 
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 500,
      response_format: { type: 'json_object' },
    });

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      logger.warn(`AI returned empty response for ${signal.symbol}. Status: ${data.choices?.[0]?.finish_reason}. Full data: ${JSON.stringify(data)}`);
      return null;
    }

    const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);

    const requiredFields = ['symbol', 'bias', 'confidence', 'reason'];
    for (const field of requiredFields) {
      if (parsed[field] === undefined) {
        logger.warn(`AI response missing field "${field}" for ${signal.symbol}`);
        return null;
      }
    }

    let confidence = parseFloat(parsed.confidence);
    if (confidence <= 1.0 && confidence > 0) {
      confidence = confidence * 100;
    }
    parsed.confidence = confidence;

    if (parsed.bias === 'NO TRADE' || parsed.bias === 'NO_TRADE') {
      logger.info(`${signal.symbol} ✘ AI says NO TRADE: ${parsed.reason}`);
      return parsed;
    }

    if (parsed.bias === 'WATCHLIST') {
      logger.info(`${signal.symbol} 👀 AI placed on WATCHLIST: ${parsed.reason}`);
      return parsed; 
    }

    // Prices are now taken directly from the deterministic logic
    parsed.entry = signal.entry || (signal.riskReward ? signal.riskReward.entry : null);
    parsed.stop_loss = signal.riskReward ? signal.riskReward.sl : null;
    parsed.take_profit = signal.riskReward ? signal.riskReward.tp : null;
    
    if (!parsed.trading_type) parsed.trading_type = 'DAY TRADING';

    const rrRatio = signal.riskReward ? signal.riskReward.rr : 0;

    logger.info(`${signal.symbol} OK AI validated: ${parsed.bias} @ ${parsed.entry} (conf: ${parsed.confidence}, quality: ${parsed.quality || 'N/A'}, R:R: ${rrRatio.toFixed(2)})`);
    return parsed;
  } catch (err) {
    if (err.response) {
      logger.error(`AI API error for ${signal.symbol}: ${err.response.status} - ${JSON.stringify(err.response.data)}`);
    } else {
      logger.error(`AI request failed for ${signal.symbol}:`, err.message);
    }
    return null;
  }
}

/**
 * AI-driven post-mortem to analyze why a signal hit SL or TP.
 * 
 * @param {Object} trade - The signal data
 * @param {number} finalPrice - Price when target was hit
 * @param {'TP' | 'SL'} hitType - Which target was hit
 * @param {string} historySummary - Optional H1 candle summary from entry to exit
 * @returns {Promise<string>} Educational analysis
 */
async function analyzePostMortem(trade, finalPrice, hitType = 'SL', historySummary = 'N/A') {
  const status = hitType === 'TP' ? 'SUCCESS (TAKE PROFIT HIT)' : 'FAILED (STOP LOSS HIT)';
  const emoji = hitType === 'TP' ? '[SUCCESS]' : '[FAILURE]';

  const prompt = `
${emoji} TRADE PERFORMANCE REVIEW: ${status}
Symbol: ${trade.symbol}
Bias: ${trade.bias}
Entry: ${trade.entry}
SL: ${trade.stop_loss}
TP: ${trade.take_profit}
Exit Price: ${finalPrice}

[INITIAL REASON FOR ENTRY]:
${trade.reason}

[ACTUAL PRICE ACTION (H1 Summary from Entry to Exit)]:
${historySummary}

TASK:
- Tulis analisa trade berikut secara singkat, maksimal 500 karakter.
- Wajib mencakup struktur market (trend), valid/tidaknya bias, kesalahan entry, dan konfirmasi yang seharusnya ditunggu.
- Jika TP hit, jelaskan kenapa TP valid. Jika SL hit, jelaskan kenapa SL kena.
- Gunakan kalimat padat, langsung ke inti, tanpa penjelasan panjang atau umum.
- Bahasa Indonesia, satu paragraf, tanpa bullet, tanpa markdown.

Respond with ONLY this JSON format:
{
  "analysis": "Penjelasan singkat dalam Bahasa Indonesia (tanpa markdown/bullet)"
}
  `;

  try {
    const { data } = await client.post('/chat/completions', {
      model: config.openRouter.model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' }
    });

    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    const normalizedAnalysis = normalizeLessonText(parsed.analysis || "Analisa gagal: AI tidak memberikan respon.");
    return normalizedAnalysis;
  } catch (err) {
    logger.error('Post-mortem analysis failed:', err.message);
    return normalizeLessonText("Analisa gagal: Koneksi AI terputus. Tetap semangat!");
  }
}

function normalizeLessonText(text, maxLength = 500) {
  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return normalized.slice(0, maxLength).trim();
}

/**
 * Analyze a real world trade from Binance that resulted in a loss.
 * Provides feedback on what went wrong based on price action.
 */
async function analyzeRealTrade(symbol, entry, exit, side, pnl, candles) {
  try {
    const candleSummary = candles.slice(-10).map(c => 
      `Time: ${new Date(c.openTime).toISOString()}, H: ${c.high}, L: ${c.low}, C: ${c.close}`
    ).join('\n');

    const prompt = `
You are a top-tier Trading Coach. A trader just took a ${side} trade on ${symbol} and lost $${Math.abs(pnl).toFixed(2)}.

TRADE DATA:
- Symbol: ${symbol}
- Side: ${side}
- Entry Price: ${entry}
- Exit Price: ${exit}
- Result: LOSS

RECENT MARKET CONTEXT (Last 10 candles before/during trade):
${candleSummary}

TASK:
1. Be brutally honest. Why did this trade fail? 
2. Was it a bad entry? Did the price hit a resistance/support? 
3. Provide 1-2 sentences of "Lesson Learned" in INDONESIAN (Bahasa Indonesia).

Respond with ONLY this JSON:
{
  "analysis": "Penjelasan singkat dalam Bahasa Indonesia",
  "mistake_type": "FOMO / Bad Entry / No Trend / Catching Falling Knife / etc"
}
`;

    const response = await client.post('/chat/completions', {
      model: config.openRouter.model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' }
    });

    const content = JSON.parse(response.data.choices[0].message.content);
    return content;
  } catch (err) {
    logger.error('Failed to analyze real trade:', err.message);
    return null;
  }
}

/**
 * AI Performance Coach: Reviews the whole ledger and provides strategic feedback.
 */
async function analyzePerformanceSummary(stats, tradeLog) {
  try {
    const normalizedTradeLog = (tradeLog || []).map(trade => {
      const hasPlannedLevels = trade?.sl != null && trade?.tp != null && trade?.rr != null;
      return {
        ...trade,
        executionType: hasPlannedLevels ? 'planned' : 'manual',
        hasPlannedLevels,
        entryTimeReadable: trade?.entryTime ? new Date(trade.entryTime).toISOString() : null,
        exitTimeReadable: trade?.exitTime ? new Date(trade.exitTime).toISOString() : null
      };
    });
    
    const prompt = `
Kamu adalah Performance Analyst untuk sistem trading otomatis.
Analisis data trade dengan framework:

ATURAN PENTING:
- Kalau sl, tp, atau rr null, anggap trade itu manual.
- Jangan sebut trade manual sebagai bug atau missing data kecuali ada bukti eksplisit.
- Kalau mayoritas loss datang dari trade manual, fokuskan hypothesis, experiment, dan action items ke eksekusi manual, disiplin exit, sizing, atau filter pair.
- Jangan kasih action item audit pengiriman SL/TP kalau ledger memang menunjukkan trade manual.
- Kalau entryTime tersedia di ledger, gunakan itu dan jangan bilang entryTime null.
- One Experiment wajib satu kalimat pendek, sangat spesifik, dan langsung bisa diuji pada 10 trade berikutnya.
- Action Items maksimal 2 item dan harus relevan langsung dengan pola dominan di ledger. Hindari saran generik.

## 1. STATISTICAL REALITY CHECK
- Win rate vs Required win rate (berdasarkan data R:R yang disediakan di ledger) 
- Analisis R:R: Apakah target R:R tercapai atau trade sering exit sebelum TP (slippage/emotion)?
- Consecutive loss pattern (clustering?)
- Time-to-SL distribution (immediate = execution/sl issue, delayed = direction issue)

## 2. PAIR/DIRECTION BIAS AUDIT
- List top 3 pairs by loss count
- Cek: Apakah loss clustered di direction tertentu (LONG/SHORT)?
- Cek: Apakah loss clustered di market condition tertentu (trending up/down/ranging)?

## 3. SYSTEM HEALTH CHECK
- Compare: Signal generated vs Signal executed (cek ledger fields: entry, sl, tp, rr)
- Compare: Planned R:R vs Actual R:R (slippage?)
- Filter effectiveness: AI score 60-70 vs 70+ win rate difference

## 4. ONE SPECIFIC HYPOTHESIS
Berdasarkan data, apa satu hal yang paling mungkin salah?
Contoh: "ATR calculation menggunakan 14-period di timeframe yang salah sehingga SL terlalu tight"

## 5. ONE EXPERIMENT
Apa satu perubahan yang bisa di-test dalam 10 trade berikutnya?
Contoh: "Naikkan technical threshold dari 70 ke 80, track win rate change"

TONE: Direct, data-driven, no motivational fluff. 
Bahasa Indonesia casual tapi presisi.

[BAD OUTPUT EXAMPLE]:
"Anda menunjukkan konsistensi dalam trading. Meski win rate rendah, ada peluang untuk meningkatkan dengan manajemen risiko..."

[GOOD OUTPUT EXAMPLE]:
"Math: 25% win rate butuh R:R 3:1 minimum. Lu punya 3.3:1, tapi fees eat it. Real problem: 80% trade di shitcoins volatilitas tinggi -> SL hunt.
Hypothesis: Meme coin filter terlalu lemah.
Experiment: Next 10 trade, blacklist < $100M market cap.
Action: Update scanner filter sekarang."

RESPOND WITH ONLY THIS JSON FORMAT:
{
  "math_check": "Analisis win rate vs R:R (HANYA DALAM BAHASA INDONESIA, Polos tanpa format karakter)",
  "pattern_detected": "Pola kesalahan (HANYA DALAM BAHASA INDONESIA)",
  "hypothesis": "Akar masalah yang mungkin (HANYA DALAM BAHASA INDONESIA)",
  "one_experiment": "Eksperimen spesifik selanjutnya (HANYA DALAM BAHASA INDONESIA, TANPA ASTERISK/ITALIC)",
  "action_items": ["Langkah 1 (Bahasa Indonesia)", "Langkah 2 (Bahasa Indonesia)"]
}
CRITICAL: ALL JSON VALUES MUST BE IN INDONESIAN (BAHASA INDONESIA) AND PLAIN TEXT WITHOUT ANY BOLD, ITALIC, OR CHARACTER-LEVEL FORMATTING.

OVERALL STATS:
- Total PnL: $${stats.totalPnl}
- Win Rate: ${stats.winRate}
- Total Trades: ${stats.tradesCount}

RECENT TRADES LEDGER (JSON Data for analysis):
${JSON.stringify(normalizedTradeLog, null, 2)}
`;

    const response = await axios.post(config.openRouter.baseUrl + '/chat/completions', {
      model: config.openRouter.model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' }
    }, {
      headers: {
        'Authorization': `Bearer ${config.openRouter.apiKey}`,
        'HTTP-Referer': 'https://github.com/crypto-signal-bot',
      }
    });

    const parsed = JSON.parse(response.data.choices[0].message.content);
    
    // Log the experiment for visibility (but don't auto-save as lesson — it pollutes post-mortem context)
    if (parsed.one_experiment) {
      logger.info(`[Experiment] AI Coach suggests: ${parsed.one_experiment}`);
    }

    // Format to Markdown manually for Telegram
    const actionItems = Array.isArray(parsed.action_items)
      ? parsed.action_items.filter(Boolean).slice(0, 2)
      : [];

    const report = `
🔢 *Math Check:*
${parsed.math_check}

🕵️ *Pattern Detected:*
${parsed.pattern_detected}

💡 *Hypothesis:*
${parsed.hypothesis}

🧪 *One Experiment:*
${parsed.one_experiment}

✅ *Action Items:*
${actionItems.map(item => `• ${item}`).join('\n')}
    `.trim();

    return report;
  } catch (err) {
    logger.error('Failed to generate performance coaching:', err.message);
    return "Gagal mendapatkan input dari AI Coach saat ini.";
  }
}

module.exports = { 
  refineSignal, 
  analyzePostMortem, 
  analyzeRealTrade, 
  analyzePerformanceSummary,
  buildPrompt, 
  buildSystemPrompt 
};
