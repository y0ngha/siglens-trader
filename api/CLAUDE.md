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

Allowed keys: `trading_mode`, `max_position_size`, `max_total_exposure`, `stop_loss_percent`, `take_profit_percent`, `buy_threshold`, `sell_threshold`, `analysis_timeframe`, `score_weights`.

## Execute Cron Flow

1. Acquire distributed lock (`cron:execute:lock`, 15min TTL)
2. Circuit breaker checks: kill switch → daily trade limit → daily loss limit (realized + unrealized)
3. Expire old pending orders
4. Fetch live prices for all symbols (FMP quote API, cached per run)
5. Fetch pending submitted orders (for sell-guard checks)
5.5. Load the AI sizing gate config (`analysis_model_config['trade_gate']`, once per run) and
   set the gate cutoff at cron start + 600s
6. Re-evaluate existing positions (dynamic stop/take profit from fresh analysis)
   - Skip positions with a sell in-flight (`order_tracking`) **or** queued for approval
     (`pending_orders`, semi_auto)
   - Non-`hold` exits go through the **exit sizing gate** (see below) → `exitQty`; a partial
     exit calls `reducePositionQuantity`, a full one `closePosition`, in all three modes
   - Track stop-loss closures for cooldown — registered on the *trigger*, so a partial
     stop-loss blocks a same-run re-buy just like a full one
7. Recalculate exposure after any closures (using market prices)
8. Score signals for watchlist symbols
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
   - Stop-loss cooldown: skip buy/average_in for recently stop-lossed symbols
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

New decision actions: `entry_deferred`, `exit_deferred`, `gate_error`, `gate_skipped_deadline`,
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

The price feeding the unrealized-PnL breaker is sanity-banded to **1/3–3× the position's
average entry price**; anything outside is dropped from the sum and mailed as
`이상 시세 무시`. `fetchLivePrice` only checks "finite positive", and a wrong tick now
liquidates the whole book rather than merely halting trading. A *failed* fetch is safe
(contributes 0); a wrong positive value is not.

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
