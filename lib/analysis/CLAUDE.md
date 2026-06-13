# lib/analysis/ — Application Layer

Wraps siglens-core's submit/poll pattern into single-call "run analysis" functions.

## Files

| File | Responsibility |
|------|---------------|
| `types.ts` | `RunAnalysisOptions`, `AnalysisRunResult`, `AnalysisType` |
| `poll-until-done.ts` | Generic poll loop (2s interval, 5min timeout) |
| `run-technical.ts` | Calls `submitAnalysis` → `pollAnalysis` from siglens-core |
| `run-news.ts` | Fetches news from FMP → `submitNewsAnalysis` → poll |
| `run-options.ts` | Fetches options from Yahoo → `submitOptionsAnalysis` → poll |
| `run-fundamental.ts` | Injects `FmpFundamentalClient` → `submitFundamentalAnalysis` → poll |
| `run-overall.ts` | Fetches news+options → `submitOverallAnalysis` (resolves deps) → poll |

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

## Testing

All runners are tested with mocked siglens-core and data adapters.
