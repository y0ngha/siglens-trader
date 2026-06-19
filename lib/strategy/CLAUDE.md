# lib/strategy/ — Domain Layer

Pure business logic for trading decisions. **No external dependencies. No I/O.**

## Files

| File | Responsibility |
|------|---------------|
| `types.ts` | Type definitions (SignalScore, ScoreWeights, TradingSignal including `average_in`) + constants (DEFAULT_WEIGHTS: `{technical:8, news:6, options:5, fundamental:4}`, DEFAULT_BUY_THRESHOLD: 70, DEFAULT_SELL_THRESHOLD: 30) |
| `signal-scorer.ts` | Converts analysis results → 0-100 weighted score. Maps trend/sentiment/signals to component scores, then computes weighted average. |
| `risk-manager.ts` | Position sizing (fixed ratio based on maxPositionSize/maxTotalExposure), stop loss, take profit. Includes `evaluateExistingPosition()` for dynamic exit based on analysis. |
| `decision.ts` | Combines signal score + position state → buy/sell/hold/average_in. Generates human-readable `reason` string with component breakdown. |
| `safe-extract.ts` | Defensive extraction helpers for untyped AI analysis JSON. `safeAnalysisPrice`, `safeAnalysisTrend`, `safeAnalysisSentiment`, `safeAnalysisSupport`, `safeAnalysisResistance`, `safeAnalysisTargetPrice`, `safeActionRecommendation`, `safeAnalysisIndicators` (technical `indicatorResults[].signals[]`), `safeFundamentalCategories` (fundamental `categoryAssessments[]`). Returns safe defaults instead of throwing on unexpected shapes. Imports `isFinitePositive` from `lib/validation`. |

## Rules

- **100% test coverage required.** Every change must maintain this.
- **No imports from `lib/data/`, `lib/trading/`, `lib/db/`, or any external package.** Exception: `safe-extract.ts` imports `isFinitePositive` from `lib/validation.ts` (pure utility, no I/O).
- Pure functions only — given inputs, return deterministic outputs.
- All thresholds and weights must be parameterized (not hardcoded).

## Signal Scoring

Priority-weighted average of 4 analysis axes (weights sum to 23):
- Technical (8): strength-weighted aggregate of `indicatorResults` signals (continuous, 50 ± 35) + riskLevel (±10) + actionRecommendation.entryRecommendation (enter +20 / wait −15 / avoid −25). Falls back to the single top-level `trend` when no indicator signals exist.
- News (6): overallSentiment (bullish 80 / neutral 50 / bearish 20)
- Options (5): directional (bullish/bearish) signal ratio with shrinkage (pseudo-count k=1) so a lone signal doesn't snap to 0/100; neutral/volatility kinds ignored
- Fundamental (4): mean of `categoryAssessments` sentiments (continuous, 50 ± 30), falling back to overallSentiment when no categories exist

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
signal === 'buy' && hasOpenPosition && calculatedSize > 0  → AVERAGE_IN (추가 매수)
signal === 'sell' && hasOpenPosition → SELL (full position)
otherwise → HOLD
```

Special case: if signal is 'buy' but calculatedSize is 0 (exposure limit reached), the execute cron records a "skipped" trade with reason.

### Average-in Logic

When a buy signal fires for a symbol that already has an open position, the decision layer emits `average_in` instead of `buy`. The execute cron then:
1. Caps the additional quantity by per-symbol exposure limit (`maxPositionSize - currentExposure`)
2. Calls `averageIntoPosition()` with atomic SQL to compute new weighted average price
3. Wraps trade insert + position update in a DB transaction

### Partial Fill Handling

When broker returns `filledQuantity < requestedQuantity`:
- `reducePositionQuantity()` decrements the open position by the sold quantity (SQL `quantity - soldQuantity WHERE quantity >= soldQuantity`)
- If `filledQuantity >= positionQuantity`, full close via `closePosition()`
- Email alert sent for partial fills

### Stop-loss Cooldown

Symbols closed by stop-loss during a cron run are tracked in `recentStopLossSymbols` (in-memory Set). Buy/average_in signals for these symbols are suppressed during the same run to prevent stop-loss → immediate re-buy loops.
