# lib/analysis/ — Application Layer

Wraps siglens-core's submit/poll pattern into single-call "run analysis" functions.

## Files

| File | Responsibility |
|------|---------------|
| `types.ts` | `RunAnalysisOptions`, `AnalysisRunResult`, `AnalysisType` |
| `poll-until-done.ts` | Generic poll loop (2s interval, 2.5min timeout) |
| `run-technical.ts` | Calls `submitAnalysis` → `pollAnalysis` from siglens-core |
| `run-news.ts` | Fetches news from FMP → `submitNewsAnalysis` → poll |
| `run-options.ts` | Fetches options from Yahoo → `submitOptionsAnalysis` → poll |
| `run-fundamental.ts` | Injects `FmpFundamentalClient` → `submitFundamentalAnalysis` → poll |
| `run-overall.ts` | Fetches news+options → `submitOverallAnalysis` (resolves deps) → poll |
| `enrich-news-cards.ts` | Per-symbol news card enrichment via fixed worker pool (see below) |
| `timeframe.ts` | `analysis_timeframe` contract + per-timeframe technical staleness limits |
| `source-time.ts` | `extractSourceAnalyzedAt` / `getAnalysisReferenceTime` — freshness-time helpers |

## Dependencies

- `@y0ngha/siglens-core` — submit/poll functions, types
- `lib/data/` — FMP and Yahoo data adapters

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
doesn't invalidate the others. Workers stop pulling new work once the cron-supplied `deadlineMs`
(cron start + 690s) passes or cumulative failures hit `ENRICH_TOTAL_FAILURE_LIMIT` (6); cached
cards are still returned. The deadline keeps a single symbol from blocking the cron's audit
finalization inside `maxDuration` (800s); if time runs out the aggregate per-symbol news analysis
is skipped.

## Testing

All runners are tested with mocked siglens-core and data adapters.
