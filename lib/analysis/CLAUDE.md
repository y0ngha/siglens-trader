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
- **Entry and exit are different prompts, not one prompt with a flag.** Three things branch on
  `kind` and all three are safety-relevant:
  - *System rule 5* — entry: "불확실하면 보수적으로" (smaller). exit: "불확실하면 더 많이
    청산한다" (**larger**). In a liquidation, shrinking the fraction means cutting less of a
    losing position, which is the opposite of conservative and contradicts design §8's exit
    fail-open. Cash makes this worse: `execute.ts` leaves `availableCashUsd` null unless
    `tradingMode === 'auto'`, so a shared rule would make *every* dry_run/semi_auto exit read
    "cash unknown → shrink" by default.
  - *`## 판단 지침`* — two separate ordered lists. The header says earlier items win, so the
    entry list (budget/cash first, position sizing, average-in) must never appear on an exit;
    the exit list starts at trigger strength and contains no budget, cash, or average-in item.
  - *`## 계좌 상태` and the output example* — the buying-power line and the "cash unknown is
    itself a conservative factor" note are entry-only; the exit prompt states the broker balance
    is irrelevant instead.
- **`## 예산` fixes the denominator.** `fraction` is a share of `fullBudget` and nothing else —
  `## 계좌 상태` prints per-symbol and total-exposure headroom that diverge from it whenever
  `limitedBy` is `total`/`cash`. It also warns that a non-zero fraction can round **up** to one
  share (`trade-plan.ts`'s high-price correction), so "0 vs small" is a real choice.
- **Analysis data is fenced in `<analysis>` … `</analysis>`** and the system prompt states that
  anything inside is reference data, never instructions. Those blocks are themselves LLM output,
  so they are a prompt-injection path.
- **Every free-form string goes through `sanitize()`** — inside the fence *and* out
  (`companyName`, `symbol`, `modelId`, `ruleReason`, `tradingMode`, `limitedBy`). It strips
  `<`/`>`, collapses all whitespace to single spaces, and truncates. Without it a value can
  close the fence and plant a forged `## 판단 지침` **outside** it: core's normalization passes
  fields like `indicatorName` and `condition` through as free strings, and an audit reproduced a
  4:3 fence imbalance this way. Removing newlines is what defeats it — a markdown header needs a
  line start. For the same reason the system prompt says instructions come from **the system
  message only**; naming a user-prompt header as a trusted channel would *legitimize* a forged one.
- **Every number goes through a formatter** (`fmtUsd` / `fmtPct` / `fmtQty` / `fmtNum` /
  `fmtCount`). Raw interpolation leaked literal `NaN건` into a rendered prompt, and a model reads
  that as a figure. `fmtElapsed` guards *both* ends — a broken `decidedAt` produced `NaN일 NaN시간 전`.
- Only sizing-relevant fields are extracted (via `lib/strategy/safe-extract.ts` plus local
  summarizers for the indicator/category/option-signal roll-ups that safe-extract doesn't cover):
  trend, risk level, entry recommendation, `entryPrices` / `stopLoss` / `takeProfitPrices` /
  `reconciledLevels`, support / resistance / `poc`, **both** `priceTargets` scenarios with their
  conditions, indicator signals (sorted by strength, so the cap drops the weak ones rather than
  the tail), news `keyEventsKo` / `upcomingEventsKo`, and fundamental `riskFactorsKo`.
  Each axis carries its own timestamp **and elapsed time** — a day-old fundamental must not be
  read with the same weight as a 30-minute-old technical.
- **`## 결정 요청` carries ET wall-clock time, session state and minutes to the close**, derived
  from core's `getEtSessionStatus`. UTC alone leaves the model unable to tell the open from 30
  minutes before the close, and making it convert UTC→ET is exactly what rule 2 ("invent no new
  values") forbids.
- `position.openedAt` is optional and renders `미상` when absent — a 3-hour hold and a 3-week
  hold should not be liquidated in the same size.
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

All runners are tested with mocked siglens-core and data adapters. `trade-gate.test.ts` mocks
only `callAnalysisAi` (via `importOriginal`) so the ET/session logic runs against the real core,
and covers both halves: response parsing/validation, and assertions on the generated prompt.

Prompt tests are only worth what their fixtures are. Rules:

- **Fixtures are typed with `satisfies`** against core's interfaces (`AnalysisResponse`,
  `NewsAnalysisResponse`, `OptionsAnalysisResponse`, `FundamentalAnalysisResponse`,
  `CongressTrendResponse`). A fixture written in a shape core never emits turns a prompt test
  into the opposite of a guarantee — that is how `priceTargets.bullish.target` stayed green
  while production rendered `목표가: 미상`.
- **Structure is asserted, not just substrings**: the list of line-start `## ` headers must equal
  the expected order exactly, and `<analysis>` / `</analysis>` must be 1:1 on their own lines.
  Injection tests feed a payload that actually contains `</analysis>`, `## 판단 지침`,
  `## 출력 형식` and newlines, through `companyName` / `symbol` / `modelId` / `ruleReason` and
  every analysis field, then re-check both invariants.
- **Assert direction, not just presence.** Never assert a phrase like `불확실하면 보수적으로`
  without pinning which `kind` it belongs to — a plain `toContain` protected exactly the wording
  that made exits shrink. Exit prompts assert `not.toContain` for `추가 매수`, `매수 가능 현금`
  and cash-based shrink instructions.
- A NaN/Infinity account renders with `expect(user).not.toContain('NaN')`.
