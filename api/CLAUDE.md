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

The config endpoint uses an allowlist (`ALLOWED_CONFIG_KEYS`) to prevent arbitrary key writes. Numeric keys are
bounds-checked (0 to 1,000,000), and strategy keys carry their own ranges (`NUMERIC_BOUNDS`):

| Key | Range / type | Default |
|---|---|---|
| `trading_mode` | `dry_run` / `semi_auto` / `auto` | `dry_run` |
| `trading_enabled` | boolean (kill switch) | true |
| `max_position_size`, `max_total_exposure` | USD, cost basis | 5,000 / 25,000 |
| `max_trades_per_day` | count | 20 |
| `max_daily_loss_usd` | USD — realized + **today's** unrealized change | 500 |
| `execute_interval_min` | **5 or 10** only (the decision window needs ≥ 2 ticks) | 10 |
| `dry_run_cash_usd` | USD | 5,000 (seed 25,000) |
| `mr_rsi_entry` | 1–50 | 10 |
| `mr_max_hold_days` | integer 1–60 | 10 |
| `mr_stop_atr` | 0–20 (0 = no disaster stop) | 5 |
| `mr_regime_filter` | boolean | true |
| `dry_run_cost_bps` | 0–100 (one-way) | 10 |

Retired keys (`buy_threshold`, `sell_threshold`, `score_weights`, `confluence_*`, `min_rr`, `min_stop_room_pct`,
`entry_window`, `entry_cooldown_min`, `fixed_exit_enabled`, `stop_loss_percent`, `take_profit_percent`,
`analysis_timeframe`) are rejected as unknown and their stored rows were deleted by migration 0019.
The endpoint **rejects** bad values rather than coercing them — the runtime readers (`api/_lib/mr-config.ts`,
`parseExecuteInterval`) fall back to defaults only as defense against a corrupt row, and using that fallback here
would hide the operator's typo.

Watchlist cap: **30** (`MAX_WATCHLIST_SIZE`). It was 5 while every symbol cost hourly LLM calls; the rule is
price-only now and AI runs only on signals. Analysis types: `technical`, `news`, `fundamental`, `entry_review`.

## Market calendar

`isEtRegularSessionOpen` (siglens-core ≥0.44) knows NYSE holidays and 13:00 half days, so the
session gate at the top of every cron now closes the market on Thanksgiving and after an early
bell — **in every mode, dry_run included**. Before 0.44 it read weekday + clock only, and the
`isUsMarketOpen()` broker call in `execute` was the sole holiday defense, which left dry_run (and
the analysis crons that existed then) running on closed days.

That broker call stays, with a narrower job: **unscheduled closures** (a national day of mourning).
Those cannot be derived from rules and reach core's literal list only when someone updates it, so
the live-order path asks the broker directly. The review cron has no session gate — it only reads
today's recorded signals, so on a closed day there is nothing to review.

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

Design: [`docs/specs/2026-09-24-daily-mean-reversion-design.md`](../docs/specs/2026-09-24-daily-mean-reversion-design.md) §4.
The handler decides; `api/cron/_orders.ts` executes (dry_run ledger tx / semi_auto approval / auto broker order +
`order_tracking` + partial/rejected/needs_review handling — moved verbatim from the old handler).

0. **Interval gate** — node-cron fires every 5 min (`2-59/5`); `execute_interval_min` (5 or 10) decides whether the
   tick runs. Before the audit row. `?force=1` bypasses it.
1. **Decision tick?** — inside the last 20 minutes before the close (`minutesUntilUsMarketClose`, so early closes
   move the window) on a trading day, **and** no execute run since ET midnight has `summary.decisionPhase = 'done'`.
   A lookup failure counts as "not done": deciding twice is guarded (below), skipping a day is not recoverable.
2. **Idle exit** — not a decision tick and nothing held → return **without an audit row**.
3. Audit row, session gate (`market_closed`), lock `cron:execute:lock` (30 min TTL, 900s run deadline),
   kill switch (stops everything, exits included), expire pending approvals.
4. Quotes (`fetchLivePriceDetail`, with `previousClose`) for held symbols + in-flight orders (+ watchlist + SPY on a
   decision tick).
5. **Breakers** — daily trade limit, realized loss, then realized + **today's** unrealized change
   (`lib/strategy/daily-loss.ts`). A tripped loss breaker blocks entries and sets `forceFullExit`. Breach and
   quote-divergence mails go **once per ET day** (`claimOnce`).
6. Live modes ask the broker for unscheduled closures (`isUsMarketOpen`).
7. Exposure (cost basis + in-flight buys + pending approvals) and cash (`getAvailableCashUsd`).
8. **Risk phase (every tick)** per held position: skip if a sell is in flight or queued for approval; fill an empty
   `stop_price` from daily bars (ATR14 before the entry date × `mr_stop_atr`; bars unavailable → `stop_backfill_failed`
   + one mail per symbol per ET day); no price → `skipped_no_price`
   (auto under the loss breaker exits at market instead: `mr_forced_exit`); price ≤ `stop_price` → full exit
   `mr_stop_atr`.
9. **Decision phase (once a day)** — daily bars for SPY + held + watchlist (`lib/analysis/daily-bars.ts`, today's
   close = live price). Held positions: no live price → `mr_data_error`; bars unreadable → `mr_forced_exit` under the
   loss breaker else `mr_data_error`; otherwise `evaluateRuleExit` → `mr_exit_ma5` / `mr_exit_time` / `mr_hold`.
   Entries: SPY bars **or SPY live price** unreadable with the regime filter on → one `mr_data_error` row, no entries;
   symbols sold today (ET, trades or live sell orders — `getSymbolsSoldSince`) → `mr_hold` `sold_today` (query failure
   → `mr_data_error`, no entries); SPY < SMA200 → one
   `mr_regime_off` row; otherwise signals ranked by RSI(2) → `mr_skip_breaker` (entry block) /
   `pending_order_in_progress` (in-flight buy incl. `error`, or needs_review — **the idempotency guard for a retried
   decision**) / `pending_exists` (semi_auto) / `mr_skip_budget` (`planEntry` quantity 0) / kill-switch re-check /
   `executeEntry` → `mr_buy` (or the order outcome's action); every entry-signal row carries `detail.mr.signal = true`.
   Before each order the phase re-reads `minutesUntilUsMarketClose`; ≤ 1 → stop submitting, `summary.closeCutoffHit`.
10. `summary.decisionPhase = 'done'` only if: no run-deadline hit (quote prefetch included), no close cutoff, and no
    `mr_data_error` in this run — so the window's next tick retries a transient FMP failure.
11. `finishCronRun` + `cron_decisions` (every decision carries `detail.mr`).

## AI Entry Review (review cron)

`api/cron/review.ts` — **record-only**; it never touches an order. Every 10 min 16–21 UTC it picks today's signal
decisions (rows with `detail.mr.signal = true`, whatever action the order path left — `auto` overwrites `mr_buy`
with `order_submitted` etc.), deduped to one per symbol, without a `trade_audit` row keyed `review-<ET date>-<SYMBOL>`,
up to 5 per run. The key is re-checked after the lock (a previous run may have just finished it). Reviews that run
after the regular close record `afterClose: true` on the decision row. Nothing pending → no audit row. For each: reuse today's technical (1Day) / news / fundamental rows or
run them (`lib/analysis/run-*.ts`, saved to `analysis_results` with `timeframe = '1Day'`), then
`runEntryReview` (`lib/analysis/entry-review.ts`, `callAnalysisAi`, pro tier, reasoning off) and write
`trade_audit` kind `entry_review` — **also on error**, so a failing signal is not retried every tick.
Output: `{ fraction, dropCause: noise|news|earnings|macro|unknown, confidence, reason }`.

## 매수 가능 현금

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
건이 전부 같은 잔고를 보고 승인된다. semi_auto 승인 요청도 계획 금액만큼 현금에서, auto 미체결 매수도
계획 금액만큼 노출에서 런 안에서 차감한다(판단 단계가 한 런에서 여러 종목을 산다).

dry_run 체결가에는 `dry_run_cost_bps`가 붙는다(매수 ×(1+c), 매도 ×(1−c)) — 현금 원장과 실현 손익이
같은 가격에서 나와야 어긋나지 않으므로 trade·포지션·알림 모두 그 값을 쓴다(`api/cron/_orders.ts`).

> **운영 주의 — Toss는 IP 허용목록을 쓴다.** 로컬에서 `/oauth2/token`을 호출하면
> `403 access_denied / "IP address not allowed"`가 난다(2026-08-22 확인). 프로덕션 EC2의 IP만
> 등록돼 있다는 뜻이고, **그 IP가 바뀌면(인스턴스 교체·EIP 변경) `auto`는 매 런 fail closed로
> 매수가 전부 막힌다.** 증상은 `skipped_no_buying_power` 감사 행뿐이라 조용하다.
> 실거래 전환 전에 EC2에서 `getBuyingPower('USD')`가 실제로 값을 내는지 확인할 것.

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

- **미국 정규장이 아니면 거부한다**(409, 대기 주문은 건드리지 않음). 판단이 마감 20분 전이라 승인 요청은 전부
  마감 직전에 생기고, 만료도 `min(15분, 마감)`으로 잘린다 — 마감 뒤 시장가 주문을 막는다.

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
|---|---|---|---|
| Kill switch | `trading_enabled` | `true` | **Halts everything, exits included.** Re-read before each order |
| Daily trade limit | `max_trades_per_day` | 20 | Blocks entries only (`mr_skip_breaker`). Exits still run |
| Daily loss limit | `max_daily_loss_usd` | 500 | Realized today + **today's** unrealized change. Blocks entries and sets `forceFullExit` |
| Regime filter | `mr_regime_filter` | on | SPY < SMA200 → no entries that day (`mr_regime_off`). Not a risk breaker, no mail |
| Budget | `max_position_size` / `max_total_exposure` / cash | 5k / 25k | `planEntry` quantity 0 → `mr_skip_budget` |

**A risk breaker stops new risk, never risk reduction.** The loss breaker used to sum the unrealized P&L **since
entry**. With multi-day holds one −10% position filled the $500 limit and blocked every entry for days — exactly the
days this strategy buys (backtest: 366 signals blocked in 2023-26, annual return 19.6% → 12.7%, MDD 30% → 28%). The
unrealized term is now `quantity × (price − reference)`, reference = entry price if opened today, else FMP
`previousClose` (entry price when missing — substitute, never exclude). A quote more than 25% away from its reference
is treated as a possibly corrupt tick (one mail per day): a **loss** still counts, a gain is dropped — a corrupt spike
must not mask losses, and a real crash must reach the breaker when the stop can't act (`mr_stop_atr = 0`, semi_auto).

`forceFullExit` (loss breaker tripped): every exit is already full-size under this strategy, so what it adds is
**leaving positions that cannot be evaluated** — no live price in `auto` (market order) or no daily bars in the
decision phase (`mr_forced_exit`). A position with data is judged by the rule as usual: 평가 가능하면 평가를
따르고, 불가능하면 나간다.

The response and audit row when a breaker trips with nothing held and no decision to make:
`{ skipped: true, reason: 'daily_loss_limit_reached' | 'daily_trade_limit_reached' }`, `cron_runs.status='skipped'`.
Otherwise the run proceeds and `summary.entriesBlockedBy` / `exitsForcedFull` record it.

## 매매 실행 주기 (execute_interval_min)

`execute_interval_min`은 **5 또는 10분**이다. 이 간격이 정하는 것은 재난 손절의 반응 지연뿐이다 — 진입과
규칙 청산은 하루 1회 판단 틱에서만 한다. 게이트가 `(분 − 7) mod 간격`이라 마감 20분 창 안의 틱 수가
간격마다 다르다(5분 4틱, 10분 2틱, 15·20분 1틱, 30·60분 0틱). 한 틱뿐이면 그 틱이 락 경합이나 일시
장애로 판단을 못 한 날은 판단이 통째로 사라지므로, 재시도 틱이 있는 값만 허용한다. 설정 조회 실패는
기본값으로 **진행**한다.

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
  the code sets: execute's 900s run deadline, the review cron's 1200s deadline, and the Redis lock
  TTLs. The old `maxDuration: 800` (Vercel Pro) is gone, which is why those numbers were re-derived
  rather than inherited.
- Errors are caught **per symbol** in both the execute cron and the review cron — one symbol's
  failure never drops the other symbols' results.
- Position close uses atomic DB update (`WHERE status = 'open'`) — returns 409 on race condition.
- Execute, reconcile and review crons use distributed locks (Redis SETNX) — concurrent invocations return `{ skipped: true }`.
- Cron runs write a `cron_runs` audit row (`running` → `completed`/`skipped`/`error`). A row stuck in `running` past `CRON_STALE_AFTER_MS` (45 min — must exceed both the longest run and the analysis lock TTL of 30 min, or the sweeper stomps a live run's row) belongs to an invocation that timed out before writing its finish row; the next cron invocation finalizes it to `error`/`timeout` via `finalizeStaleCronRuns` (never deletes).
- Trade + position mutations are wrapped in DB transactions for atomicity.
- `health.ts` requires no authentication — designed for uptime monitoring services.
