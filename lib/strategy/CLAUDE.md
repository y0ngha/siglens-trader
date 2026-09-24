# lib/strategy/ — Domain Layer

Pure business logic for trading decisions. **No I/O**, no external packages (only `lib/validation.ts`).

The trading rule is the daily RSI(2) mean-reversion in `mean-reversion.ts` —
[`docs/specs/2026-09-24-daily-mean-reversion-design.md`](../../docs/specs/2026-09-24-daily-mean-reversion-design.md).

## Files

| File | Responsibility |
|------|---------------|
| `mean-reversion.ts` | **The rule.** Indicators (SMA, Wilder RSI, Wilder ATR — same formulas as the backtest), `readSymbol` / `readRegime` (≥ 200 bars, last bar = today at the live price), `isEntrySignal`, `rankSignals` (RSI(2) ascending), `stopPriceFor` / `isStopHit` (disaster stop), `holdDays` (distinct dates after entry), `evaluateRuleExit` (MA5 reclaim / time stop, never on the entry day). A parity test replays real FMP bars and must signal on exactly the backtest's dates — change a formula and the backtest has to be re-run and the fixture regenerated. |
| `daily-loss.ts` | Today's unrealized change for the daily loss breaker: reference = entry price if opened today, else previous close (entry price when missing — substitute, never exclude). A quote > 25% from its reference counts as a corrupt tick (change 0). |
| `trade-plan.ts` | Budget → share count. `planEntry` = min(per-symbol cap, total-exposure cap, cash), sanitizing every input with `safeNumber` so a NaN budget cannot disable a cap; `planExit` turns a fraction into shares (`hard: true` = full). |
| `execute-interval.ts` | execute cron interval gate. `EXECUTE_INTERVALS` = **5 / 10** — the decision window (last 20 minutes before the close) must contain at least two ticks so one missed tick doesn't lose the day. |
| `pnl.ts` | `realizedPnlForSell`. |
| `safe-extract.ts` | Defensive extraction helpers for untyped AI analysis JSON — used by the AI review prompt (`lib/analysis/entry-review.ts`). Returns safe defaults instead of throwing. |

### `safe-extract.ts` — fixtures must come from core's real shapes

Two extraction bugs (`keyLevels` as `{ price, reason }[]`, `priceTargets` as `{ bullish: { targets: [...] } }`)
stayed green for a release because test fixtures used shapes core never emits, and each silently disabled an exit
rule in the old strategy. The rule engine no longer reads AI levels, but the review prompt does — so fixtures in
tests are still typed against the core interfaces (`satisfies AnalysisResponse` etc.).

## Rules

- **100% test coverage required** for `mean-reversion.ts` and `daily-loss.ts` (they are in the coverage include list).
- **No imports from `lib/data/`, `lib/trading/`, `lib/db/`, or any external package.** Exception: `lib/validation.ts` (pure utility, no I/O).
- Pure functions only — given inputs, return deterministic outputs.
- Tunable thresholds are parameters (`MeanReversionParams`, read from config by `api/_lib/mr-config.ts`); the SMA periods (200/5) are constants on purpose — they are the rule's identity.
