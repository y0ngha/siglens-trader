# lib/analysis/ — Application Layer

Calls siglens-core's direct `run*` functions (no polling loop) with per-symbol AbortSignal timeouts.

## Files

| File | Responsibility |
|------|---------------|
| `types.ts` | `RunAnalysisOptions`, `AnalysisRunResult`, `AnalysisType` |
| `run-technical.ts` | Calls `runAnalysis` from siglens-core (single await, no polling) |
| `run-news.ts` | Fetches news from FMP → `runNewsAnalysis` |
| `run-options.ts` | Fetches options from Yahoo → `runOptionsAnalysis` |
| `run-fundamental.ts` | Injects `FmpFundamentalClient` → `runFundamentalAnalysis` |
| `enrich-news-cards.ts` | Per-symbol news card enrichment via fixed worker pool (see below) |
| `timeframe.ts` | `analysis_timeframe` contract + per-timeframe technical staleness limits |
| `source-time.ts` | `extractSourceAnalyzedAt` / `getAnalysisReferenceTime` — freshness-time helpers |
| `trade-gate.ts` | AI position-sizing gate: prompt build → `callAnalysisAi` → JSON parse/validate (see below) |

## Dependencies

- `@y0ngha/siglens-core` — submit/poll functions, types
- `lib/data/` — FMP and Yahoo data adapters
- `lib/strategy/` — **types and pure helpers only** (`safe-extract.ts`, `ScoreWeights`, `ExitTrigger`).
  Allowed because `lib/strategy/` is pure with no I/O; the arrow never points back.

## Return Contract

Every `run*` function returns `Promise<AnalysisRunResult>`:
```typescript
{ status: 'done' | 'cached' | 'error' | 'skipped', result?: unknown, error?: string }
```

- `done`: fresh analysis completed
- `cached`: hit siglens-core's Redis cache
- `skipped`: no data available (empty news, null snapshot) or gated
- `error`: something threw

## Timeframe Contract (`timeframe.ts`)

`analysis_timeframe` accepts only `15Min` / `30Min` / `1Hour`; `normalizeAnalysisTimeframe`
coerces anything else to the `1Hour` default. Technical analysis runs with `force=false`
(siglens-core's Redis cache stays enabled). `getTechnicalMaxAgeMs` returns the per-timeframe
staleness limit the execute cron uses: 15Min→45min, 30Min→90min, 1Hour→2h.

## Freshness Time (`source-time.ts`)

`extractSourceAnalyzedAt(result, fallback)` reads the LLM result's real `analyzedAt`
(strict ISO-instant parse) and is persisted as `analysis_results.source_analyzed_at`.
`getAnalysisReferenceTime(row)` returns `source_analyzed_at` when present, falling back to
`analyzed_at` — this is the timestamp the execute cron judges technical freshness against.

## News Card Enrichment (`enrich-news-cards.ts`)

Enriches the latest `NEWS_ENRICH_LIMIT` (10) articles per symbol through a fixed worker pool
of `NEWS_ENRICH_CONCURRENCY` (3). Workers pull from a shared index, so one article's failure
doesn't invalidate the others.

`generateCard` checks `outcome.status === 'done'` explicitly before accessing `outcome.result`;
any unexpected non-done resolve (future core expansion) logs a warning and returns `null` so the
`failures` counter is correctly incremented rather than persisting `undefined` into the news-card
table. Each card call also receives an `AbortSignal` capped at the remaining deadline.

Workers stop pulling new work once the cron-supplied `deadlineMs` (cron start + 690s) passes or
cumulative failures (throw **or** unexpected non-done resolve) hit `ENRICH_TOTAL_FAILURE_LIMIT`
(6); cached cards are still returned. The deadline keeps a single symbol from blocking the cron's
audit finalization inside `maxDuration` (800s); if time runs out the aggregate per-symbol news
analysis is skipped.

## Trade Gate (`trade-gate.ts`)

Called by the execute cron **after** every rule-engine guard has already decided *whether* to
buy or sell. The gate answers exactly one question — *how large should that trade be* — and
returns a `fraction` (0~1) that `lib/strategy/trade-plan.ts` turns into a share count. Design:
[`docs/specs/2026-08-12-ai-trade-gate-design.md`](../../docs/specs/2026-08-12-ai-trade-gate-design.md) §7.

The substance of this file is the **prompt**, not the code. `buildTradeGatePrompt` is exported
separately so tests (and prompt audits) can assert on the exact strings.

- **Every section always exists.** Missing values are printed as `미상` / `없음`, never omitted
  — a dropped section reads as "not applicable" to the model and invites it to invent a number.
  `availableCashUsd: null` also states *why* it is unknown (dry_run/semi_auto don't query the broker).
- **`fraction` means different things per `kind`** and the system prompt says which: entry = share
  of the executable budget, exit = share of the held quantity.
- **Analysis data is fenced in `<analysis>` … `</analysis>`** and the system prompt states that
  anything inside is reference data, never instructions. Those blocks are themselves LLM output,
  so they are a prompt-injection path.
- Only sizing-relevant fields are extracted (via `lib/strategy/safe-extract.ts` plus local
  summarizers for the indicator/category/option-signal roll-ups that safe-extract doesn't cover).
  Each axis carries its own timestamp **and elapsed time** — a day-old fundamental must not be
  read with the same weight as a 30-minute-old technical.
- `reasoning: false` — the execute cron makes up to ~10 gate calls inside a 780s lock, same
  reason technical/options are off. `tier: 'pro'`, 25s `AbortSignal.timeout` per call.
- **No `responseSchema`** — the shape differs per provider, so JSON is enforced by prompt +
  `parseGateResponse` instead.
- Parsing does not trust core's fence stripping: it slices first `{` to last `}`. A `fraction`
  outside 0~1 is an **error, not a clamp** — an out-of-range answer means the model misread the
  contract, and silently rewriting 1.4 → 1.0 turns "didn't understand" into "confident full size".
- `runTradeGate` **never throws**; the execute cron calls it without try/catch. Failure policy
  (entry fail-closed / exit fail-open) lives in the cron, per design §8.

## Testing

All runners are tested with mocked siglens-core and data adapters. `trade-gate.test.ts` covers
both halves: response parsing/validation, and string assertions on the generated prompt
(account figures present, `미상` reasons present, five axes with timestamp + model ID, the
`<analysis>` fence, per-kind `fraction` wording, and an injection payload staying fenced).
