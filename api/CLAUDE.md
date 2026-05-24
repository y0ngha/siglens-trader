# api/ — Vercel Serverless Functions

HTTP handlers deployed as Vercel Serverless Functions. Includes cron jobs and dashboard REST API.

## Structure

```
api/
├── _lib/              # Shared utilities (NOT deployed as routes)
│   ├── cron-auth.ts   # CRON_SECRET verification
│   └── db.ts          # Singleton DB instance
├── cron/              # Scheduled functions (Vercel Cron)
│   ├── _run-analysis-cron.ts  # Shared factory (NOT a route)
│   ├── technical.ts   # */15 min — technical analysis
│   ├── news.ts        # */15 min — news analysis
│   ├── options.ts     # */15 min — options analysis
│   ├── fundamental.ts # daily — fundamental analysis
│   └── execute.ts     # */15 min +7 offset — trade execution
├── status.ts          # GET /api/status
├── positions.ts       # GET /api/positions
├── trades.ts          # GET /api/trades
├── analysis.ts        # GET /api/analysis?symbol=
├── config.ts          # GET+POST /api/config
├── pending.ts         # GET /api/pending
└── approve/[id].ts    # POST /api/approve/:id
```

## Handler Pattern

All handlers use standard Web API `Request`/`Response`:
```typescript
export default async function handler(req: Request): Promise<Response> {
    return Response.json(data);
}
```

Do NOT use `@vercel/functions` `VercelRequest`/`VercelResponse` types.

## Cron Authentication

All cron handlers verify `Authorization: Bearer <CRON_SECRET>` header via `verifyCronSecret(req)`. Return 401 on failure.

## Execute Cron Flow

1. Re-evaluate existing positions (dynamic stop/take profit from fresh analysis)
2. Score signals for watchlist symbols
3. Make trade decisions
4. Execute per mode (dry_run → DB only, semi_auto → pending + email, auto → Toss API)

## Rules

- Files prefixed with `_` are NOT deployed as routes (Vercel convention).
- Dashboard routes enforce HTTP method (405 on mismatch).
- Cron functions have `maxDuration: 800` (Vercel Pro).
- All errors caught per-symbol in execute cron — one failure doesn't stop the loop.
