# lib/strategy/ — Domain Layer

Pure business logic for trading decisions. **No external dependencies. No I/O.**

## Files

| File | Responsibility |
|------|---------------|
| `types.ts` | Type definitions (SignalScore, ScoreWeights, TradingSignal) + constants (DEFAULT_WEIGHTS: `{technical:8, news:6, options:5, fundamental:4, overall:3}`, DEFAULT_BUY_THRESHOLD: 70, DEFAULT_SELL_THRESHOLD: 30) |
| `signal-scorer.ts` | Converts analysis results → 0-100 weighted score. Maps trend/sentiment/signals to component scores, then computes weighted average. |
| `risk-manager.ts` | Position sizing (fixed ratio based on maxPositionSize/maxTotalExposure), stop loss, take profit. Includes `evaluateExistingPosition()` for dynamic exit based on analysis. |
| `decision.ts` | Combines signal score + position state → buy/sell/hold. Generates human-readable `reason` string with component breakdown. |

## Rules

- **100% test coverage required.** Every change must maintain this.
- **No imports from `lib/data/`, `lib/trading/`, `lib/db/`, or any external package.**
- Pure functions only — given inputs, return deterministic outputs.
- All thresholds and weights must be parameterized (not hardcoded).

## Signal Scoring

Priority-weighted average of 5 analysis axes (weights sum to 26):
- Technical (8): trend + riskLevel + actionRecommendation.confidence
- News (6): overallSentiment
- Options (5): bullish/bearish signal ratio
- Fundamental (4): overallSentiment
- Overall (3): integratedConclusionKo keyword matching

## Position Re-evaluation Priority

When evaluating an existing position, checks fire in this order:
1. Fixed stop loss % breach → stop_loss (**only when `fixedExitEnabled` is true**)
2. Price below key support level → stop_loss (always active)
3. Technical trend reversal (bearish) → take_profit if in profit, stop_loss if in loss (always active)
4. Fixed take profit % reached → take_profit (**only when `fixedExitEnabled` is true**)
5. Approaching resistance (98%) or target price (95%) → take_profit (always active)
6. Bearish news + non-bullish trend + profit zone → take_profit (always active)
7. None of the above → hold

## Trade Decision Logic

```
signal === 'buy' && !hasOpenPosition && calculatedSize > 0 → BUY
signal === 'sell' && hasOpenPosition → SELL (full position)
otherwise → HOLD
```

Special case: if signal is 'buy' but calculatedSize is 0 (exposure limit reached), the execute cron records a "skipped" trade with reason.
