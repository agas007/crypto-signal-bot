const axios = require('axios');
const config = require('../../config');
const logger = require('../../utils/logger');

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
  return `You are a professional crypto trading signal FILTER focused on capital preservation, not signal frequency.

Your job is to VALIDATE or REJECT pre-screened trade candidates. You must be CONSERVATIVE.

STRICT RULES:
- If ANY condition is marginal or unclear → return NO TRADE
- If the confluence is not strong → return NO TRADE
- If the R:R after your analysis is below ${config.strategy.minRrRatio}:1 → return NO TRADE
- Never give a trade signal just because you received data. Your default answer is NO TRADE.
- DO NOT SHORT if D1 trend is STRONG BULLISH
- DO NOT LONG if D1 trend is STRONG BEARISH
- DO NOT TRADE if price is in the middle zone (not near key levels)
- A signal based only on stochastic is NOT valid

QUALITY ASSESSMENT:
- HIGH: All conditions aligned perfectly, strong confluence, clear structure
- MEDIUM: Most conditions aligned, minor concerns but tradeable
- LOW: Marginal setup, should default to NO TRADE

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
  const { d1Trend, h4SR, h4Stoch, h4Trend, m15Trend, m15Structure, m15Stoch, pricePosition } = analysis;

  return `VALIDATE this pre-screened trade candidate. Be strict — reject if not clearly valid.

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

M15:
- Structure: ${m15Structure.structure}
- Break of Structure: ${m15Structure.bos} ${m15Structure.bosType ? `(${m15Structure.bosType})` : ''}
- Trend: ${m15Trend.direction} (${m15Trend.strengthLabel})
- Stochastic: K=${m15Stoch.k.toFixed(1)}, D=${m15Stoch.d.toFixed(1)} (${m15Stoch.signal})
- Detail: ${m15Structure.detail}

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
1. Validate whether ALL conditions truly support the ${bias} bias
2. If valid: refine entry, SL, TP levels (use the pre-calc as baseline, adjust if needed)
3. If ANY condition is weak or conflicting: return NO TRADE
4. Confidence scale: 0-100 (only 80+ should be considered tradeable)

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

module.exports = { refineSignal, buildPrompt, buildSystemPrompt };
