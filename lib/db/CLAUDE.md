# lib/db/ — Infrastructure (Database)

PostgreSQL database layer using Neon (serverless) + Drizzle ORM.

## Files

| File | Responsibility |
|------|---------------|
| `schema.ts` | Drizzle table definitions (8 tables) |
| `index.ts` | `createDb()` factory, `Db` type export |
| `queries.ts` | 28 query helper functions (all take `db: Db` as first param) |
| `migrate.ts` | Migration runner script (CLI) |
| `seed.ts` | Mock data seeder for dashboard preview |
| `clear.ts` | Deletes all data from all tables (with confirmation prompt) |

## Tables

| Table | Purpose |
|-------|---------|
| `watchlist` | Symbols to monitor |
| `analysis_model_config` | Per-analysis-type model + BYOK settings |
| `analysis_results` | Latest analysis snapshots (JSONB) |
| `positions` | Open/closed positions |
| `trades` | Execution history (with reason + mode) |
| `pending_orders` | Approval queue (semi_auto mode) |
| `config` | Key-value settings |
| `notification_config` | Email channel settings |

## Rules

- All numeric financial values stored as `numeric` (Drizzle returns strings). Convert with `String(value)` on insert, `Number(value)` on read.
- `queries.ts` functions are stateless — they receive `db` as a parameter, not a global.
- Use `onConflictDoUpdate()` for config upserts.
- Never import from `lib/strategy/` or `lib/analysis/` — this layer is pure I/O.
- `closePosition()` uses atomic WHERE clause (`status = 'open'`) to prevent double-close race conditions.
- `approvePendingOrder()` and `rejectPendingOrder()` similarly use atomic WHERE (`status = 'pending'`).

## Commands

```bash
yarn db:generate    # Generate migration from schema changes
yarn db:migrate     # Run pending migrations
yarn db:seed        # Insert mock data (positions, trades, analysis results)
yarn db:clear       # Delete all data (with Y/n confirmation prompt)
```

## Testing

Tested with mocked Drizzle builder chain.
