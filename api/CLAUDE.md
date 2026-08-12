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
   - Skip positions with pending sell in-flight
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
     `existingSymbolExposure`, the old average_in-specific cap block is gone; the
     `symbol_limit_reached` decision now fires **before** `makeTradeDecision` (buy signals
     only) so the '잔고 부족' path can't mail the wrong cause
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

New decision actions: `entry_deferred`, `exit_deferred`, `gate_error`, `gate_skipped_deadline`.
Every decision the gate took part in carries a `detail.gate` block (`kind`, `source` of
`ai`/`disabled`/`hard`/`error`/`deadline`, `model`, `fraction`, `confidence`, `reason`,
`fullBudget`, `trancheBudget`, `limitedBy`, `quantity`) merged alongside `scoreDecisionDetail`.

## Reconcile Cron Flow

1. Acquire lock (`cron:reconcile:lock`, 5min TTL)
2. Query all `submitted` orders from `order_tracking`
3. For orders older than 30 minutes: mark `timeout`, send email (urgent for sells)
4. Run DB consistency check (`checkConsistency`) — find filled orders without matching trades
5. If inconsistencies found, send alert email

## Circuit Breakers

| Breaker | Config Key | Default | Behavior |
|---------|-----------|---------|----------|
| Kill switch | `trading_enabled` | `true` | Re-checked before each trade in the loop |
| Daily trade limit | `max_trades_per_day` | `20` | Checked at start + before each trade |
| Daily loss limit | `max_daily_loss_usd` | `500` | Realized PnL + unrealized PnL (live prices) |

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
