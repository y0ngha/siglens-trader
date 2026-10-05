# lib/db/ — Infrastructure (Database)

PostgreSQL database layer using `pg` (node-postgres) + Drizzle ORM (`drizzle-orm/node-postgres`).
Provider-neutral: runs against Neon today and AWS RDS PostgreSQL 17 after the cutover — same wire protocol,
no provider SDK. Result objects keep `{ rows, rowCount }` (`partialClosePosition`/`averageIntoPosition`/
`seed-operator` read `rowCount`), and `db.transaction()` is a real interactive transaction on a pooled client.

## Files

| File | Responsibility |
|------|---------------|
| `schema.ts` | Drizzle table definitions (16 tables) |
| `index.ts` | `createDb()` factory (`pg` Pool, `max: 10`, 'connect'/'error' listeners that keep a dropped connection from killing the process), `Db` and `DbOrTx` type exports |
| `connection-config.ts` | `buildPoolConfig(url)` — TLS policy + pool hardening (`connectionTimeoutMillis: 10_000`, `keepAlive: true`, `keepAliveInitialDelayMillis: 30_000`. The 10s bounds both a hung private-RDS connect AND waiting for a free slot when the pool is full — pg-pool cannot split them; it does not bound query run time. Without the initial delay, keepAlive falls back to the OS default of 7200s and is inert). A URL is local only if every effective host (URL host AND `host`/`hostaddr` query values) is a local host or socket path; local URLs keep the URL as-is; every other host gets `ssl: { rejectUnauthorized: true }` and the URL's `sslmode`/`ssl`/`uselibpqcompat`/`sslnegotiation` are stripped (`sslmode=disable`/`no-verify` throw). Reason: `pg` with no `sslmode` connects in plaintext, and `require`/`prefer`/`verify-ca` are `verify-full` aliases that print a deprecation warning. `channel_binding` is ignored by `pg` and left alone. RDS needs its CA bundle via `NODE_EXTRA_CA_CERTS` (set in the Dockerfile) |
| `queries.ts` | 30+ query helper functions (all take `db: Db` or `db: DbOrTx` as first param) |
| `recovery.ts` | DB consistency checker: `checkConsistency()` — finds filled orders without matching trades |
| `schema-readiness.ts` | `checkSchemaReadiness()` — probes that the most recently added column (currently `positions.stop_price`, migration 0019) exists, for `/api/health?ready=true`. Only 42703/42P01 report not-ready; anything else (timeout included) reports ready, since it can't prove a mismatch |
| `migrate.ts` | Migration runner script (CLI). The node-postgres migrator runs all pending migrations (and their journal rows) in **one transaction**; the pool is ended in `finally` so the process exits, and a failure sets exit code 1 (`reportFailure`). Constraints for new migrations: no `CREATE INDEX CONCURRENTLY` (apply by hand), a new enum value cannot be used by a later migration in the same batch (split into separate runs), and `ALTER TABLE` locks are held until the whole batch commits (ship big-table migrations alone). Runs from a developer machine only — the runtime image has no `drizzle/` folder; RDS is reached through the SSM tunnel with `sslmode=no-verify` (docs/DEPLOYMENT.md §1) |
| `seed.ts` | Mock data seeder for dashboard preview (strategy defaults: `mr_*`, `dry_run_cost_bps`, $25k paper deposit — slots and caps are derived from equity, not seeded) |
| `seed-operator.ts` | Operator account provisioning + data-ownership backfill (CLI, `yarn db:seed-operator`) |
| `clear.ts` | Deletes all data from all tables (with confirmation prompt). Ends its pool when done |

## Tables

| Table | Purpose |
|-------|---------|
| `users` | Operator accounts (uuid pk, bcrypt `password_hash`) — column shapes mirror siglens so the systems can be merged later |
| `sessions` | Login sessions (cookie value = row id, expiry enforced on read) |
| `watchlist` | Symbols to monitor |
| `analysis_model_config` | Per-analysis-type model + BYOK settings |
| `analysis_results` | Latest analysis snapshots (JSONB). `app_version`은 이 결과를 만든 **프롬프트 세대**(배포 태그) — 프롬프트 원문은 저장하지 않으므로 전후 비교의 유일한 축이다 |
| `positions` | Open/closed positions (unique index on symbol+open status). `stop_price` = disaster stop (NULL: no stop, or opened via approval/recovery — execute fills it) |
| `trades` | Execution history (with reason + mode + cronRunId) |
| `trade_audit` | AI 호출 1건의 **원문** — 나간 프롬프트와 받은 응답. 지금은 `kind = 'entry_review'`(기록 전용 리뷰, `correlation_id = review-<cron_decisions.id>`)만 쓰고, `entry`/`exit`는 2026-09-24 이전 사이징 게이트의 기록이다 |
| `pending_orders` | Approval queue (semi_auto mode) |
| `config` | Key-value settings (JSONB value) |
| `order_tracking` | Order lifecycle tracking (unique idempotency key, `client_order_id` Toss idempotency key, status transitions) |
| `notification_config` | Email channel settings |
| `cron_runs` | One row per cron invocation (health: status, outcome, duration, summary) |
| `cron_decisions` | Per-symbol/per-order decision audit (action + reason + `detail.mr`, linked to cron_runs by run_id) |
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
| `getDryRunCashFlowUsd(db)` | `dry_run` 모의 계좌의 순현금흐름(매도 − 매수). 잔고를 저장하지 않고 체결 원장에서 도출한다 — 저장 잔고는 원장과 어긋나면 스스로 복구되지 않는다 |
| `insertTradeAudit(db, params)` | AI 호출 1건의 프롬프트·원문 응답 적재(kind `entry_review`). 실패한 호출도 기록한다 |
| `setPositionStopPrice(db, id, price)` | 비어 있는 재난 손절가만 채운다(이미 있으면 덮지 않음) |
| `hasDecisionPhaseSince(db, since)` | 이 시각 이후 판단 단계를 끝낸 execute 런(`summary.decisionPhase = 'done'`)이 있는가 — 하루 1회 멱등 |
| `getMrSignalDecisionsSince(db, since)` / `hasTradeAuditCorrelation(db, id)` | 리뷰 대상 신호 조회와 리뷰 멱등 키 확인 |
| `getLatestSizing(db, { pricedOnly })` | 최근 execute 런의 `summary.sizing`(총자산 연동 사이징). `pricedOnly` = 시세로 칸 수를 계산한 판단 틱만 — 위험 틱의 칸 수와 승인 경로의 손실 한도 출처. 손상된 jsonb는 null. `SizingRecord`는 lib/strategy를 import하지 않으려고 구조 타입으로 둔다 |
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
- Hand-written `sql` templates: cast every bound parameter (`${x}::integer`, `${x}::numeric`). node-postgres sends params as `unknown`, so two params meeting (`$a * $b`) fail with `42725 operator is not unique`, and a mismatched assignment (e.g. `::text` into a `numeric` column) fails too. Mocked-db tests cannot see this — assert the rendered casts (`PgDialect().sqlToQuery`) instead. Assign numeric results directly to `numeric` columns.
- `queries.ts` functions are stateless — they receive `db` as a parameter, not a global.
- Use `onConflictDoUpdate()` for config upserts.
- Never import from `lib/strategy/` or `lib/analysis/` — this layer is pure I/O.
- `closePosition()` uses atomic WHERE clause (`status = 'open'`) to prevent double-close race conditions.
- `approvePendingOrder()` and `rejectPendingOrder()` similarly use atomic WHERE (`status = 'pending'`).
- `averageIntoPosition()` computes new avg price atomically in SQL — no read-then-write race.
- `reducePositionQuantity()` uses `WHERE quantity > soldQuantity` (strictly more — equal quantity goes to `closePosition()`) to prevent zero/negative quantities.
- `getTodayRealizedPnl()` sums each sell trade's recorded `realized_pnl` (single query) — avoids false alarms on buy-heavy days and the prior positions-join double-counting / same-symbol-reopen misattribution. Sell trades booked before the `realized_pnl` column existed carry null and are excluded (negligible deploy-day edge).
- `checkConsistency()` / `autoRecoverFilledOrders()` match a booked trade by `client_order_id` when the order has one (precise), else fall back to the loose symbol+side+executed-after condition.

## Testing

Tested with mocked Drizzle builder chain.
