# 🤖 Crypto Signal Bot

A modular crypto trading signal bot that scans Binance pairs, applies multi-timeframe technical analysis, refines signals with AI (OpenRouter), and delivers them to Telegram.

## Architecture

```
Binance API → Data Module → Filter → Strategy → AI Refinement → Telegram
                 │              │        │            │
              OHLCV D1       Volume    EMA Cross   OpenRouter
              OHLCV H4       ATR %     Stochastic  JSON Output
              OHLCV M15      Trend     S/R Levels
```

## Project Structure

```
crypto-signal-bot/
├── .env.example            # Environment template
├── package.json
├── README.md
└── src/
    ├── index.js             # Entry point
    ├── config/
    │   └── index.js         # Centralized config + validation
    ├── modules/
    │   ├── data/
    │   │   └── binance.js   # OHLCV, ticker, top pairs
    │   ├── indicators/
    │   │   ├── index.js     # Barrel export
    │   │   ├── trend.js     # EMA crossover + HH/LL
    │   │   ├── stochastic.js# %K / %D oscillator
    │   │   └── supportResistance.js  # Swing H/L with clustering
    │   ├── strategy/
    │   │   └── index.js     # Multi-TF signal scoring
    │   ├── ai/
    │   │   └── openrouter.js# AI refinement with strict JSON
    │   ├── filter/
    │   │   └── index.js     # Volume, ATR, trend pre-filter
    │   ├── scanner/
    │   │   └── index.js     # Orchestrator loop
    │   └── telegram/
    │       └── index.js     # Message formatting + send
    └── utils/
        ├── logger.js        # Leveled logging
        └── sleep.js         # Rate limit helper
```

## Setup

### 1. Install dependencies

```bash
cd crypto-signal-bot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

| Variable | Description |
|---|---|
| `BINANCE_BASE_URL` | Binance API base URL (default: `https://api.binance.com`) |
| `OPENROUTER_API_KEY` | Your OpenRouter API key |
| `OPENROUTER_MODEL` | AI model to use (default: `google/gemini-3-flash-preview`) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | Target chat/group ID |
| `SCAN_INTERVAL_MS` | Scan interval in ms (default: `900000` = 15 min) |
| `TOP_SIGNALS_TO_AI` | Max signals to send to AI per cycle (default: `3`) |
| `MAX_PAIRS` | Max pairs to scan (default: `30`) |
| `LOG_LEVEL` | Logging level: `error`, `warn`, `info`, `debug` |

### 3. Run

```bash
# Production
npm start

# Development (auto-restart on changes)
npm run dev
```

## Signal Flow

1. **Fetch** top 30 USDT pairs from Binance by 24h volume
2. **Filter** out pairs with low volume, low volatility, or no clear trend
3. **Analyze** each passing pair across D1, H4, M15 timeframes:
   - D1: Overall trend direction (EMA crossover)
   - H4: Support/resistance proximity + Stochastic
   - M15: Entry confirmation trend
4. **Score** candidates (0–100) based on how many conditions align
5. **Send top 3** to OpenRouter AI for refined entry/SL/TP
6. **Deliver** high-confidence signals (≥60%) to Telegram

## Strategy Rules

### LONG Setup (score 100 = all 4 conditions met)
| Condition | Timeframe | Weight |
|---|---|---|
| Bullish trend | D1 | 25 |
| Near support | H4 | 25 |
| Stochastic oversold | H4 | 25 |
| Bullish confirmation | M15 | 25 |

### SHORT Setup
| Condition | Timeframe | Weight |
|---|---|---|
| Bearish trend | D1 | 25 |
| Near resistance | H4 | 25 |
| Stochastic overbought | H4 | 25 |
| Bearish confirmation | M15 | 25 |

Minimum score of **75** (3/4 conditions) required to become a candidate.

## Telegram Output

```
🚨 TRADE SIGNAL

🟢 BTCUSDT
━━━━━━━━━━━━━━━━━━━

📊 Bias: LONG
🎯 Confidence: 75% ████████░░

💰 Entry: 67500.00
🛑 Stop Loss: 66800.00
✅ Take Profit: 69600.00
📐 R:R Ratio: 3.00

💬 Reason:
D1 bullish with strong EMA crossover...

⏰ Mon, 30 Mar 2026 14:00:00 GMT
━━━━━━━━━━━━━━━━━━━
⚠️ Not financial advice. DYOR.
```

## Extending

- **Add indicators**: Create a new file in `src/modules/indicators/`, export from `index.js`
- **Add strategy rules**: Modify scoring logic in `src/modules/strategy/index.js`
- **Change AI model**: Update `OPENROUTER_MODEL` in `.env`
- **Add exchanges**: Create new data module following `binance.js` pattern

## License

MIT
