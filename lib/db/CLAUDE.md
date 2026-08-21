# lib/db/ — Infrastructure (Database)

PostgreSQL database layer using Neon (serverless) + Drizzle ORM.

## Files

| File | Responsibility |
|------|---------------|
| `schema.ts` | Drizzle table definitions (16 tables) |
| `index.ts` | `createDb()` factory, `Db` and `DbOrTx` type exports |
| `queries.ts` | 30+ query helper functions (all take `db: Db` or `db: DbOrTx` as first param) |
| `recovery.ts` | DB consistency checker: `checkConsistency()` — finds filled orders without matching trades |
| `migrate.ts` | Migration runner script (CLI) |
| `seed.ts` | Mock data seeder for dashboard preview |
| `seed-operator.ts` | Operator account provisioning + data-ownership backfill (CLI, `yarn db:seed-operator`) |
| `clear.ts` | Deletes all data from all tables (with confirmation prompt) |

## Tables

| Table | Purpose |
|-------|---------|
| `users` | Operator accounts (uuid pk, bcrypt `password_hash`) — column shapes mirror siglens so the systems can be merged later |
| `sessions` | Login sessions (cookie value = row id, expiry enforced on read) |
| `watchlist` | Symbols to monitor |
| `analysis_model_config` | Per-analysis-type model + BYOK settings |
| `analysis_results` | Latest analysis snapshots (JSONB) |
| `positions` | Open/closed positions (unique index on symbol+open status) |
| `trades` | Execution history (with reason + mode + cronRunId) |
| `trade_audit` | 사이징 게이트 호출 1건의 **원문** — 나간 프롬프트와 받은 응답. `cron_run_id` + `symbol` + `kind`로 `trades`/`cron_decisions`와 조인하고, 정확히 1:1이어야 하면 `correlation_id`를 쓴다 (한 런에서 같은 심볼이 `exit` 게이트를 두 번 탈 수 있다) |
| `pending_orders` | Approval queue (semi_auto mode) |
| `config` | Key-value settings (JSONB value) |
| `order_tracking` | Order lifecycle tracking (unique idempotency key, `client_order_id` Toss idempotency key, status transitions) |
| `notification_config` | Email channel settings |
| `cron_runs` | One row per cron invocation (health: status, outcome, duration, summary) |
| `cron_decisions` | Per-symbol/per-order decision audit (action + reason, linked to cron_runs by run_id) |
| `news_cards` | Per-news LLM summary cards (keyed by news id) |
| `notification_queue` | Notifications deferred during quiet hours, drained by the morning digest cron |

## Data Ownership

`watchlist`, `analysis_model_config`, `positions`, `trades`, `trade_audit`, `pending_orders`,
`config`, `order_tracking` and `notification_config` carry a `user_id` FK to `users`.
`db:seed-operator` backfills existing rows and sets the column DEFAULT to the operator,
so the query helpers here **do not pass an owner** — Postgres fills it in.

Reads are not scoped by `user_id`. That is correct only while there is no signup and
exactly one account exists; adding signup requires scoping every read, dropping the
DEFAULT, and indexing `user_id`. See the comment on `ownerUserId` in `schema.ts`.

## Key Query Functions (added in audit)

| Function | Description |
|----------|-------------|
| `averageIntoPosition(db, positionId, qty, price)` | Atomic weighted-average price update via SQL (no read-then-write) |
| `reducePositionQuantity(db, id, soldQty)` | Atomic position quantity reduction for partial sells |
| `getTodayTradeCount(db)` | Count today's non-skipped trades (NY timezone) |
| `insertTradeAudit(db, params)` | 게이트 호출 1건의 프롬프트·원문 응답 적재. 주문이 나가지 않은 호출도 기록한다 — 호출부는 실패를 삼켜야 한다 |
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
yarn db:seed-operator  # Create/rotate the operator account (OPERATOR_EMAIL + OPERATOR_PASSWORD),
                       # backfill user_id on owned tables and set the column DEFAULT
yarn db:clear       # Delete all data (with Y/n confirmation prompt)
```

## Testing

Tested with mocked Drizzle builder chain.
