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
│   └── execute.ts     # hourly +7min — trade execution + position re-evaluation
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

All handlers use standard Web API `Request`/`Response`:
```typescript
export default async function handler(req: Request): Promise<Response> {
    return Response.json(data);
}
```

Do NOT use `@vercel/functions` `VercelRequest`/`VercelResponse` types.

## Authentication

- **Dashboard routes**: `isAuthenticated(req)` checks `cf-access-authenticated-user-email` header or `DISABLE_AUTH=true` env var. Returns 403 on failure.
- **Cron routes**: `verifyCronSecret(req)` checks `Authorization: Bearer <CRON_SECRET>` header. Returns 401 on failure.

## Config POST Security

The config endpoint uses an allowlist (`ALLOWED_CONFIG_KEYS`) to prevent arbitrary key writes. Numeric keys are bounds-checked (0 to 1,000,000).

Allowed keys: `trading_mode`, `max_position_size`, `max_total_exposure`, `stop_loss_percent`, `take_profit_percent`, `buy_threshold`, `sell_threshold`, `analysis_timeframe`, `score_weights`.

## Execute Cron Flow

1. Re-evaluate existing positions (dynamic stop/take profit from fresh analysis)
2. Recalculate exposure after any closures
3. Score signals for watchlist symbols (runs overall analysis if stale >2h)
4. Make trade decisions
5. Handle skipped trades (exposure limit exceeded) with notification
6. Execute per mode (dry_run → DB only, semi_auto → pending + email, auto → Toss API)

## Rules

- Files prefixed with `_` are NOT deployed as routes (Vercel convention).
- Dashboard routes enforce HTTP method (405 on mismatch).
- Cron functions have `maxDuration: 800` (Vercel Pro).
- All errors caught per-symbol in execute cron — one failure doesn't stop the loop.
- Position close uses atomic DB update (`WHERE status = 'open'`) — returns 409 on race condition.
