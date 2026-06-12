# lib/db/ — Infrastructure (Database)

PostgreSQL database layer using Neon (serverless) + Drizzle ORM.

## Files

| File | Responsibility |
|------|---------------|
| `schema.ts` | Drizzle table definitions (11 tables) |
| `index.ts` | `createDb()` factory, `Db` and `DbOrTx` type exports |
| `queries.ts` | 30+ query helper functions (all take `db: Db` or `db: DbOrTx` as first param) |
| `recovery.ts` | DB consistency checker: `checkConsistency()` — finds filled orders without matching trades |
| `migrate.ts` | Migration runner script (CLI) |
| `seed.ts` | Mock data seeder for dashboard preview |
| `clear.ts` | Deletes all data from all tables (with confirmation prompt) |

## Tables

| Table | Purpose |
|-------|---------|
| `watchlist` | Symbols to monitor |
| `analysis_model_config` | Per-analysis-type model + BYOK settings |
| `analysis_results` | Latest analysis snapshots (JSONB) |
| `positions` | Open/closed positions (unique index on symbol+open status) |
| `trades` | Execution history (with reason + mode + cronRunId) |
| `pending_orders` | Approval queue (semi_auto mode) |
| `config` | Key-value settings (JSONB value) |
| `order_tracking` | Order lifecycle tracking (unique idempotency key, `client_order_id` Toss idempotency key, status transitions) |
| `notification_config` | Email channel settings |
| `cron_runs` | One row per cron invocation (health: status, outcome, duration, summary) |
| `cron_decisions` | Per-symbol/per-order decision audit (action + reason, linked to cron_runs by run_id) |

## Key Query Functions (added in audit)

| Function | Description |
|----------|-------------|
| `averageIntoPosition(db, positionId, qty, price)` | Atomic weighted-average price update via SQL (no read-then-write) |
| `reducePositionQuantity(db, id, soldQty)` | Atomic position quantity reduction for partial sells |
| `getTodayTradeCount(db)` | Count today's non-skipped trades (NY timezone) |
| `getTodayRealizedPnl(db)` | Sums per-sell `realized_pnl` (recorded at execution as (sellPrice − cost basis) × qty) for today's non-dry/non-skipped sells |
| `createOrderTracking(db, params)` | Insert order tracking record with idempotency key |
| `updateOrderTracking(db, key, updates)` | Update order status/price by idempotency key |
| `getPendingSubmittedOrders(db)` | Get all orders in 'submitted' status |
| `expireOldPendingOrders(db)` | Mark expired pending orders |

## DbOrTx Pattern

Functions that participate in transactions accept `DbOrTx` instead of `Db`. This allows the execute cron to wrap trade insertion + position mutation in a single DB transaction:

```typescript
await db.transaction(async (tx) => {
    await insertTrade(tx, { ... });
    await closePosition(tx, positionId, price);
});
```

## Rules

- All numeric financial values stored as `numeric` (Drizzle returns strings). Convert with `String(value)` on insert, `Number(value)` on read.
- `queries.ts` functions are stateless — they receive `db` as a parameter, not a global.
- Use `onConflictDoUpdate()` for config upserts.
- Never import from `lib/strategy/` or `lib/analysis/` — this layer is pure I/O.
- `closePosition()` uses atomic WHERE clause (`status = 'open'`) to prevent double-close race conditions.
- `approvePendingOrder()` and `rejectPendingOrder()` similarly use atomic WHERE (`status = 'pending'`).
- `averageIntoPosition()` computes new avg price atomically in SQL — no read-then-write race.
- `reducePositionQuantity()` uses `WHERE quantity >= soldQuantity` to prevent negative quantities.
- `getTodayRealizedPnl()` sums each sell trade's recorded `realized_pnl` (single query) — avoids false alarms on buy-heavy days and the prior positions-join double-counting / same-symbol-reopen misattribution. Sell trades booked before the `realized_pnl` column existed carry null and are excluded (negligible deploy-day edge).
- `checkConsistency()` / `autoRecoverFilledOrders()` match a booked trade by `client_order_id` when the order has one (precise), else fall back to the loose symbol+side+executed-after condition.

## Commands

```bash
yarn db:generate    # Generate migration from schema changes
yarn db:migrate     # Run pending migrations
yarn db:seed        # Insert mock data (positions, trades, analysis results)
yarn db:clear       # Delete all data (with Y/n confirmation prompt)
```

## Testing

Tested with mocked Drizzle builder chain.
