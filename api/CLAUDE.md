# api/ — HTTP handlers (dashboard REST API + cron)

Web-standard `(Request) => Response` handlers. They are **not** a filesystem router: `server/app.ts`
imports each named export and mounts it on a Hono route (`app.get('/api/health', fwd(healthGET))`),
and node-cron calls the cron handlers in-process. A new file is invisible until it is mounted there.

## Handler Pattern

Handlers use the standard Web `Request`/`Response` API, exported as **named HTTP-method
functions** (`GET`, `POST`, …). Do NOT use `export default` — `server/app.ts` imports by method
name, and unit tests do the same (`(await import('../status')).GET`). The convention outlived
Vercel, where a default export was silently treated as the legacy `(req, res)` Node signature.

```typescript
async function handler(req: Request): Promise<Response> {
    // req.method dispatch happens inside; the same handler can back multiple methods
    return Response.json(data);
}
export const GET = handler;   // add `export const POST = handler;` for multi-method routes
```

Single-purpose routes can also export the method function directly
(`export async function GET(req: Request) { ... }`).

## Authentication

- **Dashboard routes**: `isAuthenticated(req)` is async (`Promise<boolean>`) and evaluates, in order:
  1. `DISABLE_AUTH=true` in a non-production environment → pass (ignored in production).
  2. A `trader_session` cookie resolving to a live session row → pass. **This is the primary path.**
     Lookups are cached in-process for 5s because the dashboard polls several endpoints every 10s.
  3. `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` set *and* a valid `Cf-Access-Jwt-Assertion` → pass.
     Kept so the app works while Cloudflare Access still fronts the origin.

  Returns 403 on failure. There is **no `cf-access-authenticated-user-email` header-trust
  fallback** — with Access removed the origin is directly reachable and that header is forgeable.
- **Caller identity**: `getSessionUser(req)` returns the `SessionUser` behind the cookie, or `null`.
  It ignores `DISABLE_AUTH` on purpose (a flag cannot conjure an identity); `api/auth/me.ts` layers
  a clearly-labelled `DEV_BYPASS_USER` on top for local development only.
- **Auth routes** (`api/auth/*`): unguarded by design — the login form has to be reachable while
  logged out. `login.ts` is throttled to 10 failures per client per 15 minutes.
- **Cron routes**: `verifyCronSecret(req)` checks `Authorization: Bearer <CRON_SECRET>` header
  with a constant-time compare. Returns 401 on failure; a missing `CRON_SECRET` fails closed.
- **`health`**: the shallow check is unauthenticated (uptime monitoring). `?deep=true` is **not** —
  it returns consistency alert strings carrying symbols and idempotency keys, and each call scans
  24h of `order_tracking`/`trades`. Its `version` is the deployed image tag (`APP_VERSION`).

## Config POST Security

The config endpoint uses an allowlist (`ALLOWED_CONFIG_KEYS`) to prevent arbitrary key writes. Numeric keys are bounds-checked (0 to 1,000,000).

Allowed keys: `trading_mode`, `trading_enabled`, `max_position_size`, `max_total_exposure`,
`stop_loss_percent`, `take_profit_percent`, `buy_threshold`, `sell_threshold`,
`analysis_timeframe`, `score_weights`, `fixed_exit_enabled`, `max_trades_per_day`,
`max_daily_loss_usd`, `entry_window`, `execute_interval_min`, `entry_cooldown_min`,
`min_stop_room_pct` (0~5, 퍼센트; 0이면 진입 손절-여유 가드 off),
`min_rr` (0~10; 0이면 손익비 가드 off), `dry_run_cash_usd`,
`confluence_min`·`confluence_exit_min` (각 1~14, **서로 독립** — 원칙 7),
`confluence_span` (0~50), `confluence_expected_weight` (0~1),
`confluence_htf` (`analysis_timeframe`보다 상위여야 하며 `off` 가능 — 양방향 교차 검증),
`confluence_require_volume`.

`execute_interval_min` and `entry_window` are **cross-validated**: a combination whose tick set
does not intersect the window (e.g. 60-minute interval — ticks at `:07` only — with an
11:10–11:50 window) makes entries permanently impossible, and the logs would show only
`outside_entry_window`, which is indistinguishable from normal operation.

`execute_interval_min` is an **enum** (`EXECUTE_INTERVALS` = 5/10/15/20/30/60), not a free
number: the runtime gate is `(minute − 7) mod interval === 0`, so a value that does not divide
60 makes the cadence break at every hour boundary. Rejected rather than coerced through
`parseExecuteInterval` — that fallback is runtime defense against a corrupt row, and using it
here would hide the operator's typo (same reasoning as `entry_window`). `entry_cooldown_min` is
a normal numeric key capped at 1440 (one day); 0 turns the cooldown off.

`trading_enabled` / `fixed_exit_enabled` must be booleans; `trading_mode` is checked against
`dry_run` / `semi_auto` / `auto`; `analysis_timeframe` against `15Min` / `30Min` / `1Hour`.
`score_weights` requires `technical` / `news` / `options` / `fundamental` and accepts `congress` /
`confluence` as optional — both were added after the endpoint shipped, so a caller posting only the
original four must keep working, while an object that *does* include them must not trip the
unknown-key check. Present weights are non-negative finite numbers summing above 0, which is what
makes `score_weights.confluence = 0` the documented off-switch for the indicator confluence axis:
it needs no flag of its own.

`entry_window` must be `{ start: 'HH:MM', end: 'HH:MM' }` — exactly those two keys, both parsed by
`lib/strategy/entry-window.ts`'s `parseTimeOfDay` (00:00–24:00, `'24:00'` meaning end of day), with
`start < end` (no midnight wrap). `{ start: '00:00', end: '24:00' }` is the off-switch.
The endpoint **rejects** bad values rather than calling `parseEntryWindow`, which silently falls
back to the default window — that fallback is runtime defense against a corrupt row, and using it
here would hide the operator's typo. The dashboard posts this key from 설정 > 진입 시간 창 (two
`<input type="time">` fields plus an ON/OFF toggle that sends the off-switch), and it pre-checks
`start < end` client-side, so a 400 from here now means a hand-rolled request.

## Market calendar

`isEtRegularSessionOpen` (siglens-core ≥0.44) knows NYSE holidays and 13:00 half days, so the
session gate at the top of every cron now closes the market on Thanksgiving and after an early
bell — **in every mode, dry_run included**. Before 0.44 it read weekday + clock only, and the
`isUsMarketOpen()` broker call in `execute` was the sole holiday defense, which left dry_run and
all five analysis crons running on closed days.

That broker call stays, with a narrower job: **unscheduled closures** (a national day of mourning).
Those cannot be derived from rules and reach core's literal list only when someone updates it, so
the live-order path asks the broker directly. Analysis crons accept the residual risk — a missing
entry costs one day of wasted quota, not a bad trade.

**`reconcile` deliberately has no session gate.** Its job is order aftercare, not market activity:
an order placed Friday afternoon and left unfilled needs its 30-minute timeout processed over a
long weekend, and this cron is the only thing that does it. Gating it on the session would take
the safety net down exactly when it has the most to do.

What it *does* skip on a closed day is the **broker holdings comparison** — and only when there is
nothing to reconcile (no in-flight orders, nothing recovered **and nothing failed to recover** this
run; a failed recovery means the books are already known to disagree). Broker holdings move on
fills, and a closed market has none, so the same question asked 39 times in a day has the same
answer 39 times; each one is a broker API call. The previous session's runs already compared and
the next session's will again, so the skip delays nothing that could have changed. The audit row
records `summary.holdingsCheckSkipped: 'market_closed'` so a quiet day is distinguishable from a
broken check.

## Execute Cron Flow

0. **Interval gate** — node-cron fires every 5 minutes (`2-59/5`, which covers every minute the
   gate accepts; `7-59/5` missed the `:02` slot and left a 10-minute hole at a 5-minute setting); `execute_interval_min`
   (5/10/15/20/30/60, default 10) decides whether this tick actually runs
   (`lib/strategy/execute-interval.ts`). Runs **before** `startCronRun` so skipped ticks leave
   no audit row, and before the lock. A failed config read falls through to the default rather
   than dropping the tick. `?force=1` bypasses it for manual triggering
1. Acquire distributed lock (`cron:execute:lock`, **30min TTL**) — the TTL must exceed the longest
   possible run, or the next tick acquires the lock while this one is still alive and two runs
   place orders against independent exposure/cash snapshots. A **900s hard run deadline**
   (`run_deadline` decisions) bounds the run — checked in the position, watchlist **and the two
   preceding price loops**, since a sustained FMP outage can burn the whole budget on quotes
   alone — and `noOverlap: true` on the node-cron task blocks in-process overlap as a second
   layer. Contention records `status='skipped'`; a lock **backend failure** records
   `status='error'` (`acquireLockDetailed`) — the two are different events and only the latter
   should reach the cron-health alert. Same rule in reconcile and the analysis crons
2. Circuit breaker checks: kill switch → **entry window (ET)** → daily trade limit → daily loss limit (realized + unrealized)
3. Expire old pending orders
4. Fetch live prices for all symbols (FMP quote API, cached per run)
5. Fetch pending submitted orders (for sell-guard checks)
5.5. Load the AI sizing gate config (`analysis_model_config['trade_gate']`, once per run) and
   set the gate cutoff at cron start + 600s
6. Re-evaluate existing positions (dynamic stop/take profit from fresh analysis)
   - `evaluateExistingPosition` receives `aiStopLoss` / `aiTakeProfit`
     (`actionRecommendation.stopLoss` / `takeProfitPrices[0]`, core's `reconciledLevels`
     winning when present) as priorities 1.5 / 4.5 — the only *explicit* exit prices the
     analysis produces. They were prompt-only until now, so with `fixed_exit_enabled` off the
     active stop paths were all indirect (support break, trend reversal, confluence)
   - It also receives `confluenceExit` (`isConfluenceExit(snapshot)`) —
     the bearish inverse of the entry rule, checked right after the technical trend reversal.
     It leaves `hard` unset, so the exit sizing gate still decides how much to cut
   - Skip positions with a sell in-flight (`order_tracking`) **or** queued for approval
     (`pending_orders`, semi_auto)
   - Non-`hold` exits go through the **exit sizing gate** (see below) → `exitQty`; a partial
     exit calls `reducePositionQuantity`, a full one `closePosition`, in all three modes
   - Track stop-loss closures for cooldown — registered on the *trigger*, so a partial
     stop-loss blocks a same-run re-buy just like a full one
7. Recalculate exposure after any closures (using market prices)
8. Score signals for watchlist symbols
   - The **confluence snapshot** (`computeConfluence`, no LLM) is the heaviest axis. 룰·채점은
     **core가 소유**하고(`evaluateConfluence`) trader는 봉만 구해 넘긴다. 본 봉과 상위
     시간축 봉(기본 일봉)을 **동시에** 띄운다 — 순차로 기다리면 FMP가 느려질 때 심볼당 지연이
     두 배가 되고, 두 루프가 순차라 그 지연이 곧 런 마감 안에 평가받는 심볼 수를 깎는다.
     평가받지 못한 보유 종목은 그 틱에 청산 판정 자체가 없으므로 원칙 7에 걸린다.
     상위 봉은 모듈 캐시(성공 1시간 / **실패 5분**)를 타고, 본 봉은 run-scoped
     `confluenceCache`가 두 루프 간에 공유한다. `null` 스냅샷(FMP 장애, 봉 부족, 봉 낡음)은
     가중치를 0으로 떨어뜨릴 뿐 매매를 막지 않는다
   - Technical freshness uses `getAnalysisReferenceTime` (the LLM result's real `source_analyzed_at`, falling back to `analyzed_at`) against a per-timeframe limit from `getTechnicalMaxAgeMs` (`analysis_timeframe`: 15Min→45min, 30Min→90min, 1Hour→2h). Too-old technical analysis is treated as `stale_analysis` (no trade).
9. Make trade decisions (buy/sell/hold/average_in)
   - `planEntry` (not `calculatePositionSize`) computes the budget ceiling from the per-symbol
     cap, the total-exposure cap and — in `auto` only — real buying power. It is the
     `calculatedSize` handed to `makeTradeDecision`. Because it already subtracts
     `existingSymbolExposure`, the old average_in-specific cap block is gone
   - A buy signal with a zero budget is handled **after the kill switch**, not before the
     guards: `symbol_limit_reached` when `limitedBy === 'symbol'` (a full per-symbol cap is a
     normal steady state, no alert), otherwise the '잔고 부족' skipped-trade row + email. Both
     record the real cause in `detail.budget`. Running it earlier meant mailing the operator
     about an unfunded buy on a run that could not have placed an order anyway
   - semi_auto's duplicate-approval guard runs **before** the gate — behind it, every tick
     with an unanswered approval burned a 25s LLM call whose answer was discarded
   - The entry guards share one `isEntryDecision` condition (buy / average_in / unfunded buy):
     - Stop-loss cooldown: skip buy/average_in for recently stop-lossed symbols — the
       zero-budget buy case is included because it decides as 'hold' and would otherwise slip
       past and mail a 잔고 부족 alert for a symbol we refuse to buy anyway
     - `entry_out_of_zone`: live price above `actionRecommendation.entryPrices` max + 1%
       (`exceedsEntryZone`). Upper bound only, fail-open when the analysis carries no zone
     - `entry_poor_rr`: the risk:reward at entry is below `min_rr` (default **1.5**) —
       reward is the **first** upside exit that would fire (analysis take-profit, resistance
       band lower edge, or 95% of target, whichever is nearest), risk is the distance to the
       first stop trigger. Fail-open when either side is unknown. Measured: analysis
       take-profit sat **below** the current price on 11.5% of ticks and resistance on 14.6%,
       so those entries hit their exit the moment they filled. Worse, score and R:R are
       *inversely* correlated — median R:R is 1.27 in the 45-49 score band and **0.00** in the
       65+ band, i.e. by the time the composite says buy, price has passed what the analysis
       was aiming at
     - `entry_no_stop_room`: the entry price sits less than `min_stop_room_pct` (default
       **0.5%**) above `max(supportLevel, aiStopLoss)` (`hasStopRoom`). Fail-open when the
       analysis carries neither level. **Not the same layer as `entry_out_of_zone`**: that one
       asks "are we paying more than the analysis said", this one asks "is the stop outside the
       noise band". The three losing entries of 2026-08-19~20 passed the first and failed the
       second (여유 0.03~0.2%)
     - `entry_not_recommended`: the analysis says `entryRecommendation: 'avoid'`. Enforced here
       rather than as a score penalty, and `entry_out_of_zone` cannot substitute — core fills a
       *contingent* `entryPrices` range even on `avoid`, usually **above** the current price
     - `entry_cooldown`: this symbol had any real fill (buy **or sell**) inside
       `entry_cooldown_min` (default 60). Counting sells is what stops a re-buy minutes after a
       stop-loss — `recentStopLossSymbols` is run-scoped and resets on the next tick. Reads
       `getRecentTrades(db, 200)` once per run; `mode: 'skipped'` rows are not fills
     - `entry_after_exit_blocked`: this run already reduced the position
   - Pending sell guard: skip sell if submitted sell order exists
   - Re-check kill switch before each trade
   - Every score-based decision (incl. hold) persists a `reason` + `detail` audit (`scoreDecisionDetail`: component breakdown, raw signal, active thresholds, `source_analyzed_at`) so a held/executed decision can be explained after the fact
10. **Sizing gate** — last, after every guard above, so an LLM call only happens on a path that
    is actually going to place an order (see below)
11. Execute per mode:
    - `dry_run` → DB transaction (trade + position atomically)
    - `semi_auto` → pending order + email notification
    - `auto` → order tracking + Toss API + DB transaction + email
12. Release lock in `finally` block

## AI Sizing Gate

`lib/analysis/trade-gate.ts` answers one question per order — *how large* — and returns a
`fraction` that `lib/strategy/trade-plan.ts` turns into a share count. Design:
[`docs/specs/2026-08-12-ai-trade-gate-design.md`](../docs/specs/2026-08-12-ai-trade-gate-design.md) §8–9.

The gate runs with **reasoning on** and a **120s** per-call timeout (2026-08-17). It is the only
place where the six axes, the account state and the budget are weighed together, so the review that
produces the fraction is worth paying for; the total is bounded by the gate deadline (cron start +
600s), not by this timeout. It was 25s with reasoning off, which would now abort mid-thought — and
a gate abort is expensive in both directions (entry fails closed, exit fails open).

`runTradeGate` **never throws**; branch on the returned `status`, never wrap it in try/catch.
Config comes from `analysis_model_config['trade_gate']`, which defaults to enabled — the gate
is live on deploy, and switching it off in 설정 > 분석 설정 restores the old behavior with no
redeploy.

| Situation | Entry (fail-**closed**) | Exit (fail-**open**) |
|---|---|---|
| Gate OFF | `fraction = 1`, no email | `fraction = 1`, no email |
| LLM error / timeout / bad JSON | no order, `gate_error` + email | full exit + email |
| Past cron start + 600s | no order, `gate_skipped_deadline` + email | full exit + email |
| `fraction = 0` | `entry_deferred`, no email | `exit_deferred`, no email |
| `PositionEvaluation.hard` | — | gate not called at all, full exit |

The asymmetry is deliberate: a missed buy is a lost opportunity, a missed sell is a realized
loss. Missing analysis axes are passed to the gate as `result: null` rather than dropped — the
prompt prints "데이터 없음" on purpose. In the re-evaluation loop the three extra axes
(options/fundamental/congress) are read **only** when the gate is actually going to be called.

The confluence snapshot is handed to the gate as an analysis axis too, **first** in `ANALYSIS_ORDER`
(label `지표 컨플루언스 (규칙 기반)`), and its component score leads the `구성요소 점수` block. It
carries `modelId: 'rule-engine'` and the bar time as `analyzedAt` — it is not LLM output, and the
prompt says so, telling the model to weigh it more heavily when the axes disagree. It comes from the
same run-scoped cache as the scoring path, so entering the gate costs no extra fetch.

Decision actions from the entry guards: `entry_out_of_zone`, `entry_no_stop_room`,
`entry_cooldown` (all carry a `detail` block naming the price/zone, the stop room and its
trigger, or the last fill time, so "why didn't it buy" is answerable after the fact). Gate-related actions: `entry_deferred`, `exit_deferred`, `gate_error`, `gate_skipped_deadline`,
`exit_already_handled` (the re-evaluation loop already sold this symbol this tick),
`entry_blocked` (a risk breaker is up and this symbol's signal is not a sell).
Every decision the gate took part in carries a `detail.gate` block (`kind`, `source` of
`ai`/`disabled`/`hard`/`error`/`deadline`/`risk_halt`, `model`, `fraction`, `confidence`,
`reason`, `fullBudget`, `trancheBudget`, `limitedBy`, `quantity`) merged alongside
`scoreDecisionDetail`. `source: 'risk_halt'` means a tripped loss breaker forced a full exit
without asking the model. Branches that end **without** a trade (rejected, not sellable,
needs_review, already_closed, pending/partial, mid-loop kill switch) carry the same block
plus a `detail.order` sub-block (`intendedQty`, `submittedQty`, broker status/reason) — the
gate's sizing decision has to survive a broker rejection to be auditable.

**One symbol is never sold twice in a tick.** The re-evaluation loop records every symbol it
acted on; the watchlist sell path skips those with `exit_already_handled`. The two loops also
use distinct idempotency keys (`…-reeval-sell` vs `…-signal-sell`) since a partial exit leaves
a position behind and `order_tracking.idempotency_key` is unique.

**게이트 호출 원문은 `trade_audit`에 남는다.** `runTradeGate`의 결과에 실린
`transcript`(system/user 프롬프트 + 파싱 전 응답 원문)를 호출 **직후** 적재한다 — 주문 성사
여부와 무관하게. 트레이드 행에 매달면 fraction 0·게이트 오류·브로커 거절처럼 주문이 안 나간
호출이 통째로 사라지는데, "왜 안 샀나"를 되짚을 때 필요한 게 정확히 그 행들이다.
`cron_decisions.detail.gate`는 *결론*(fraction·confidence·reason)을 남기고 이쪽이 *입력*을
남긴다 — 수 KB짜리 프롬프트를 모든 결정 행의 jsonb에 넣지 않으려는 분리다.
적재 실패는 삼키고(`auditGate`의 자체 try/catch), **await하지 않는다** — 이 호출은 게이트
응답과 주문 사이에 있고, 청산 경로에서는 그 사이가 곧 손절이 나가기까지의 지연이다(원칙 7).
`(cron_run_id, symbol, kind)`는 유일하지 않으므로(재평가 청산이 미뤄지면 같은 런에서 시그널
매도가 같은 심볼을 다시 태운다) 게이트에 넘긴 `correlation_id`를 같이 저장한다.

**매수 가능 현금은 세 모드 모두 같은 뜻의 숫자다 — "지금 쓸 수 있는 돈".**
계산은 `api/_lib/cash.ts`의 `getAvailableCashUsd` 하나뿐이고 **execute cron과
`/api/status`(대시보드 `보유 현금`)가 그 함수를 공유한다.** 두 벌로 두면 화면에 찍히는
현금과 실제 사이징이 쓰는 현금이 조용히 갈라진다 — 대시보드가 "$4,500 있음"이라 하는데
주문은 다른 예산으로 나가는 상태가 된다.

| 모드 | 출처 | 조회 실패 시 |
|---|---|---|
| `auto` | 브로커 실잔고 `getBuyingPower('USD')` | `null` → **fail closed** (그 런의 매수 전부 skip) |
| `semi_auto` | 같음 — 승인 시점에 실주문이 나가므로 실계좌 현금으로 사이징해야 한다 | `null` → 클램프 없음 (승인이라는 사람 게이트가 뒤에 있다) |
| `dry_run` | `dry_run_cash_usd`(예치금, 기본 $5,000) + **체결 원장 순현금흐름** | 원장 조회 실패 → 흐름 0, 예치금 그대로 |

`dry_run` 잔고는 컬럼에 저장하지 않고 `trades`에서 도출한다(`getDryRunCashFlowUsd`) —
저장 잔고는 갱신 누락·롤백으로 원장과 어긋날 수 있고 한 번 틀어지면 스스로 복구되지 않는다.
매도가 현금을 되돌려주므로 **손익이 그대로 반영된다**: 이익 난 계좌는 현금이 예치금을 넘는다.

**노출을 따로 빼지 않는다.** 매수는 원장에서 이미 차감됐고 노출은 그 현금이 형태를 바꾼
것이다. 둘 다 빼면 같은 돈을 두 번 센다 (예치금 $5,000 → $1,000 매수 → 현금 $4,000 +
노출 $1,000 = 총액 $5,000). 런 안에서는 매수마다 차감한다 — 그러지 않으면 한 런의 매수 여러
건이 전부 같은 잔고를 보고 승인된다.

종전 `dry_run`은 `null`이었고, 그 결과 두 가지가 동시에 죽어 있었다: 게이트 프롬프트에
"매수 가능 현금: 미상"이 찍혀 사이징의 1차 제약이 모델에게 안 보였고, `planEntry`의 현금
클램프도 걸리지 않았다.

**프롬프트의 현금 줄은 모드별로 갈리지 않는다.** 출처는 바로 위 `매매 모드` 줄이 이미
말하고, 문구를 갈라 두면 같은 결정에 서로 다른 사이징 습관이 붙는다. 이제 `미상`은
"조회하지 않는 모드"가 아니라 **조회 실패**를 뜻한다.

> **운영 주의 — Toss는 IP 허용목록을 쓴다.** 로컬에서 `/oauth2/token`을 호출하면
> `403 access_denied / "IP address not allowed"`가 난다(2026-08-22 확인). 프로덕션 EC2의 IP만
> 등록돼 있다는 뜻이고, **그 IP가 바뀌면(인스턴스 교체·EIP 변경) `auto`는 매 런 fail closed로
> 매수가 전부 막힌다.** 증상은 `skipped_no_buying_power` 감사 행뿐이라 조용하다.
> 실거래 전환 전에 EC2에서 `getBuyingPower('USD')`가 실제로 값을 내는지 확인할 것.

**Gate OFF is not byte-identical to the pre-gate build.** `planEntry` clamps the budget by
real buying power (`auto` only), which `calculatePositionSize` never did — e.g. price $100 /
cash $250 used to be `skipped_insufficient_cash` (no order) and now buys 2 shares. This is
intentional (fewer broker rejections) and applies with the gate off too.

**노출 한도는 투입 원가 기준이다 (2026-08-17 변경).** `existingSymbolExposure`와
`currentExposure`는 `avgPrice × quantity`, 즉 **투자 금액**이다. 종전에는 `currentPrice ×
quantity`(평가액)였는데, 그러면 가격이 내릴수록 남은 예산이 커진다: 한도 $1,000에 $100로 10주를
산 뒤 주가가 $50이 되면 평가액 $500 → "예산 $500 남음"이 되어 10주를 더 살 수 있고, $25에서
반복하면 한도 $1,000짜리 종목에 원가 $2,000 이상이 들어갔다. 한도가 실제로 아무것도 한정하지
못한 것이다. 설정 라벨("종목당 최대 **투자 금액**")과도 어긋났다.

부수 효과로 노출 계산 루프의 시세 조회가 사라졌다 — 원가는 DB에 이미 있다. 청산 시에도 판
가격이 아니라 그 주식의 **원가**만큼 노출을 줄인다. 미실현 손익 차단기는 별개다: 그쪽은
평가액을 봐야 하므로 여전히 실시간 시세를 쓴다.

## 수동 청산 / 승인 (dashboard 경로)

`POST /api/positions/:id/close`는 **`dry_run`이 아닌 모든 모드에서 브로커 주문을 낸다.**
`semi_auto`도 승인 경로(`shouldPlaceLiveOrder = semi_auto || auto`)가 실주문을 내므로 그 모드의
포지션은 실계좌에 실재한다 — DB만 닫으면 손절·강제청산 어디에도 닿지 않는 유령 보유가 된다.
같은 이유로 이 엔드포인트는 execute의 매도 경로와 같은 가드를 갖는다: 같은 심볼의 in-flight
매도(`submitted`/`pending`/`partial` — **`error`는 제외**, 결말 미확정 한 건이 30분 동안 수동
청산을 막는 것은 원칙 7 위반이다)가 있으면 409, `getSellableQuantity` 클램프, 그리고 체결
확정(`filled`) 기록은 booking 트랜잭션 **안에서** — 밖에 두면 booking이 경합으로 롤백됐을 때
"trade 없는 filled" 행이 남고 reconcile 자동 복구가 그 행을 근거로 다른 포지션을 건드린다.

매도가능 수량이 0이면 409지만, 브로커에 실제로 없는 유령 행을 정리할 길이 막히므로
`{ "force": true }`가 **주문 없이 장부만 닫는** 관리자 경로로 남아 있다(거래 사유에 명시된다).

`POST /api/approve/:id`:

- 기록되는 `mode`는 **실제 `trading_mode`**다. dry_run 승인을 `semi_auto`로 남기면 시뮬레이션
  손익이 `getTodayRealizedPnl`에 섞여 실계좌 손실 차단기를 오염시킨다.
- 매도 승인도 `getSellableQuantity`로 클램프한다 — 대기 주문은 큐잉 후 승인까지 최대 15분이
  비고, 그 사이 execute가 같은 포지션을 부분 청산했을 수 있다.
- 주문 호출이 **던지면 대기 주문을 되살리지 않는다.** 예외는 "주문이 나가지 않았다"가 아니라
  "결말을 모른다"이고, 토스 멱등키는 10분만 유효해 그 뒤의 재승인은 새 주문으로 처리된다.
  확정은 reconcile이 브로커에 물어서 한다.

## Reconcile Cron Flow

1. Acquire lock (`cron:reconcile:lock`, 5min TTL)
2. Query all `submitted` orders from `order_tracking`
3. For orders older than 30 minutes: cancel at the broker **first**, then mark `timeout` + email
   (urgent for sells). This holds on the broker-poll-failure path too: a failed `getOrder` says
   nothing about whether the order is still live, and a terminal `timeout` takes it out of the
   in-flight set forever — a later fill would never reach the books and the next execute tick
   would place a second order. A failed cancel keeps the row in flight (`cancel_failed`) and is
   retried, but only for 6 hours: past that the row moves to `needs_review`, because a cancel
   that has failed for a whole session will not start working, and an eternal in-flight row
   blocks that symbol's entries forever while mailing every 10 minutes
4. Run DB consistency check (`checkConsistency`) — find filled orders without matching trades
5. If inconsistencies found, send alert email

`autoRecoverFilledOrders` only scans `status = 'filled'`, so a recovery that cannot succeed
(no fill price, a position update that matches no rows, or a position **opened after the order
was submitted** — a re-entry, not the shares that order sold) is moved to `needs_review`. Left at
`filled` it would be retried every 10 minutes for 24 hours and mail the operator each time.

## Circuit Breakers

| Breaker | Config Key | Default | Behavior |
|---------|-----------|---------|----------|
| Entry zone | — (analysis-driven) | +1% over `entryPrices` max | Blocks buy/average_in only — `entry_out_of_zone`. Not a breaker row in the audit: it is per-symbol, so it decides inside the watchlist loop rather than setting `entryBlock` |
| Risk:reward | `min_rr` | 1.5 | Blocks buy/average_in only — `entry_poor_rr`. Per-symbol. Fail-open when upside or downside is unknown. 0 disables |
| Stop room | `min_stop_room_pct` | 0.5% above `max(support, aiStopLoss)` | Blocks buy/average_in only — `entry_no_stop_room`. Per-symbol, same as above. Fail-open with no support/stop level. 0 disables |
| Re-entry cooldown | `entry_cooldown_min` | 60 min | Blocks buy/average_in only — `entry_cooldown`. Per-symbol, same as above. 0 disables |
| Entry window | `entry_window` | ET 11:00–15:00 | Blocks entries only — `entry_blocked`, `CronOutcome: outside_entry_window`. **Not a risk breaker**: no email, no `forceFullExit`, and the exit sizing gate keeps sizing normally. Evaluated *before* the two below so a risk cause overwrites it in the audit row |
| Kill switch | `trading_enabled` | `true` | **Halts everything, exits included.** Re-read before each trade *and again right after the gate answers*, in both loops |
| Daily trade limit | `max_trades_per_day` | `20` | Blocks entries only — `entry_blocked`. Position exits and watchlist **sell** signals still run, gate-sized |
| Daily loss limit | `max_daily_loss_usd` | `500` | Realized + unrealized (live prices). Blocks entries **and forces every exit to full size** (gate bypassed, `source: 'risk_halt'`) |

**A risk breaker stops new risk, never risk reduction.** Blocking liquidation would be a
bug, not a safety net: with split exits the gate can defer a sell indefinitely, so an early
`return` on the loss breaker would mean the position is never stopped out at all — the
breaker would cap nothing while the loss kept growing. So the loss/trade breakers set an
internal `entryBlock` instead of returning, and the loss breakers additionally force
`hard`-style full exits.

Three consequences that are easy to get wrong, and were:

- **The watchlist loop still runs.** Only symbols whose signal is not `sell` short-circuit
  with `entry_blocked`. `evaluateExistingPosition` is *not* a superset of the sell signal —
  it reads the technical trend and news sentiment only, while `scoreSignals` also weighs
  options/fundamentals/congress — so a neutral-trend position with a 25/100 composite score
  holds in the re-evaluation loop and would otherwise have no exit path at all. The in-loop
  `max_trades_per_day` re-check exempts sells for the same reason.
- **A forced exit survives missing analysis.** Under `forceFullExit` the staleness guard is
  skipped and the position is sold whole without consulting `evaluateExistingPosition` or the
  gate. The gate and the technical cron share one LLM provider, so the outage that makes the
  gate defer is the same outage that makes every symbol stale, and `fixed_exit_enabled`
  defaults off — bailing on staleness meant selling nothing exactly when it mattered. No
  stop-loss/take-profit label is invented from analysis known to be stale.
- **No price → mode-dependent.** `auto` sends a market order and liquidates anyway; `dry_run`
  (books at `currentPrice`) and `semi_auto` (queues a price limit) cannot, so they skip with
  `skipped_no_price` + `detail.forcedLiquidationBlocked` **and an email** saying the forced
  liquidation could not be carried out.

"Every exit" is literal and includes the **watchlist signal sell**: under `forceFullExit` that
path skips `runTradeGate` entirely and passes `hard: true` to `planExit`, exactly like the
re-evaluation loop (`source: 'risk_halt'`). It has to — for a position the rule engine holds and
only the composite score wants sold, it is the *sole* remaining exit route, so letting the model
size it meant a `fraction: 0` could defer the last risk-reduction path indefinitely while the
loss limit was already breached.

A tripped loss breaker therefore liquidates a stale/priceless position whole, while a position
with fresh analysis evaluating to `hold` **and** scoring above the sell threshold is left alone.
That is one rule, not an asymmetry: **평가 가능하면 평가를 따르고, 불가능하면 나간다.**

- The daily loss limit means "take no more risk today", not "flatten the book" — liquidating
  healthy positions on a trip would realize losses for nothing.
- With fresh analysis the evaluation is trusted; what changes is that a triggered exit is
  upsized to the full position. There is a basis for judgment, so it is used.
- With stale analysis or no price there is **no evaluation possible at all**. Holding a
  position you cannot evaluate while already past the risk limit is the more dangerous of the
  two, so it is closed out.

The price feeding the unrealized-PnL breaker is **cross-checked against the technical
snapshot** (the confluence snapshot's last-bar `close`): if the live FMP quote diverges from it by more than **25%**,
the snapshot price is summed instead, and one batched `시세 출처 불일치` mail per run lists every
affected symbol (per-symbol mails would arrive ~8×/day for the whole duration of a real gap).
`fetchLivePrice` only checks "finite positive", and a wrong tick now liquidates the whole book
rather than merely halting trading.

**This guard did not run at all until 2026-08-17.** Its snapshot side read
`keyLevels.currentPrice`, a field siglens-core does not have (`KeyLevels` is
`{ support, resistance, poc }`, and `normalizeKeyLevels` rebuilds the object from exactly those
three keys), so `snapshotPrice > 0` was never true. The source is now the confluence snapshot's
`close` — FMP OHLC, which is the comparison this paragraph always described. It also restores the
analysis fallback price: before, a failed FMP quote meant `skipped_no_price` for that symbol with
no second source.

**What this guard does and does not buy — the two sources are not independent.** Both come from
FMP (quote endpoint vs OHLC through `getMarketDataProvider`). It
therefore catches the dominant failure, a single bad quote tick, and catches **nothing**
vendor-wide: a symbol-mapping error, an unadjusted split or a currency mixup corrupts both values
together and sails through. A genuinely independent check would use the Yahoo provider already in
`lib/data/`; that is a follow-up, not something this guard delivers.

Two properties matter more than the threshold:

- **Substitute, never exclude.** Dropping a suspicious position from the sum always
  *understates* the loss and so delays the breaker — trading a wrong liquidation for a blunted
  risk control. Priority is live → snapshot → `avgPrice` (the last yields unrealized 0, the
  neutral "unknown", not a claim of "no loss").
- **The yardstick is the snapshot, not `avgPrice`.** The entry price can be weeks old, so an
  entry-relative band flags a position genuinely down 70% on *every* run and silently
  under-counts it. Two same-vendor sources normally differ by a fraction of a percent, which
  is why 25% is both safe and far tighter than an entry-relative band could ever be.

**One run can value the same position at two different prices, on purpose.** The aggregate
breaker uses the price chosen above (possibly the snapshot); the per-position exit decision uses
`priceCache`, i.e. the live quote. On a real -30% gap the breaker is therefore blunt for up to one
analysis cycle while the stop-loss path fires normally on the live drop. The blunt side fails
toward doing nothing destructive, which is the right direction — but it will confuse someone
reading two different unrealized numbers in one run, so it is stated here.

The unrealized breaker runs in **`dry_run` too** — a simulation that behaves differently from live
is worthless as a rehearsal — so its alerts name the mode and say the figures are simulated,
keeping a rehearsal from reading as a live incident.

The kill switch is the one exception and still stops everything: it is not a risk breaker
but the operator's explicit "touch nothing" (e.g. they are about to trade the account by
hand), and halting every order on it is the pre-existing contract. Because of that, the
breaker alert text is mode-aware (`auto` sells / `semi_auto` only queues an approval /
`dry_run` only simulates) instead of promising a liquidation that will not happen.

The response and audit row when a breaker trips:

- **Nothing held** → unchanged: `{ skipped: true, reason: 'daily_loss_limit_reached' | 'daily_trade_limit_reached', … }`, `cron_runs.status='skipped'`.
- **Positions held** → the run proceeds exit-only. Response gains `exitOnly: true` +
  `entriesBlockedBy`; `cron_runs.status='completed'` with the breaker's **existing** outcome
  (`daily_loss_limit` / `daily_trade_limit` — no new `CronOutcome` values) and
  `summary.exitOnly` / `summary.entriesBlockedBy` / `summary.exitsForcedFull`.

`max_trades_per_day` interacts badly with split entries: one target position now takes
several fills instead of one (a `fraction 0.3` ladder to a 20-share target is ~9 trades,
not 1), so the default 20 can be spent on three symbols. Review the setting upwards when
turning the gate on — the limit is deliberately left as the operator's own knob.

## 매매 실행 주기 (execute_interval_min)

가격 조건 — 진입 구간, 손절선, 익절선 — 은 전부 `execute` 틱 안에서만 판정된다. 그래서 이 간격이
곧 **반응 지연의 상한**이다. 종전 `7 13-21` 스케줄은 하루 6틱(진입 창 안은 4틱), 즉 최소 60분
간격이었고, 손절선이 뚫려도 최대 60분 방치됐다.

cron은 5분마다 핸들러를 부르고, 실제 실행 여부는 `lib/strategy/execute-interval.ts`의 게이트가
`config.execute_interval_min`(5·10·15·20·30·60, 기본 **10**)으로 정한다. 스케줄 문자열을 설정으로
만들지 않은 이유는 node-cron 태스크가 등록 시점에 고정되기 때문 — 게이트는 대시보드에서 바꾼
즉시 다음 틱부터 먹는다. **설정 > 매매 실행 주기**.

- 허용값이 60의 약수뿐인 이유: 게이트는 `(분 − 7) mod 간격 === 0`이라, 약수가 아니면 시(hour)
  경계에서 주기가 어긋난다. 60분 설정은 종전 스케줄과 실행 시각이 분 단위로 같다.
- 게이트는 `startCronRun`보다 **앞**이다 — 건너뛴 틱까지 감사 행을 남기면 하루 78행 중 6행만
  실제 실행이라 `cron_runs`가 잡음으로 덮인다. `?force=1`은 수동 트리거용 우회.
- 설정 조회 실패는 기본값으로 **진행**한다. DB 일시 장애로 매매 틱이 사라지는 쪽이 더 나쁘다.
- 한 틱은 심볼당 FMP 호출 2회(quote + 컨플루언스 봉). 5분으로 줄이면 호출량이 두 배가 된다.

## 진입 품질 가드

실행 주기를 좁히는 것만으로는 **추격 매수**가 남는다. 분석이 "$150 진입"이라 한 뒤 가격이
$180이 돼도, 신선도 한도(1Hour 기준 2시간) 안이면 같은 분석이 그대로 쓰여 매수 신호가 살아
있기 때문이다. 손절선·목표가만 $150 기준인 포지션이 생긴다.

- **`entry_out_of_zone`** — 현재가가 `actionRecommendation.entryPrices` 최대값 + 1%를 넘으면
  매수/추가매수를 건너뛴다(`lib/strategy/entry-zone.ts`). **상단만** 본다 — 구간 아래는 매수에
  불리하지 않다. `entryPrices`가 없으면 통과(fail-open). 사이징 게이트보다 앞이라 어차피 사지
  않을 주문에 LLM 호출을 태우지 않는다. 매도에는 걸지 않는다.
- **`entry_no_stop_room`** — 진입가와 `max(지지선, 분석 손절가)` 사이가
  `config.min_stop_room_pct`(기본 **0.5%**, 0이면 off) 미만이면 매수/추가매수를
  건너뛴다(`lib/strategy/entry-zone.ts`의 `hasStopRoom`). 청산 규칙이 두 레벨을 각각 보므로
  **높은** 쪽이 먼저 걸린다. 레벨이 없으면 통과(fail-open).
  손실 크기를 제한하는 장치가 아니라 **손절선이 노이즈 대역 밖인지**를 보는 장치다.

  **기본값이 0.5%인 이유는 위쪽 경계 때문이다.** siglens-core의 폴백 손절가는
  `진입가 − 1.5×ATR`이라 확보 가능한 여유가 곧 `1.5×ATR/가격`이다. 1%로 잡으면 ATR이
  가격의 0.667% 미만인 종목이 매 틱 영구 차단되는데, 30분봉에서는 흔한 영역이라 게이트가
  아니라 정지 버튼이 된다. 그리고 그 상태는 로그상 `entry_no_stop_room`만 쌓여 **"신호가
  없는 날"과 구분되지 않는다** — 설정 키로 뺀 것도, 상한을 5%로 막아 둔 것도 그래서다.
  `SUPPORT_BREAK_BUFFER`는 여기 관여하지 않는다: 두 상수를 곱하면 한쪽을 조정할 때 다른
  쪽 문턱이 조용히 따라 움직인다.
  실측(2026-08-19~20) 3건이 전부 여유 0.03~0.2%에서 진입해 전건 손실로 끝났다 — 방향이
  틀려서가 아니라 손절선이 호가 스프레드 안이라서 털렸다. `entry_out_of_zone`은 이걸 못
  잡는다: 그 셋은 전부 권장 진입 구간 **안**이었다. 매도에는 걸지 않는다(원칙 7).
- **`entry_cooldown`** — 같은 심볼 재진입 최소 간격(`config.entry_cooldown_min`, 기본 60분,
  0이면 off). 기준은 마지막 **체결**이다 — 매수뿐 아니라 **매도도 쿨다운을 건다.** 매수만 보면
  손절이 마지막 매수보다 쿨다운 뒤에 일어났을 때 손절 10분 뒤 같은 분석으로 재매수가 가능했다
  (`recentStopLossSymbols`는 실행 스코프라 다음 틱에 초기화된다). **설정 > 투자 관리**.
- **`entry_not_recommended`** — 분석의 `entryRecommendation`이 `avoid`면 점수와 무관하게 매수를
  막는다. core는 `avoid`에서도 "돌파 시 진입" **조건부** 구간을 채우므로 `entryPrices` 상단
  검사로는 걸러지지 않는다.
- **`entry_after_exit_blocked`** — 같은 틱에 부분 청산한 종목은 다시 늘리지 않는다.

**노출 한도는 원가(투자 금액) 기준이다.** `max_position_size` / `max_total_exposure`는
`avgPrice × quantity`로 계산한다 — 평가액 기준이면 가격이 내릴수록 예산이 커져 한도가
아무것도 한정하지 못한다.

**물타기는 규칙으로 막지 않는다.** 점수 ≥70 + 6축 합의 + 사이징 게이트를 통과했다면 그것이
이미 AI의 추천이고, 규칙 엔진이 방향만 보고 뒤집는 것은 판단 층을 잘못 고른 것이다. 대신
게이트가 **물타기인 줄 알고** 크기를 정하도록 프롬프트에 성격을 명시한다 — 특히 모델이 계산으로
얻을 수 없는 사실 하나를 못박는다: 고정 손절선은 평단이 기준이므로 추가 매수가
손절선을 함께 내린다 (진입 지침 5번).

익절 트리거가 **손실 구간에서** 서면 `structural: true`가 붙는다 (`aiTakeProfit`·저항선·목표가).
분석이 그은 익절 레벨은 우리 매수가와 무관한 절대 가격이라, 그림보다 비싸게 산 포지션은
미실현 손실 상태에서 그 선에 닿는다. 그때 게이트에 `take_profit` 트리거가 그대로 가면
프롬프트가 "목표 달성형"으로 읽고 일부만 덜어낸 뒤 나머지를 태운다 — 손실 포지션에 정반대
사이징이다. 라벨을 `stop_loss`로 바꾸지는 않는다(재진입 쿨다운·손절 이력 오염).

청산 트리거 자체의 오차도 같이 잡았다 — **지지선 이탈에는 0.5% 버퍼**(`SUPPORT_BREAK_BUFFER`),
**저항선 근접은 ±2% 밴드**다. 종전에는 손절만 오차 0(`< supportLevel`)이고 익절은 2%·5%로
관대해, 그 비대칭이 승률을 깎는 방향으로만 작동했다. 저항선 쪽은 상한이 없어 **돌파를 저항
거부로 오독**했다(실측: 저항 172.33에 현재가 176.375를 "저항선 근접"으로 청산). 목표가는
상한을 두지 않는다 — 목표가 위는 "도달"이지만 저항선 위는 "돌파"라 뜻이 다르다.

**저항선 근접은 `aiTakeProfit`이 없을 때만 발동한다** — 4.5의 폴백이다. 밴드를 씌워도
상수였기 때문이다: `keyLevels.resistance[0]`은 현재가에서 가장 가까운 저항이고 매시간
재계산돼 가격을 따라다녀서, 실측 706틱에서 현재가 대비 중앙 +0.19%(1Hour 실현 이동
중앙값 0.25~0.49%보다 작다)였고 **99.2%의 틱에서 조건이 참**이었다. 결과는 "사자마자
청산"이고 프로덕션에서도 그렇게 났다(2026-09-02 NVDA: 227.53 매수 / 저항 227 / 10분 뒤
227.45 청산). `entry-zone.ts`의 `firstUpsideExit`이 같은 규칙을 미러링한다.

청산 쪽에는 대칭 **진입 게이트**를 두지 **않았다** — 가격 조건으로 매도를 막는 것은 원칙 7 위반이다.
대신 빠져 있던 트리거를 채웠다: `actionRecommendation.stopLoss` / `takeProfitPrices`(core의
`reconciledLevels` 보정값 우선)가 `evaluateExistingPosition`의 우선순위 1.5 / 4.5로 들어간다.
`fixed_exit_enabled`가 기본 꺼짐이라, 그전까지 활성 손절 경로는 지지선 이탈·추세 반전·하락
컨플루언스 같은 **간접** 신호뿐이었다.

설계 근거: [`docs/specs/2026-08-16-execution-cadence-design.md`](../docs/specs/2026-08-16-execution-cadence-design.md),
감사 대응: [`docs/specs/2026-08-17-audit-fixes-design.md`](../docs/specs/2026-08-17-audit-fixes-design.md).

## Entry window (신규 진입 시간 창)

신규 진입은 `config.entry_window`(기본 **ET 11:00–15:00**) 안에서만 열린다. **cron 스케줄은
바뀌지 않는다** — 창은 스케줄이 아니라 진입 게이트다. `execute` cron은 정규장 내내 그대로 돌고,
창 밖에도 포지션 재평가·손절·청산·신호 매도는 전부 정상 동작한다. cron 창을 좁히면 마감 전
손절 경로까지 같이 죽으므로, 원칙 7에 따라 진입만 막는다.

창은 **ET에 고정**한다. 회피 대상(개장 갭, 첫 30분 변동성, 마감 MOC 임밸런스)이 전부 ET 기준
현상이라, UTC/KST에 고정하면 서머타임마다 창이 한 시간씩 밀려 목적이 반년마다 깨진다.

일일 손실/거래 한도가 쓰는 `entryBlock` 메커니즘을 그대로 재사용하되, 창은 리스크 사건이
아니므로 이메일도 `forceFullExit`도 없다. 두 사유가 동시에 성립하면 감사 로그에는 리스크 쪽이
남는다.

**설정 > 진입 시간 창**에서 조정한다. 시간 입력 두 개(ET)와 ON/OFF 토글이며, OFF가 곧
`{ start: '00:00', end: '24:00' }`(= 제한 없음)이다. 재배포도 API 직접 호출도 필요 없다.

`semi_auto` 승인은 창을 다시 보지 않는다 — 대기 주문 TTL(15분)만큼 창을 넘겨 체결될 수 있고,
운영자가 명시적으로 누른 승인을 시간으로 되돌리는 쪽이 더 혼란스러우므로 의도적으로 둔다.
또한 기본 창(ET 4시간)은 실행 주기 10분 기준 하루 39틱 중 24틱만 덮으므로, AI 사이징 게이트의
분할 진입과 겹치면 하루에 도달 가능한 포지션 크기가 줄어든다. 다만 실제 상한을 정하는 것은
`entry_cooldown_min`(기본 60분)이라 심볼당 창 안에서 4회 — 실행 주기 도입 전과 같은 숫자다.
`auto` 전환 시 `max_trades_per_day`와 함께 확인할 것.

설계 근거: [`docs/specs/2026-08-15-entry-window-design.md`](../docs/specs/2026-08-15-entry-window-design.md).

## Quiet hours

No email is sent between **00:00–09:59 KST**; anything raised in that window is queued
(`notification_queue`) and delivered as one summary at 10:00 KST by the `digest` cron. The
window is expressed in the operator's local time on purpose — the point is that they are
asleep, and the US session runs through the middle of it.

The per-event gate still wins over queueing: if the channel or the event is off, nothing is
sent *or* queued, so turning email off really turns it off. If email is off when the digest
runs, queued rows are marked consumed without sending, so a disabled channel cannot grow the
queue without bound. A failed send leaves rows unsent so the next run retries — duplicate
delivery is preferable to a silently lost fill notification.

## Order Lifecycle

```
createOrderTracking(submitted) → API call → updateOrderTracking(filled/rejected/error)
                                                      ↓ (if stays submitted)
                                          reconcile cron → timeout after 30min → email alert
```

## Rules

- Files prefixed with `_` are shared helpers, never mounted as routes.
- Dashboard routes enforce HTTP method (405 on mismatch).
- **There is no platform-imposed run limit** — the process is long-lived, so every bound is one
  the code sets: the analysis cron's 1200s deadline, `PER_SYMBOL_MAX_MS` (150s), execute's 900s
  run deadline, and the Redis lock TTLs. The old `maxDuration: 800` (Vercel Pro) is gone, which
  is why those numbers were re-derived rather than inherited.
- Errors are caught **per symbol** in both the execute cron and the analysis cron — one symbol's
  failure never drops the other symbols' results. The analysis cron additionally runs its symbols
  in parallel (`Promise.all`), so its run time is the slowest single symbol, not the sum.
- Position close uses atomic DB update (`WHERE status = 'open'`) — returns 409 on race condition.
- Execute and reconcile crons use distributed locks (Redis SETNX) — concurrent invocations return `{ skipped: true }`.
- Cron runs write a `cron_runs` audit row (`running` → `completed`/`skipped`/`error`). A row stuck in `running` past `CRON_STALE_AFTER_MS` (45 min — must exceed both the longest run and the analysis lock TTL of 30 min, or the sweeper stomps a live run's row) belongs to an invocation that timed out before writing its finish row; the next cron invocation finalizes it to `error`/`timeout` via `finalizeStaleCronRuns` (never deletes).
- Trade + position mutations are wrapped in DB transactions for atomicity.
- `health.ts` requires no authentication — designed for uptime monitoring services.
