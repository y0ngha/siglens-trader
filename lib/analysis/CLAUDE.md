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
| `run-congress.ts` | Congressional disclosure trend analysis (`runCongressTrendAnalysis`) |
| `confluence.ts` | **No LLM, and no rule either.** FMP 봉(본 봉 + 상위 시간축)을 구해 core의 `evaluateConfluence`에 넘긴다. 판정·채점은 core 소유 — 봉 조회는 소비자 책임, 도메인 계산은 core 책임 |
| `enrich-news-cards.ts` | Per-symbol news card enrichment via fixed worker pool (see below) |
| `cadence.ts` | Per-type clock windows the analysis crons use to skip an already-covered symbol |
| `timeframe.ts` | `analysis_timeframe` contract + per-timeframe technical staleness limits |
| `source-time.ts` | `extractSourceAnalyzedAt` / `getAnalysisReferenceTime` — freshness-time helpers |
| `trade-gate.ts` | AI position-sizing gate: prompt build → `callAnalysisAi` → JSON parse/validate (see below) |

## Dependencies

- `@y0ngha/siglens-core` — submit/poll functions, types, and the pure indicator engine
  (`calculateIndicators` / `detectSignals`) `confluence.ts` runs locally
- `lib/data/` — FMP and Yahoo data adapters, including `getMarketDataProvider()` (OHLC bars)
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

## Indicator Confluence (`confluence.ts`)

이 파일은 **봉을 구해 오는 일만** 한다. 룰과 채점은 siglens-core의 `evaluateConfluence`가
소유한다 — 봉 조회는 소비자 책임, 도메인 계산은 core 책임이라는 분업이다. 같은 룰이
siglens 백테스트와 여기에 따로 구현돼 있던 것을 한 곳으로 모은 결과이고, 이제 백테스트와
실거래가 같은 함수를 부른다.

trader가 소유한 층은 넷이다:

- **`MIN_BARS`(120) 게이트** — 미달이면 core를 부르지도 않고 기권한다. 조용한 기권은
  "이 축이 영구히 꺼진 심볼"을 관측 불가능하게 만들므로 `console.warn`을 남긴다.
- **봉 신선도** — 마지막 봉이 타임프레임 × 3보다 낡으면 기권. `Date.now()`를 읽으므로
  순수 함수가 아니고, 피드 건강은 소비자 관심사다. 이게 없으면 FMP 지연 시 **전 세션
  종가**로 진입 트리거가 서고, 같은 스냅샷의 `close`가 execute의 시세 폴백으로도 쓰여
  손절 판정가·dry_run 체결가가 된다.
- **상위 시간축 봉 조회 + 캐시** — 일봉은 마감 후에만 바뀌는데 execute는 10분마다 돈다.
  성공 1시간 / **실패 5분** 캐시: 실패를 길게 캐시하면 FMP 딸꾹질 한 번이 정렬 게이트를
  6틱 동안 끈다. 캐시 키는 `symbol:htf`.
- **튜너블 전달** — `config`에서 읽은 값만 core로 넘긴다. 미지정 키는 넘기지 않아 core
  기본값이 살아 있게 한다.

실패는 전부 `null`이다 — 이 축은 추가 정보이지 매매의 전제조건이 아니고, `scoreSignals`가
`null`을 가중치 0으로 처리해 도입 이전과 동일하게 동작한다.

**마지막 봉은 형성 중일 수 있다.** FMP 인트라데이 응답의 꼬리는 진행 중인 봉이라 봉이 닫히기
전 트리거가 번복될 수 있다. 버리면 최대 1타임프레임만큼 늦게 반응하므로 그대로 쓴다.

## Trade Gate (`trade-gate.ts`)

Called by the execute cron **after** every rule-engine guard has already decided *whether* to
buy or sell. The gate answers exactly one question — *how large should that trade be* — and
returns a `fraction` (0~1) that `lib/strategy/trade-plan.ts` turns into a share count. Design:
[`docs/specs/2026-08-12-ai-trade-gate-design.md`](../../docs/specs/2026-08-12-ai-trade-gate-design.md) §7.

The substance of this file is the **prompt**, not the code. `buildTradeGatePrompt` is exported
separately so tests (and prompt audits) can assert on the exact strings.

- **Every section always exists.** Missing values are printed as `미상` / `없음`, never omitted
  — a dropped section reads as "not applicable" to the model and invites it to invent a number.
  `availableCashUsd: null` also states *why* it is unknown — it now means the **fetch failed**,
  not "this mode doesn't ask", since all three modes supply a figure. The cash line is
  **identical across modes** on purpose: `dry_run`'s balance comes from its own trade ledger and
  clamps `planEntry` exactly like a broker balance does, so the number means the same thing in
  all three. Mode-specific wording would attach different sizing habits to the same decision, and
  the `매매 모드` line two rows up already names the source.
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
- **The guideline order is a priority contract — inserting into the middle demotes something.**
  Both lists put the confluence item **last** (entry #8, exit #6) for that reason. Its first draft
  sat at #4 in both, and both demotions went the wrong way: on exit, an item that *shrinks* the
  fraction pushed the two risk-reducing items (`분석의 신선도` → enlarge, `당일 손익 여력` → cut
  fast) below it; on entry, an item that *enlarges* sizing pushed `현재 위치와 키 레벨의 관계`
  (risk:reward) and `당일 손익 여력과 남은 장 시간` (daily-loss headroom) below it. So: a guideline
  that limits risk never sits below one that grows size, and on exit a guideline that shrinks the
  fraction never sits above one that grows it. Last is not ignored — the header says earlier wins
  on conflict, not "stop reading".
  - *`## 계좌 상태`, the output example, rule 4's `reason` example, and two analysis lines* —
    the buying-power line and the "cash unknown is itself a conservative factor" note are
    entry-only; the exit prompt states the broker balance is irrelevant instead. `진입 권고`
    and `권장 진입 구간` are dropped from the exit prompt's technical block: a stop-loss prompt
    reading "진입 권고: enter, 현재가가 권장 진입 구간 안" hands exit guideline 3 ("is the trend
    still alive?") a reason to cut less. Stop-loss / take-profit / key levels / POC / price
    targets stay — those *are* exit inputs. Rule 4's example likewise cites 예산 제약 on entry
    and 트리거 강도 on exit, since `## 예산` declares itself 해당 없음 two sections later.
- **Inside the fence: facts only. Instructions live in the system prompt and `## 판단 지침`.**
  The confluence block's first line used to end with an imperative ("weigh this axis more when the
  axes disagree") — rendered *inside* `<analysis>`, which system rule 3 declares is never an
  instruction. Both outcomes lose: obey the rule and the line is dead, follow the line and the
  model learns that fenced text can instruct, which is exactly the forged-`## 판단 지침` defense.
  The instruction now sits in the guideline list (entry #4: weigh it more; exit #4: it is not
  decisive) and the fenced line states only what the axis is.
  That line also **branches on `kind`** (`CONFLUENCE_SOURCE_LINE`): the backtest's 70% win rate
  belongs to the **entry** rule — that backtest exited on ATR SL/TP plus a 10-bar timeout, so the
  bearish inverse has never been validated as an exit rule, and it fires far more often in
  practice. A shared line would let `청산 트리거: 성립` on the very next row borrow the 70%.
- **A corrected sell explains itself.** `scoreSignals`'s sell asymmetry can produce `total: 51`
  with `signal: 'sell'` against a sell threshold of 30. `TradeGateSignal.totalWithoutConfluence`
  (optional) renders one extra line **only when it differs from `total`** — system rule 2 says
  everything printed is true, so an unexplained 21-point contradiction makes the model reconcile
  it, and on an exit that reconciliation lands on a smaller fraction. Equal or absent → no line,
  because a line printed every run is noise that invites hunting a contradiction that isn't there.
- **`## 예산` fixes the denominator.** `fraction` is a share of `fullBudget` and nothing else —
  `## 계좌 상태` prints per-symbol and total-exposure headroom that diverge from it whenever
  `limitedBy` is `total`/`cash`. It also warns that a non-zero fraction can round **up** to one
  share (`trade-plan.ts`'s high-price correction), so "0 vs small" is a real choice.
- **Analysis data is fenced in `<analysis>` … `</analysis>`** and the system prompt states that
  anything inside is reference data, never instructions. Those blocks are themselves LLM output,
  so they are a prompt-injection path.
- **Every free-form string goes through `sanitize()`** — inside the fence *and* out
  (`companyName`, `symbol`, `modelId`, `ruleReason`, `tradingMode`, `limitedBy`). It strips
  `<`/`>` (and their full-width twins `＜`/`＞`), collapses all whitespace to single spaces, and
  truncates. Without it a value can
  close the fence and plant a forged `## 판단 지침` **outside** it: core's normalization passes
  fields like `indicatorName` and `condition` through as free strings, and an audit reproduced a
  4:3 fence imbalance this way. Removing newlines is what defeats it — a markdown header needs a
  line start. For the same reason the system prompt says instructions come from **the system
  message only**; naming a user-prompt header as a trusted channel would *legitimize* a forged one.
- **Every number goes through a formatter** (`fmtUsd` / `fmtPct` / `fmtQty` / `fmtNum` /
  `fmtCount`). Raw interpolation leaked literal `NaN건` into a rendered prompt, and a model reads
  that as a figure. `fmtElapsed` guards *both* ends — a broken `decidedAt` produced `NaN일 NaN시간 전`.
  Korean particles are avoided after a formatted value, since `미상` + `가` reads as `미상가`.
- **Label lookups get the same discipline** — `PRICE_SOURCE_LABEL` / `TRIGGER_LABEL` /
  `SESSION_LABEL` all end in `?? '미상'`, because an unmapped key otherwise ships
  `트리거 종류: undefined`. The **key type** is a separate decision from the fallback, and the two
  are not a trade-off: this repo sets neither `noUncheckedIndexedAccess` nor
  `no-unnecessary-condition`, so a union key compiles fine *and* keeps the runtime fallback.
  - `ExitTrigger` and `priceSource` are **ours**, so those maps use union keys: adding a trigger
    should fail `yarn typecheck` here rather than silently ship `트리거 종류: 미상` for the value
    exit guideline 1 reads first.
  - `SESSION_LABEL` alone is keyed `string`, because its union belongs to **core**. Locking it
    would mean a dependency upgrade breaks our build; for a type we cannot edit, a graceful
    `미상` beats a red CI.
- Only sizing-relevant fields are extracted (via `lib/strategy/safe-extract.ts` plus local
  summarizers for the indicator/category/option-signal roll-ups that safe-extract doesn't cover):
  trend, risk level, entry recommendation, `entryPrices` / `stopLoss` / `takeProfitPrices`,
  support / resistance / `poc`, **both** `priceTargets` scenarios with their
  conditions, indicator signals (sorted by strength, so the cap drops the weak ones rather than
  the tail), news `keyEventsKo` / `upcomingEventsKo`, and fundamental `riskFactorsKo`.
  Each axis carries its own timestamp **and elapsed time** — a day-old fundamental must not be
  read with the same weight as a 30-minute-old technical.
- **`reconciledLevels` replaces the value it corrects, rather than sitting on its own line.**
  Core leaves the AI's `stopLoss` / `takeProfitPrices` untouched and attaches domain-derived
  replacements when they were invalid. A separate `보정 레벨` line was one more row no guideline
  referenced, while the model kept reading the (invalid, hence corrected) original above it. So
  the corrected number takes the slot and the original follows in parentheses with core's reason.
  The label appears **only when the rendered values actually differ** — `takeProfitPrices` is
  documented as "the full array, with only the invalid entries replaced", so a stop-loss-only
  reconciliation echoes the take-profits unchanged, and labelling those as corrected would attach
  the stop-loss reason to a value nothing touched. Core's own
  `getReconciledActionLineData` diffs the same way.
- **`## 결정 요청` carries ET wall-clock time, session state and minutes to the close**, derived
  from core's `getEtSessionStatus`. UTC alone leaves the model unable to tell the open from 30
  minutes before the close, and making it convert UTC→ET is exactly what rule 2 ("invent no new
  values") forbids.
- **That session verdict is labelled as a guess, on purpose.** `getEtSessionStatus` looks only at
  weekday + minute-of-day — core has no holiday table — so Thanksgiving 14:00 ET returns `open`,
  and a half-day (13:00 ET close) also returns `open` while `ET_CLOSE_MINUTES` keeps counting to
  16:00. The label is therefore `정규장 시간대`, not `정규장`, and both the state and the
  minutes-to-close carry an explicit "holidays and early closes not accounted for" caveat.
  Rule 2 tells the model everything in the prompt is true, and entry guideline 6 sizes on exactly
  this value, so an unqualified claim here is a lie the model will act on. Calling
  `isUsMarketOpen()` is *not* the fix — `lib/analysis/` must not reach the broker API, and a
  network hop does not belong in a 25s budget. Honest labelling is the fix.
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
- **Both outcome variants carry a `transcript`** (`systemPrompt` / `userPrompt` /
  `rawResponse`) so the caller can persist what actually went out and came back — the
  execute cron writes it to `trade_audit`. It is a pure value; the I/O stays in the cron
  because this layer must not reach the DB. `rawResponse: null` means the call failed
  **before any response**, which is a different fault from "responded but unparseable" —
  keep the two distinguishable, that distinction is the point of storing it.
- **`confidence` is rounded to an integer.** `trade_audit.confidence` is an `integer` column, so
  a fractional value raises `22P02` — and that failure is swallowed by the cron's `auditGate`,
  which means the **entire audit row vanishes silently**. The range check alone does not save it:
  a model answering on a 0–1 scale (`0.85`) or with `92.5` passes it. The value never enters
  sizing arithmetic, so rounding costs nothing.

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
