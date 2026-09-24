# lib/analysis/ — Application Layer

Calls siglens-core's direct `run*` functions (no polling loop) with per-symbol AbortSignal timeouts.

## Files

| File | Responsibility |
|------|---------------|
| `types.ts` | `RunAnalysisOptions`, `AnalysisRunResult`, ports (`NewsCardStore`, `PriorAnalysisStore`), `ANALYSIS_TIER` |
| `run-technical.ts` | Calls `runAnalysis` from siglens-core (single await, `force = true`, default timeframe **1Day**) |
| `run-news.ts` | Fetches news from FMP → `runNewsAnalysis` |
| `run-fundamental.ts` | Injects `FmpFundamentalClient` → `runFundamentalAnalysis` |
| `daily-bars.ts` | FMP daily bars (400 calendar days) with today's bar set to the live price; `etDateOf` / `etMinutesOfDay` / `etDayStart` (ET clock helpers shared by execute and review) |
| `entry-review.ts` | **Record-only** AI review of a rule signal: prompt build → `callAnalysisAi` → JSON parse (`fraction`, `dropCause`, `confidence`, `reason`). Never throws. Formerly the AI sizing gate (`trade-gate.ts`); its formatters, sanitizer and `<analysis>` fence (prompt-injection defense) are kept |
| `enrich-news-cards.ts` | Per-symbol news card enrichment via fixed worker pool (see below) |
| `prior-analysis.ts` | Maps stored technical rows to core's `priorAnalyses` |
| `source-time.ts` | `extractSourceAnalyzedAt` / `getAnalysisReferenceTime` — freshness-time helpers |

Only the review cron (`api/cron/review.ts`) runs these now — for symbols that signalled that day. The hourly
analysis crons, options/congress runners, the confluence axis and the cadence windows were removed on 2026-09-24.

## Dependencies

- `@y0ngha/siglens-core` — `run*` functions, `callAnalysisAi`, market calendar, types
- `lib/data/` — FMP and Yahoo data adapters, including `getMarketDataProvider()` (OHLC bars)
- `lib/strategy/` — **types and pure helpers only** (`safe-extract.ts`, `DailyBar`). The arrow never points back.

## Return Contract

Every `run*` function returns `Promise<AnalysisRunResult>`:
```typescript
{ status: 'done' | 'cached' | 'error' | 'skipped', result?: unknown, error?: string }
```

- `done`: fresh analysis completed
- `cached`: hit siglens-core's Redis cache
- `skipped`: no data available (empty news, null snapshot) or gated
- `error`: something threw

## Freshness Time (`source-time.ts`)

`extractSourceAnalyzedAt(result, fallback)` reads the LLM result's real `analyzedAt`
(strict ISO-instant parse) and is persisted as `analysis_results.source_analyzed_at`.
`getAnalysisReferenceTime(row)` returns `source_analyzed_at` when present, falling back to
`analyzed_at` — the review prompt shows this time (and "N분 전") for each analysis.

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

## Testing

All runners are tested with mocked siglens-core and data adapters. `entry-review.test.ts` mocks
only `callAnalysisAi` (via `importOriginal`) so the ET/session logic runs against the real core,
and covers both halves: response parsing/validation, and assertions on the generated prompt.

Prompt tests are only worth what their fixtures are. Rules:

- **Fixtures are typed with `satisfies`** against core's interfaces (`AnalysisResponse`,
  `NewsAnalysisResponse`, `FundamentalAnalysisResponse`). A fixture written in a shape core never
  emits turns a prompt test into the opposite of a guarantee — that is how
  `priceTargets.bullish.target` stayed green while production rendered `목표가: 미상`.
- **Injection tests feed a real payload** — `</analysis>`, a newline and `## 판단 지침` inside an
  analysis field — and assert `</analysis>` appears exactly once and `## 판단 지침` exactly once
  at line start.
- Sparse / NaN inputs render `미상`, never `undefined` or `NaN` (`not.toMatch(/undefined|NaN/)`).
