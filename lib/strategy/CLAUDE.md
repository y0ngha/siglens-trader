# lib/strategy/ — Domain Layer

Pure business logic for trading decisions. **No I/O.**

외부 패키지 import도 원칙적으로 없다. **예외는 `confluence.ts` 하나** — siglens-core의
`domain/signals/confluence`를 재수출한다. 규칙의 목적은 이 계층을 순수하게 유지해 테스트
가능하게 두는 것이고, core의 `domain/`은 그 자체가 "zero I/O, zero side effects"를 헌장으로
갖는 계층이라 목적에 어긋나지 않는다. 시계를 읽는 봉 신선도 검사처럼 비순수한 부분은 일부러
`lib/analysis/` 쪽에 남겼다.

## Files

| File | Responsibility |
|------|---------------|
| `types.ts` | Type definitions (SignalScore — including `totalWithoutConfluence`, the confluence-excluded weighted average that is the real basis of a corrected `sell` and equals `total` whenever confluence doesn't vote; ScoreWeights, TradingSignal including `average_in`) + constants (DEFAULT_WEIGHTS: `{confluence:12, technical:8, news:6, options:5, fundamental:4, congress:0}`, `WEIGHTS_BY_TIMEFRAME` (15Min/30Min override the default profile), DEFAULT_BUY_THRESHOLD: 70, DEFAULT_SELL_THRESHOLD: 30) |
| `confluence.ts` | **core 재수출 한 겹, 로직 없음.** 룰과 채점은 siglens-core의 `domain/signals/confluence`가 소유한다 (`evaluateConfluence` / `scoreConfluence` / `isConfluenceExit` / `confluenceFamilyWeight` / `signalFamily` + 상수). 같은 룰이 siglens 백테스트와 trader에 따로 구현돼 조용히 갈라지던 것을 한 곳으로 모았다 — 이제 백테스트와 실거래가 같은 함수를 부른다. 봉 조회는 `lib/analysis/confluence.ts`. |
| `signal-scorer.ts` | Converts analysis results → 0-100 weighted score. Maps trend/sentiment/signals to component scores, then computes weighted average. |
| `risk-manager.ts` | Position sizing (fixed ratio based on maxPositionSize/maxTotalExposure), stop loss, take profit. Includes `evaluateExistingPosition()` for dynamic exit based on analysis. `PositionEvaluation.hard` marks exits the AI trade gate must never override (see below). **규칙 5(저항선 근접)는 4.5(분석 익절가)의 폴백이라 `aiTakeProfit`이 없을 때만 발동한다** — 항상 돌던 시절 실측 99.2%의 틱에서 조건이 참이었고 "사자마자 청산"이 됐다. `entry-zone.ts`의 `firstUpsideExit`이 같은 규칙을 미러링한다. |
| `trade-plan.ts` | Fraction (0~1) → order quantity for split entries/exits. `clampFraction` (built on `safeNumber`) normalizes any value to 0~1 without ever producing NaN, and also clamps its own `fallback`. `planEntry` sanitizes every budget input with `safeNumber` before the min/max chain (a NaN budget must never silently disable the per-symbol/total-exposure circuit breaker), clamps a tranche against symbol/total/cash budgets (with a high-price 1-share correction that also realigns `trancheBudget`), and refuses to return a non-`Number.isSafeInteger` quantity. `planExit` turns a liquidation fraction into a share count, `hard: true` bypassing it for absolute risk exits. `fallbackEntryFraction` is a deterministic 3-rung sizing ladder, exported and tested but not currently wired into any caller — see its docstring. |
| `entry-window.ts` | 신규 진입 허용 시간 창 (ET 고정). `parseEntryWindow` / `formatEntryWindow` / `isWithinEntryWindow` / `parseTimeOfDay`, `DEFAULT_ENTRY_WINDOW` (ET 11:00–15:00) / `ENTRY_WINDOW_ALL_DAY` (제한 없음). 진입만 막고 청산은 건드리지 않는다. 창 밖·시각 판독 실패는 둘 다 **차단**(fail-closed). ET 환산에 `Intl.DateTimeFormat`을 쓴다 — JS 표준 빌트인이고 결정론적이므로 I/O 금지 규칙에 걸리지 않는다. |
| `entry-zone.ts` | 진입 품질 게이트 둘. (1) 권장 진입 구간 상단: `exceedsEntryZone` / `formatEntryZone`, `ENTRY_ZONE_TOLERANCE` 1% — **상단만** 본다. (2) 손절 여유: `hasStopRoom` / `formatStopRoom`, `MIN_STOP_ROOM` 0.5% — 진입가가 `max(지지선, 분석 손절가)`보다 그만큼 위인가. (3) 손익비: `hasRiskReward` / `riskRewardRatio` / `firstUpsideExit` / `formatRiskReward`, `MIN_RISK_REWARD` 1.5 — (2)의 **대칭**으로, 하방만 보던 것에 상방을 더한다. 보상은 **가장 먼저 서는** 익절 트리거까지다(분석 익절가 / 목표가 95% 중 최솟값, 그리고 **분석 익절가가 없을 때만** 저항 밴드 하단) — 더 먼 목표를 세면 도달하지 못할 이익을 계산하게 된다. 저항선을 조건부로 세는 이유는 청산 규칙 5가 4.5의 폴백이기 때문이다 — 서지도 않을 트리거를 보상 상한으로 잡으면 손익비가 실제보다 낮게 나온다. 익절 레벨이 전부 진입가 이하면 `0`을 돌려준다(판단 불가인 `null`과 구분). 둘 다 재료가 없으면 통과(fail-open)이고 **매수 전용** — 매도에는 쓰지 않는다(원칙 7). |
| `execute-interval.ts` | execute cron 실행 간격. `EXECUTE_INTERVALS` (5·10·15·20·30·60, 전부 60의 약수), `DEFAULT_EXECUTE_INTERVAL_MIN` 10, `EXECUTE_BASE_MINUTE` 7, `isExecuteInterval` / `parseExecuteInterval` / `isExecuteTick`. 게이트는 `(분 − 7) mod 간격 === 0` — 60분이면 종전 `7 13-21` 스케줄과 실행 시각이 같다. |
| `decision.ts` | Combines signal score + position state → buy/sell/hold/average_in. Generates human-readable `reason` string with component breakdown. |
| `safe-extract.ts` | Defensive extraction helpers for untyped AI analysis JSON. `safeAnalysisTrend`, `safeAnalysisSentiment`, `safeAnalysisSupport`, `safeAnalysisResistance`, `safeAnalysisPriceScenario`, `safeAnalysisTargetPrice`, `safeActionRecommendation`, `safeAnalysisEntryPrices` / `safeAnalysisStopLoss` / `safeAnalysisTakeProfit` (the three `actionRecommendation` prices the rule engine reads; the latter two prefer core's `reconciledLevels`), `safeAnalysisIndicators` (technical `indicatorResults[].signals[]`), `safeAnalysisPatterns` (`patternSummaries` + `strategyResults` + `candlePatterns`, with core's `confidenceWeight`), `safeFundamentalCategories` (fundamental `categoryAssessments[]`). Returns safe defaults instead of throwing on unexpected shapes. Imports `isFinitePositive` from `lib/validation`. `safeAnalysisSupport`/`safeAnalysisResistance` extract via `safePriceLevelArray`, which accepts **both** a bare `number[]` and siglens-core's real `{ price: number; reason: string }[]` `KeyLevel[]` shape — the object shape used to make both functions always return `undefined` in production, since the old `safeNumberArray`-based extractor only kept `typeof v === 'number'` elements. `safeNumberArray` stays a plain-number filter and is no longer the price-level extractor. |

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
- **No imports from `lib/data/`, `lib/trading/`, `lib/db/`, or any external package.** Exception: `lib/validation.ts` (pure utility, no I/O) — `safe-extract.ts` imports `isFinitePositive`, `trade-plan.ts` imports `safeNumber`. `Intl` (used by `entry-window.ts`) is a JS built-in, not a package.
- Pure functions only — given inputs, return deterministic outputs.
- All thresholds and weights must be parameterized (not hardcoded).

## Signal Scoring

Priority-weighted average of 6 analysis axes (weights sum to 35 on the default `1Hour` profile):
- Confluence (12): the only rule-based axis — no LLM anywhere in it. **core가 소유한다**
  (`evaluateConfluence`). 연속 35..65는 강세/약세 **가중 지표 계열** 비율의 축소값이고
  (타입 수가 아니다 — 36종은 지표 14개의 변형이라 타입을 세면 같은 종가의 변형을 독립
  투표로 취급한다), 진입 룰이 정확히 성립하면 ≥92, 약세 역이면 ≤8로 스냅된다. 92는 단독으로
  매수 임계를 넘지 못하도록 고른 값이다: 트리거 + 나머지 중립 = 64 → hold.
  `expected` phase는 반표(위치 상태와 확정 교차를 같은 무게로 셀 수 없다).
  진입 트리거에는 **상위 시간축 정렬**과 **거래량 확인**이 추가로 걸리고, 청산에는 걸리지
  않는다 — 둘 다 트리거를 어렵게 만드는 조건이라 청산에 걸면 원칙 7 위반이다.
- Technical (8): the **mean of three readings** — (1) strength-weighted `indicatorResults`
  aggregate, (2) confidence-weighted aggregate of `patternSummaries` + `strategyResults` +
  `candlePatterns` (`safeAnalysisPatterns`; `detected: false` items abstain), (3) the LLM's overall
  `trend` — each mapped to 50 ± 35. Then riskLevel (±10) + `entryRecommendation`
  (enter +10 / wait −6 / avoid −12).
  Two of those three were dead before: the pattern trio was never wired (core computes
  `confidenceWeight` for it), and `trend` was reachable only when `indicatorResults` was empty,
  which core's required-field schema prevents. The consequence was that **entries scored off
  signal counts while exits read the overall verdict** — one analysis, two different bases.
  The recommendation modifier was ±20~25, i.e. 64% of the ±35 indicator span, so one literal
  could invert the whole aggregate and an all-neutral symbol landed at 45 instead of 50
  (making buys need +25 and sells only −15). `avoid` is now an entry gate
  (`entry_not_recommended`), not a score penalty.
- News (6): overallSentiment (bullish 80 / neutral 50 / bearish 20)
- Options (5): directional (bullish/bearish) signal ratio with shrinkage (pseudo-count k=1) so a lone signal doesn't snap to 0/100; neutral/volatility kinds ignored
- Fundamental (4): mean of `categoryAssessments` sentiments (continuous, 50 ± 30), falling back to overallSentiment when no categories exist
- Congress (**0**): `overallSentiment` through the same `scoreSentiment` as news. 축은 계산되지만
  점수에는 투표하지 않는다 — 프로덕션 실측 31/31 전부 `bullish`(분산 0)라 투표가 아니라 상수
  가산점이었다. 근거는 `types.ts`의 `DEFAULT_WEIGHTS` 독스트링.

**Confluence can block a buy but never a sell.** Adding a sixth axis widens the denominator, which
raises the buy *and* sell thresholds symmetrically. The first half is the point; the second half is
a defect — a missed buy is opportunity cost, a missed sell is a realized loss, the same asymmetry
the AI sizing gate encodes as entry fail-closed / exit fail-open. Concretely: news and fundamentals
collapse to a 25/100 composite (sell) while the drop is not in the price yet, so short-horizon
indicators still read favorably (confluence 65) → 38.7 → hold. `evaluateExistingPosition` does not
catch it (`technicalTrend` is not bearish yet), `fixed_exit_enabled` is off by default, and
`confluenceExit` is false, so the signal sell was the only exit and confluence just closed it. So
`scoreSignals` re-scores without confluence and keeps `sell` when that verdict was `sell`.
Confluence dragging a score *down* into a new sell is still allowed — making exits easier needs no
guard. See design §2.4-a.

**Confluence and congress are conditional voters**: when the input is `null` their weight drops to
0 and leaves the denominator entirely. Most symbols have no congressional disclosure, and a symbol
whose bars FMP could not serve has no snapshot — in both cases a constant neutral 50 carrying real
weight would drag every other axis toward 50 and make the system *less* decisive for both entries
and exits. The other four always produce a number, so they always vote.

## Position Re-evaluation Priority

When evaluating an existing position, checks fire in this order:
0. `PositionEvaluation.structural` marks the four *structure-broken* exits (분석 손절가, 지지선,
   추세 반전, 하락 컨플루언스, 뉴스 악재). They label as `take_profit` in a profit zone — that
   label exists to keep stop-loss history and the re-entry cooldown clean, **not** to say a
   target was met — so `execute.ts` passes `structural` to the sizing gate instead of the label.
   Without it the prompt reads `트리거 종류: 익절` and sizes a broken position as "trim a little,
   let the rest run".
1. Fixed stop loss % breach → stop_loss (**only when `fixedExitEnabled` is true**) — `hard: true`
1.5. 분석 손절가 이탈 (`aiStopLoss`) → stop_loss (always active)
2. Price below key support level → stop_loss (always active)
3. Technical trend reversal (bearish) → take_profit if in profit, stop_loss if in loss (always active)
4. Bearish indicator confluence (`confluenceExit`: 3+ bearish types, ≥1 fresh, close < MA50) →
   take_profit if in profit, stop_loss if in loss (always active). **`hard` is deliberately unset** —
   this is an indicator judgment, not an absolute risk limit, so the sizing gate decides how much to
   cut. It sits *behind* the trend reversal so it never re-handles a case step 3 already caught.
5. Fixed take profit % reached → take_profit (**only when `fixedExitEnabled` is true**)
5.5. 분석 익절가 도달 (`aiTakeProfit`) → take_profit (always active)
6. Approaching resistance (±2% **밴드**) or target price (95%, 상한 없음) → take_profit (always active).
   저항선만 상한이 있다 — 목표가 위는 "도달"이지만 저항선 위는 "돌파"이고 그건 파는 이유가
   아니다. 5·5.5·6번이 **손실 구간**에서 서면 `structural: true`가 붙는다(사유는 0번 참고).
7. Bearish news + non-bullish trend + profit zone → take_profit (always active)
8. None of the above → hold

`aiStopLoss` / `aiTakeProfit` come from `actionRecommendation.stopLoss` / `takeProfitPrices[0]`
(`safeAnalysisStopLoss` / `safeAnalysisTakeProfit`, core's `reconciledLevels` winning when
present — a value core judged invalid must not liquidate a position). They sit directly behind
their fixed counterparts: **운영자가 그은 선 → 분석이 그은 선 → 간접 신호**. Being explicit prices
they use no 95%/98% approximation, and they leave `hard` unset like every other
analysis-derived branch. Until they were wired in, `fixed_exit_enabled` defaulting off meant
every active stop path was indirect (support break, trend reversal, bearish confluence) even
when the analysis had named a stop price.

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
