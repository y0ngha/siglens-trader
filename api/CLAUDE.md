# api/ — Vercel Serverless Functions

HTTP handlers deployed as Vercel Serverless Functions. Includes cron jobs and dashboard REST API.

## Structure

```
api/
├── _lib/              # Shared utilities (NOT deployed as routes)
│   ├── auth.ts        # isAuthenticated() — Cloudflare Access header + DISABLE_AUTH
│   ├── cron-auth.ts   # verifyCronSecret() — CRON_SECRET verification
│   └── db.ts          # Singleton DB instance (getDb())
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

- **Dashboard routes**: `isAuthenticated(req)` is async (`Promise<boolean>`). When `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` are set, verifies the `Cf-Access-Jwt-Assertion` JWT via JWKS (strict mode). Otherwise falls back to trusting the `cf-access-authenticated-user-email` header. `DISABLE_AUTH=true` bypasses auth only in non-production. Returns 403 on failure.
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
6. Re-evaluate existing positions (dynamic stop/take profit from fresh analysis)
   - Skip positions with pending sell in-flight
   - Track stop-loss closures for cooldown
7. Recalculate exposure after any closures (using market prices)
8. Score signals for watchlist symbols (runs overall analysis if stale >2h)
9. Make trade decisions (buy/sell/hold/average_in)
   - Stop-loss cooldown: skip buy/average_in for recently stop-lossed symbols
   - Pending sell guard: skip sell if submitted sell order exists
   - Per-symbol exposure cap for average_in
   - Re-check kill switch before each trade
10. Execute per mode:
    - `dry_run` → DB transaction (trade + position atomically)
    - `semi_auto` → pending order + email notification
    - `auto` → order tracking + Toss API + DB transaction + email
11. Release lock in `finally` block

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
- Trade + position mutations are wrapped in DB transactions for atomicity.
- `health.ts` requires no authentication — designed for uptime monitoring services.
