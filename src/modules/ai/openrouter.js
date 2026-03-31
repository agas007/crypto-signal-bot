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
    'X-Title': 'CryptoSignalBot',
  },
});

/**
 * Build the system prompt — establishes the AI as a FILTER, not a formatter.
 */
function buildSystemPrompt() {
  const lessons = tracker.getRecentLessons();
  const lessonContext = lessons.length > 0 
    ? `\nLEARNED LESSONS FROM RECENT FAILURES (Do not repeat these mistakes):\n${lessons.map(l => `- ${l.symbol} (${l.bias}): ${l.analysis}`).join('\n')}`
    : "";

  return `You are a professional crypto trading signal VALIDATOR. Your goal is to assess trade quality and provide actionable signals.

Your job is to VALIDATE pre-screened trade candidates. Be analytical but not overly conservative.
${lessonContext}

RULES:
- Evaluate the overall confluence of the setup holistically
- If the majority of conditions align, APPROVE the trade with appropriate confidence
- Only return NO TRADE if the setup is genuinely conflicting or dangerous
- Consider that waiting for a "perfect" setup often means missing real opportunities
- A setup with 3+ confluent factors is tradeable even if not perfect
- R:R of ${config.strategy.minRrRatio}:1 or higher is acceptable
- DO NOT SHORT if D1 trend is STRONG BULLISH
- DO NOT LONG if D1 trend is STRONG BEARISH

QUALITY ASSESSMENT:
- HIGH: Strong confluence, clear structure, high confidence
- MEDIUM: Good setup with minor imperfections — still tradeable
- LOW: Weak setup but has some merit — trade with caution

CONFIDENCE SCALE:
- 80-100: Strong setup, high conviction
- 60-79: Decent setup, moderate conviction
- 40-59: Marginal setup, low conviction
- Below 40: Not worth trading

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

  return `VALIDATE this pre-screened trade candidate. Assess the setup quality holistically.

Symbol: ${symbol}

D1:
- Trend: ${d1Trend.direction}
- Strength: ${d1Trend.strengthLabel} (spread: ${d1Trend.spreadPercent.toFixed(2)}%)
- HH count: ${d1Trend.hhCount}/9, LL count: ${d1Trend.llCount}/9

H4:
- Trend: ${h4Trend.direction} (${h4Trend.strengthLabel})
- Support: ${h4SR.nearestSupport.toFixed(4)}
- Resistance: ${h4SR.nearestResistance !== Infinity ? h4SR.nearestResistance.toFixed(4) : 'N/A'}
- Current Price: ${h4SR.currentPrice.toFixed(4)}
- Price Position: ${pricePosition} (S: ${h4SR.distToSupport.toFixed(2)}%, R: ${h4SR.distToResistance !== Infinity ? h4SR.distToResistance.toFixed(2) : 'N/A'}%)
- Stochastic: K=${h4Stoch.k.toFixed(1)}, D=${h4Stoch.d.toFixed(1)} (${h4Stoch.signal})

H1:
- Structure: ${h1Structure?.structure ?? 'N/A'}
- Break of Structure: ${h1Structure?.bos ?? false} ${h1Structure?.bosType ? `(${h1Structure.bosType})` : ''}
- Trend: ${h1Trend.direction} (${h1Trend.strengthLabel})
- Stochastic: K=${h1Stoch.k.toFixed(1)}, D=${h1Stoch.d.toFixed(1)} (${h1Stoch.signal})
- Detail: ${h1Structure?.detail ?? 'N/A'}

PRE-SCREENED:
- Bias: ${bias}
- Score: ${score}/100
- Pre-calc Entry: ${riskReward.entry.toFixed(4)}
- Pre-calc SL: ${riskReward.sl.toFixed(4)}
- Pre-calc TP: ${riskReward.tp.toFixed(4)}
- Pre-calc R:R: ${riskReward.rr.toFixed(2)}

TECHNICAL REASONS:
${reasons.map((r, i) => `${i + 1}. ${r}`).join('\n')}

INSTRUCTIONS:
1. Evaluate whether the overall confluence supports the ${bias} bias
2. If valid: refine entry, SL, TP levels (use the pre-calc as baseline, adjust if needed)
3. Only reject if conditions clearly conflict or are dangerous
4. Confidence scale: 0-100 (60+ is tradeable, 80+ is strong)

Respond with ONLY this JSON format:
{
  "symbol": "${symbol}",
  "bias": "LONG" | "SHORT" | "NO TRADE",
  "confidence": 0-100,
  "quality": "LOW" | "MEDIUM" | "HIGH",
  "entry": price_number_or_null,
  "stop_loss": price_number_or_null,
  "take_profit": price_number_or_null,
  "reason": "clear explanation of why this is or isn't a valid trade"
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
async function refineSignal(signal) {
  const systemPrompt = buildSystemPrompt();
  const prompt = buildPrompt(signal);

  try {
    const { data } = await client.post('/chat/completions', {
      model: config.openRouter.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1, // Lower temp = more conservative, more consistent
      max_tokens: 500,
      response_format: { type: 'json_object' },
    });

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      logger.warn(`AI returned empty response for ${signal.symbol}. Status: ${data.choices?.[0]?.finish_reason}. Full data: ${JSON.stringify(data)}`);
      return null;
    }

    // Parse JSON (strip markdown fences if model includes them)
    const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);

    // Validate required fields
    const requiredFields = ['symbol', 'bias', 'confidence', 'reason'];
    for (const field of requiredFields) {
      if (parsed[field] === undefined) {
        logger.warn(`AI response missing field "${field}" for ${signal.symbol}`);
        return null;
      }
    }

    // Normalize confidence to 0-100 scale
    let confidence = parseFloat(parsed.confidence);
    if (confidence <= 1.0 && confidence > 0) {
      confidence = confidence * 100; // Convert 0.0-1.0 to 0-100
    }
    parsed.confidence = confidence;

    // Handle NO TRADE response
    if (parsed.bias === 'NO TRADE' || parsed.bias === 'NO_TRADE') {
      logger.info(`${signal.symbol} ✘ AI says NO TRADE: ${parsed.reason}`);
      return parsed;
    }

    // Validate price fields for actual trades
    if (parsed.entry === undefined || parsed.stop_loss === undefined || parsed.take_profit === undefined) {
      logger.warn(`AI response missing price fields for ${signal.symbol}`);
      return null;
    }

    parsed.entry = parseFloat(parsed.entry);
    parsed.stop_loss = parseFloat(parsed.stop_loss);
    parsed.take_profit = parseFloat(parsed.take_profit);

    // Post-AI R:R validation
    const risk = parsed.bias === 'LONG'
      ? parsed.entry - parsed.stop_loss
      : parsed.stop_loss - parsed.entry;
    const reward = parsed.bias === 'LONG'
      ? parsed.take_profit - parsed.entry
      : parsed.entry - parsed.take_profit;
    const rrRatio = risk > 0 ? reward / risk : 0;

    if (rrRatio < config.strategy.minRrRatio) {
      logger.info(`${signal.symbol} ✘ Post-AI R:R too low: ${rrRatio.toFixed(2)} (need ${config.strategy.minRrRatio}+)`);
      parsed.bias = 'NO TRADE';
      parsed.reason = `R:R ratio ${rrRatio.toFixed(2)} below minimum ${config.strategy.minRrRatio}. Original reason: ${parsed.reason}`;
      return parsed;
    }

    logger.info(`${signal.symbol} ✓ AI validated: ${parsed.bias} @ ${parsed.entry} (conf: ${parsed.confidence}, quality: ${parsed.quality || 'N/A'}, R:R: ${rrRatio.toFixed(2)})`);
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
 * AI-driven post-mortem to analyze why a signal hit SL.
 * 
 * @param {Object} trade - The signal data
 * @param {number} finalPrice - Price when SL was hit
 * @returns {Promise<string>} Educational analysis
 */
async function analyzePostMortem(trade, finalPrice) {
  const prompt = `
🚨 TRADE FAILED (STOP LOSS HIT)
Symbol: ${trade.symbol}
Bias: ${trade.bias}
Entry: ${trade.entry}
SL: ${trade.stop_loss}
TP: ${trade.take_profit}
Exit Price: ${finalPrice}

Technical Reason for signal: ${trade.reason}

TASK: Provide a very brief (2-3 sentences) "post-mortem" analysis in Indonesian. 
Explain logically why this trade might have failed based on price action and give a "lesson learned" to the user.
Keep it simple and educational. Avoid generic advice.
  `;

  try {
    const { data } = await client.post('/chat/completions', {
      model: config.openRouter.model,
      messages: [{ role: 'user', content: prompt }]
    });

    return data.choices?.[0]?.message?.content?.trim() || "Analisa gagal: AI tidak memberikan respon.";
  } catch (err) {
    logger.error('Post-mortem analysis failed:', err.message);
    return "Analisa gagal: Koneksi AI terputus. Tetap semangat!";
  }
}

module.exports = { refineSignal, analyzePostMortem, buildPrompt, buildSystemPrompt };
