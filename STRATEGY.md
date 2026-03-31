# Trading Strategy Logs

This document tracks the evolution of trading strategies used in the Crypto Signal Bot. Each version represents a significant refinement in how the bot evaluates market conditions.

---

## [v3.0.0] - Visual Charts + Interactive Control
*Released: 2026-03-31*

### Major Features:
- **High-Quality Chart Generation**:
    - Integrated **Puppeteer** to render trading charts using **TradingView Lightweight Charts** (v4.1.1).
    - Features markers for **ENTRY**, **TAKE PROFIT (TP)**, and **STOP LOSS (SL)** directly on the chart image.
    - Automatic image cleanup after delivery to Telegram.
- **Interactive Telegram UI**:
    - Added **Inline Buttons** for rapid access to **TradingView** and **Binance App** (deep link support).
    - Enabled **Polling Mode** for bot commands:
        - `/status`: Real-time health check, uptime, and scan intervals.
        - `/strategy`: Overview of current logical thresholds and timeframes.
        - `/pairs`: Instant fetch of top volume pairs currently under surveillance.
- **Improved Deployment**:
    - Added `nixpacks.toml` for seamless **Railway** deployment (handles Chromium dependencies).
    - Updated **GitHub Actions** cron job with Chrome setup and hourly schedule sync.

---

## [v2.2.0] - Stricter Quality + H1 Timeframe Upgrade
*Released: 2026-03-31*

### What Changed:
- **M15 → H1**: The short-term confluence timeframe is now **H1 (1-hour)** instead of M15 (15-min).
  - Rationale: M15 generated too much noise, producing signals every 15 minutes. H1 gives cleaner structure and fewer false setups.
- **Minimum Score: 40 → 65**: A signal now requires a higher bar. Out of a max of **~98 pts**, a score of 65 means at least **66% of max possible** conditions must align.
- **Minimum Reasons: 2 → 3**: At least **3 technical reasons** must be explicitly logged to confirm real confluence.
- **Scan Interval: 15min → 1 hour**: Bot now evaluates the market once per hour, matching the H1 timeframe rhythm.

### Score Breakdown (per direction, max ~98 pts):
| Condition | Points |
|---|---|
| D1 Trend (strong/moderate/weak bullish) | 25 / 20 / 10 |
| D1 counter-trend penalty | -30 |
| H4 Trend alignment (strong/moderate) | 15 / 10 |
| H4 Near S/R (within 4%) | 20 |
| H4 Moderate S/R proximity (<6%) | 8 |
| H1 Structure (bullish/bearish) | 15 |
| H1 Break of Structure (BoS) | 15 (bonus) |
| H1 Trend alignment | 10 |
| H4 Stoch oversold/overbought | 10 |
| H1 Stoch oversold/overbought | 5 |
| H4 Stoch crossover in extreme zone | 8 |
| **Total possible** | **~98** |

**Threshold: 65 pts = ~66% of max. Min 3 supporting reasons required.**

---

## [v2.1.0] - Reduced Signal Scarcity (Relaxed Strategy)
*Released: 2026-03-31*

### Core Logic: Weighted Scoring System
The main shift in this version is the transition from **Hard Reject** (killing a setup if it doesn't meet a specific criteria) to a **Weighted Scoring System**. A symbol is now judged by the sum of its parts rather than a single indicator.

### Key Refinements:
- **Relaxed Proximity**: Price is now considered "near" support/resistance within a **4.0%** threshold (previously 2.0%).
- **Score-Based Selection**: Minimum score reduced from **75 to 40**, allowing more candidates to enter the discussion.
- **Multiple Timeframe Alignment**:
    - **D1**: Primary trend direction and strength (weighted 0-25 pts).
    - **H4**: Support/Resistance proximity (20 pts), Trend alignment (15 pts), and Stochastic oversold/overbought (10 pts).
    - **M15**: Market structure (bullish/bearish) (15 pts), Break of Structure (BoS) (15 pts bonus), and Trend alignment (10 pts).
- **Confluence Rule**: A signal must have at least **2 supporting reasons** to be valid, ensuring even relaxed signals have some technical basis.
- **Risk:Reward (R:R) Optimization**: All potentials are filtered by a minimum R:R ratio (defined in config). Entry, Stop Loss (SL), and Take Profit (TP) are pre-calculated based on H4 S/R levels.

---

## [v1.0.0] - Initial Modular Strategy
*Released: 2026-03-30*

- Initial implementation of technical indicators (EMA, Stochastic, S/R).
- Hard-filtered entries based on strict RSI/Stoch and EMA alignment.
- Simple Binance API integration for market data.
- Basic Telegram notifications.

---

## Future Strategies to Consider:
- [ ] Integration of Volume Profile for more accurate S/R levels.
- [ ] Correlation matrix to avoid taking too many similar trades in high volatility.
- [ ] Sentiment analysis via OpenRouter (AI refinement) - *Partially implemented*.
