# Trading Strategy Logs

This document tracks the evolution of trading strategies used in the Crypto Signal Bot. Each version represents a significant refinement in how the bot evaluates market conditions.

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
