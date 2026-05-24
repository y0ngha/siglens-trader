# lib/strategy/ — Domain Layer

Pure business logic for trading decisions. **No external dependencies. No I/O.**

## Files

| File | Responsibility |
|------|---------------|
| `types.ts` | Type definitions (SignalScore, ScoreWeights, TradingSignal) + constants (DEFAULT_WEIGHTS, thresholds) |
| `signal-scorer.ts` | Converts analysis results → 0-100 weighted score. Incorporates actionRecommendation confidence. |
| `risk-manager.ts` | Position sizing (Kelly/fixed), stop loss, take profit. Includes `evaluateExistingPosition()` for dynamic exit based on analysis. |
| `decision.ts` | Combines signal score + position state → buy/sell/hold + generates human-readable `reason` string. |

## Rules

- **100% test coverage required.** Every change must maintain this.
- **No imports from `lib/data/`, `lib/trading/`, `lib/db/`, or any external package.**
- Pure functions only — given inputs, return deterministic outputs.
- All thresholds and weights must be parameterized (not hardcoded).

## Signal Scoring

Priority-weighted average of 5 analysis axes:
- Technical (40%): trend + riskLevel + actionRecommendation.confidence
- News (20%): overallSentiment
- Options (20%): bullish/bearish signal ratio
- Fundamental (10%): overallSentiment
- Overall (10%): integrated conclusion

## Position Re-evaluation Priority

When evaluating an existing position, checks fire in this order:
1. Fixed stop loss % breach → exit
2. Price below key support level → exit
3. Technical trend reversal (bearish) → exit
4. Fixed take profit % reached → exit
5. Approaching resistance/target price → exit
6. Bearish news + position in profit → preemptive exit
7. None of the above → hold
