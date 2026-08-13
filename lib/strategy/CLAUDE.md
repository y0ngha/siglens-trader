# lib/strategy/ — Domain Layer

Pure business logic for trading decisions. **No external dependencies. No I/O.**

## Files

| File | Responsibility |
|------|---------------|
| `types.ts` | Type definitions (SignalScore, ScoreWeights, TradingSignal including `average_in`) + constants (DEFAULT_WEIGHTS: `{confluence:12, technical:8, news:6, options:5, fundamental:4, congress:3}`, `WEIGHTS_BY_TIMEFRAME` (15Min/30Min override the default profile), DEFAULT_BUY_THRESHOLD: 70, DEFAULT_SELL_THRESHOLD: 30) |
| `confluence.ts` | `ConfluenceSnapshot` type + `scoreConfluence` / `isConfluenceExit`. Scores the backtest's rule (3+ bullish types, ≥1 fresh, close > SMA(50)) from a snapshot the analysis layer computed. Constants: `CONFLUENCE_MIN` 3, `CONFLUENCE_SPAN` 30, `CONFLUENCE_SHRINK` 1, `CONFLUENCE_TRIGGER_SCORE` 92, `CONFLUENCE_EXIT_SCORE` 8. |
| `signal-scorer.ts` | Converts analysis results → 0-100 weighted score. Maps trend/sentiment/signals to component scores, then computes weighted average. |
| `risk-manager.ts` | Position sizing (fixed ratio based on maxPositionSize/maxTotalExposure), stop loss, take profit. Includes `evaluateExistingPosition()` for dynamic exit based on analysis. `PositionEvaluation.hard` marks exits the AI trade gate must never override (see below). |
| `trade-plan.ts` | Fraction (0~1) → order quantity for split entries/exits. `clampFraction` (built on `safeNumber`) normalizes any value to 0~1 without ever producing NaN, and also clamps its own `fallback`. `planEntry` sanitizes every budget input with `safeNumber` before the min/max chain (a NaN budget must never silently disable the per-symbol/total-exposure circuit breaker), clamps a tranche against symbol/total/cash budgets (with a high-price 1-share correction that also realigns `trancheBudget`), and refuses to return a non-`Number.isSafeInteger` quantity. `planExit` turns a liquidation fraction into a share count, `hard: true` bypassing it for absolute risk exits. `fallbackEntryFraction` is a deterministic 3-rung sizing ladder, exported and tested but not currently wired into any caller — see its docstring. |
| `decision.ts` | Combines signal score + position state → buy/sell/hold/average_in. Generates human-readable `reason` string with component breakdown. |
| `safe-extract.ts` | Defensive extraction helpers for untyped AI analysis JSON. `safeAnalysisPrice`, `safeAnalysisTrend`, `safeAnalysisSentiment`, `safeAnalysisSupport`, `safeAnalysisResistance`, `safeAnalysisPriceScenario`, `safeAnalysisTargetPrice`, `safeActionRecommendation`, `safeAnalysisIndicators` (technical `indicatorResults[].signals[]`), `safeFundamentalCategories` (fundamental `categoryAssessments[]`). Returns safe defaults instead of throwing on unexpected shapes. Imports `isFinitePositive` from `lib/validation`. `safeAnalysisSupport`/`safeAnalysisResistance` extract via `safePriceLevelArray`, which accepts **both** a bare `number[]` and siglens-core's real `{ price: number; reason: string }[]` `KeyLevel[]` shape — the object shape used to make both functions always return `undefined` in production, since the old `safeNumberArray`-based extractor only kept `typeof v === 'number'` elements. `safeNumberArray` stays a plain-number filter and is no longer the price-level extractor. |

### `priceTargets` extraction — same bug class as `keyLevels`

siglens-core's real shape is `PriceTargets = { bullish: PriceScenario | null; bearish: PriceScenario | null }`
with `PriceScenario = { targets: { price, basis }[]; condition: string }`. **There is no `target`
scalar.** `safeAnalysisTargetPrice` used to read `priceTargets.bullish.target`, so it always
returned `undefined` in production — which silently disabled the "95% of target price →
take profit" branch of `evaluateExistingPosition`, because `api/cron/execute.ts` feeds that
value in as `targetPrice`.

`safeAnalysisPriceScenario(result, 'bullish' | 'bearish')` is now the extractor: it goes through
`safePriceLevelArray` (so both the real `{ price }` objects and bare numbers work) and still
accepts the legacy `{ target: number }` scalar for previously-stored rows. It returns the whole
target ladder plus `condition`, which the trade-gate prompt renders.

`safeAnalysisTargetPrice` is a thin wrapper returning the **first** bullish target. Its
single-`number` return contract is load-bearing for `execute.ts` — do not widen it; use
`safeAnalysisPriceScenario` when more is needed.

Fixtures in tests must be typed against the core interfaces (`satisfies AnalysisResponse`
etc.). Both this bug and the `keyLevels` one were hidden for a release by fixtures using a
shape core never emits.

## Rules

- **100% test coverage required.** Every change must maintain this.
- **No imports from `lib/data/`, `lib/trading/`, `lib/db/`, or any external package.** Exception: `lib/validation.ts` (pure utility, no I/O) — `safe-extract.ts` imports `isFinitePositive`, `trade-plan.ts` imports `safeNumber`.
- Pure functions only — given inputs, return deterministic outputs.
- All thresholds and weights must be parameterized (not hardcoded).

## Signal Scoring

Priority-weighted average of 6 analysis axes (weights sum to 38 on the default `1Hour` profile):
- Confluence (12): the only rule-based axis — no LLM anywhere in it. Continuous 20..80 from the
  shrunk bullish/bearish type ratio (same pseudo-count trick as options), snapping to ≥92 when the
  backtest entry rule holds exactly and ≤8 when its bearish inverse does. 92 is deliberately below
  what a lone axis needs to cross the buy threshold: trigger + everything else neutral = 63 → hold.
- Technical (8): strength-weighted aggregate of `indicatorResults` signals (continuous, 50 ± 35) + riskLevel (±10) + actionRecommendation.entryRecommendation (enter +20 / wait −15 / avoid −25). Falls back to the single top-level `trend` when no indicator signals exist.
- News (6): overallSentiment (bullish 80 / neutral 50 / bearish 20)
- Options (5): directional (bullish/bearish) signal ratio with shrinkage (pseudo-count k=1) so a lone signal doesn't snap to 0/100; neutral/volatility kinds ignored
- Fundamental (4): mean of `categoryAssessments` sentiments (continuous, 50 ± 30), falling back to overallSentiment when no categories exist
- Congress (3): `overallSentiment` through the same `scoreSentiment` as news — the shape is identical

**Confluence and congress are conditional voters**: when the input is `null` their weight drops to
0 and leaves the denominator entirely. Most symbols have no congressional disclosure, and a symbol
whose bars FMP could not serve has no snapshot — in both cases a constant neutral 50 carrying real
weight would drag every other axis toward 50 and make the system *less* decisive for both entries
and exits. The other four always produce a number, so they always vote.

## Position Re-evaluation Priority

When evaluating an existing position, checks fire in this order:
1. Fixed stop loss % breach → stop_loss (**only when `fixedExitEnabled` is true**) — `hard: true`
2. Price below key support level → stop_loss (always active)
3. Technical trend reversal (bearish) → take_profit if in profit, stop_loss if in loss (always active)
4. Bearish indicator confluence (`confluenceExit`: 3+ bearish types, ≥1 fresh, close < MA50) →
   take_profit if in profit, stop_loss if in loss (always active). **`hard` is deliberately unset** —
   this is an indicator judgment, not an absolute risk limit, so the sizing gate decides how much to
   cut. It sits *behind* the trend reversal so it never re-handles a case step 3 already caught.
5. Fixed take profit % reached → take_profit (**only when `fixedExitEnabled` is true**)
6. Approaching resistance (98%) or target price (95%) → take_profit (always active)
7. Bearish news + non-bullish trend + profit zone → take_profit (always active)
8. None of the above → hold

The two invalid-price guards ahead of step 1 (bad `avgPrice` / `currentPrice`) also return
`hard: true`. `hard` marks exits an upstream AI sizing gate (see
`docs/specs/2026-08-12-ai-trade-gate-design.md`) must execute in full rather than partially —
corrupted data and an operator-set fixed stop-loss are absolute risk controls, not calls for
the gate to soften. Every other branch (support break, trend reversal, fixed/dynamic take
profit, bearish news, bearish confluence) is an analysis-derived opinion and leaves `hard` unset,
letting the gate size the exit.

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
