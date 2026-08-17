# api/ — Vercel Serverless Functions

HTTP handlers deployed as Vercel Serverless Functions. Includes cron jobs and dashboard REST API.

## Structure

```
api/
├── _lib/              # Shared utilities (NOT deployed as routes)
│   ├── auth.ts        # isAuthenticated() / getSessionUser() — session cookie, CF Access JWT, DISABLE_AUTH
│   ├── cron-auth.ts   # verifyCronSecret() — CRON_SECRET verification
│   └── db.ts          # Singleton DB instance (getDb())
├── auth/              # Login surface (no signup route)
│   ├── login.ts       # POST — verify credentials, open a session, set the cookie
│   ├── logout.ts      # POST — revoke the session, clear the cookie
│   └── me.ts          # GET  — resolve the current session (401 when logged out)
├── cron/              # Scheduled functions (Vercel Cron)
│   ├── _run-analysis-cron.ts  # Shared factory + resolveApiKey() (NOT a route)
│   ├── technical.ts   # hourly — technical analysis
│   ├── news.ts        # hourly — news analysis
│   ├── options.ts     # hourly — options analysis
│   ├── fundamental.ts # daily — fundamental analysis
│   ├── execute.ts     # hourly +7min — trade execution + position re-evaluation
│   └── reconcile.ts   # every 10min — order timeout + DB consistency check
├── health.ts          # GET /api/health (no auth, optional ?deep=true for DB check)
├── status.ts          # GET /api/status
├── positions.ts       # GET /api/positions
├── positions/[id]/
│   └── close.ts       # POST /api/positions/:id/close — manual position close (atomic)
├── trades.ts          # GET /api/trades
├── analysis.ts        # GET /api/analysis?symbol=
├── analysis/
│   └── trigger.ts     # POST /api/analysis/trigger — manual analysis trigger
├── config.ts          # GET+POST /api/config (POST: allowlist-validated)
├── pending.ts         # GET /api/pending
├── search.ts          # GET /api/search?q= — ticker search via FMP
└── approve/
    └── [id].ts        # POST /api/approve/:id — approve/reject pending order
```

## Handler Pattern

Handlers use the standard Web `Request`/`Response` API, exported as **named HTTP-method
functions** (`GET`, `POST`, …). Do NOT use `export default` — Vercel's Node runtime treats a
default export as the legacy `(req, res)` Node signature (so `req.headers.get` is undefined and
a returned `Response` is silently ignored → runtime 500). Named method exports are what switches
Vercel into Web `Request`/`Response` mode.

```typescript
async function handler(req: Request): Promise<Response> {
    // req.method dispatch happens inside; the same handler can back multiple methods
    return Response.json(data);
}
export const GET = handler;   // add `export const POST = handler;` for multi-method routes
```

Single-purpose routes can also export the method function directly
(`export async function GET(req: Request) { ... }`). Do NOT use `@vercel/functions`
`VercelRequest`/`VercelResponse` types. Unit tests import the method export
(`(await import('../status')).GET`), not a default.

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
- **Cron routes**: `verifyCronSecret(req)` checks `Authorization: Bearer <CRON_SECRET>` header. Returns 401 on failure.

## Config POST Security

The config endpoint uses an allowlist (`ALLOWED_CONFIG_KEYS`) to prevent arbitrary key writes. Numeric keys are bounds-checked (0 to 1,000,000).

Allowed keys: `trading_mode`, `trading_enabled`, `max_position_size`, `max_total_exposure`,
`stop_loss_percent`, `take_profit_percent`, `buy_threshold`, `sell_threshold`,
`analysis_timeframe`, `score_weights`, `fixed_exit_enabled`, `max_trades_per_day`,
`max_daily_loss_usd`, `entry_window`, `execute_interval_min`, `entry_cooldown_min`.

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
   (`run_deadline` decisions) bounds the run, and `noOverlap: true` on the node-cron task blocks
   in-process overlap as a second layer
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
   - The **confluence snapshot** (`computeConfluence`, FMP bars + local indicator math, no LLM) is
     the heaviest axis (weight 12). It is memoized in a run-scoped `confluenceCache` shared by the
     re-evaluation loop and the watchlist loop, so a held watchlist symbol costs one bar fetch per
     run, not two. A `null` snapshot (FMP down, too few bars) drops the axis's weight to 0 rather
     than voting neutral — unlike stale technical analysis it never blocks a trade
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
   - Three entry guards share one `isEntryDecision` condition (buy / average_in / unfunded buy):
     - Stop-loss cooldown: skip buy/average_in for recently stop-lossed symbols — the
       zero-budget buy case is included because it decides as 'hold' and would otherwise slip
       past and mail a 잔고 부족 alert for a symbol we refuse to buy anyway
     - `entry_out_of_zone`: live price above `actionRecommendation.entryPrices` max + 1%
       (`exceedsEntryZone`). Upper bound only, fail-open when the analysis carries no zone
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

Decision actions from the entry guards: `entry_out_of_zone`, `entry_cooldown` (both carry a
`detail` block naming the price/zone or the last fill time, so "why didn't it buy" is
answerable after the fact). Gate-related actions: `entry_deferred`, `exit_deferred`, `gate_error`, `gate_skipped_deadline`,
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

**Gate OFF is not byte-identical to the pre-gate build.** `planEntry` clamps the budget by
real buying power (`auto` only), which `calculatePositionSize` never did — e.g. price $100 /
cash $250 used to be `skipped_insufficient_cash` (no order) and now buys 2 shares. This is
intentional (fewer broker rejections) and applies with the gate off too.

**종목당 최대 투자 금액 (`max_position_size`) is a market-value cap, not a cost cap.**
`existingSymbolExposure` is `currentPrice × quantity`, so a falling price frees budget back up
and total cost basis can exceed the configured limit (e.g. buying at $100 → $50 → $25 under a
$1000 cap reaches $2000 of cost). Pre-existing arithmetic, deliberately unchanged.

## Reconcile Cron Flow

1. Acquire lock (`cron:reconcile:lock`, 5min TTL)
2. Query all `submitted` orders from `order_tracking`
3. For orders older than 30 minutes: mark `timeout`, send email (urgent for sells)
4. Run DB consistency check (`checkConsistency`) — find filled orders without matching trades
5. If inconsistencies found, send alert email

`autoRecoverFilledOrders` only scans `status = 'filled'`, so a recovery that cannot succeed
(no fill price, or a position update that matches no rows) is moved to `needs_review`. Left at
`filled` it would be retried every 10 minutes for 24 hours and mail the operator each time.

## Circuit Breakers

| Breaker | Config Key | Default | Behavior |
|---------|-----------|---------|----------|
| Entry zone | — (analysis-driven) | +1% over `entryPrices` max | Blocks buy/average_in only — `entry_out_of_zone`. Not a breaker row in the audit: it is per-symbol, so it decides inside the watchlist loop rather than setting `entryBlock` |
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

## Order Lifecycle

```
createOrderTracking(submitted) → API call → updateOrderTracking(filled/rejected/error)
                                                      ↓ (if stays submitted)
                                          reconcile cron → timeout after 30min → email alert
```

## Rules

- Files prefixed with `_` are NOT deployed as routes (Vercel convention).
- Dashboard routes enforce HTTP method (405 on mismatch).
- Cron functions have `maxDuration: 800` (Vercel Pro).
- All errors caught per-symbol in execute cron — one failure doesn't stop the loop.
- Position close uses atomic DB update (`WHERE status = 'open'`) — returns 409 on race condition.
- Execute and reconcile crons use distributed locks (Redis SETNX) — concurrent invocations return `{ skipped: true }`.
- Cron runs write a `cron_runs` audit row (`running` → `completed`/`skipped`/`error`). A row stuck in `running` past `CRON_STALE_AFTER_MS` (15 min) belongs to an invocation that timed out before writing its finish row; the next cron invocation finalizes it to `error`/`timeout` via `finalizeStaleCronRuns` (never deletes).
- Trade + position mutations are wrapped in DB transactions for atomicity.
- `health.ts` requires no authentication — designed for uptime monitoring services.
