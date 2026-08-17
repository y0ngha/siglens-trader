import { sql } from 'drizzle-orm';
import {
    pgTable,
    serial,
    text,
    boolean,
    integer,
    numeric,
    jsonb,
    timestamp,
    uuid,
    varchar,
    uniqueIndex,
    index,
} from 'drizzle-orm/pg-core';

/**
 * Operator accounts.
 *
 * Column shapes deliberately mirror siglens' `users` table (uuid pk, bcrypt
 * `password_hash`, `email_verified`) so a future merge into the siglens account
 * system is a data copy rather than a redesign. Trader has no signup flow —
 * rows are provisioned by `lib/db/seed-operator.ts`.
 */
export const users = pgTable('users', {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    passwordHash: text('password_hash'),
    name: text('name'),
    emailVerified: boolean('email_verified').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Login sessions. The cookie value is the session id; expiry is enforced on read. */
export const sessions = pgTable(
    'sessions',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        index('idx_sessions_user_id').on(table.userId),
        index('idx_sessions_expires_at').on(table.expiresAt),
    ],
);

/**
 * Owner of operator-scoped rows.
 *
 * The migration backfills existing rows to the seeded operator and sets a column
 * DEFAULT to that same uuid, so trading/cron insert paths need no code change.
 * Deliberate ceiling: reads are NOT filtered by user_id — correct while signup is absent and
 * exactly one account exists. The moment a second account can be created, all three
 * of these are required: scope every read by user_id, drop the column DEFAULT so an
 * owner must be passed explicitly, and add a user_id index to each table below.
 */
const ownerUserId = () => uuid('user_id').references(() => users.id, { onDelete: 'restrict' });

export const watchlist = pgTable('watchlist', {
    id: serial('id').primaryKey(),
    symbol: text('symbol').notNull().unique(),
    companyName: text('company_name').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    userId: ownerUserId(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const analysisModelConfig = pgTable('analysis_model_config', {
    id: serial('id').primaryKey(),
    analysisType: text('analysis_type').notNull().unique(),
    enabled: boolean('enabled').default(true).notNull(),
    modelId: text('model_id').notNull(),
    useByok: boolean('use_byok').default(false).notNull(),
    userId: ownerUserId(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const analysisResults = pgTable(
    'analysis_results',
    {
        id: serial('id').primaryKey(),
        symbol: text('symbol').notNull(),
        analysisType: text('analysis_type').notNull(),
        result: jsonb('result').notNull(),
        modelId: text('model_id').notNull(),
        analyzedAt: timestamp('analyzed_at', { withTimezone: true }).notNull(),
        sourceAnalyzedAt: timestamp('source_analyzed_at', { withTimezone: true }),
        cronRunId: text('cron_run_id'),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        index('idx_analysis_symbol_type_date').on(
            table.symbol,
            table.analysisType,
            table.analyzedAt,
        ),
    ],
);

export const positions = pgTable(
    'positions',
    {
        id: serial('id').primaryKey(),
        symbol: text('symbol').notNull(),
        side: text('side').notNull(),
        quantity: integer('quantity').notNull(),
        avgPrice: numeric('avg_price').notNull(),
        openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
        closedAt: timestamp('closed_at', { withTimezone: true }),
        closePrice: numeric('close_price'),
        status: text('status').default('open').notNull(),
        userId: ownerUserId(),
    },
    (table) => [
        uniqueIndex('idx_positions_symbol_open')
            .on(table.symbol)
            .where(sql`status = 'open'`),
        index('idx_positions_symbol_status').on(table.symbol, table.status),
    ],
);

export const trades = pgTable(
    'trades',
    {
        id: serial('id').primaryKey(),
        symbol: text('symbol').notNull(),
        side: text('side').notNull(),
        orderType: text('order_type').notNull(),
        quantity: integer('quantity').notNull(),
        price: numeric('price').notNull(),
        executedAt: timestamp('executed_at', { withTimezone: true }).notNull(),
        reason: text('reason'),
        mode: text('mode').notNull(),
        cronRunId: text('cron_run_id'),
        clientOrderId: text('client_order_id'),
        realizedPnl: numeric('realized_pnl'),
        dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
        userId: ownerUserId(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        index('idx_trades_executed_at').on(table.executedAt),
        // 한 브로커 체결이 두 행으로 기록되는 것을 DB가 막는다.
        //
        // execute는 booking 트랜잭션 안에서 trade를 넣고, reconcile의 `autoRecoverFilledOrders`는
        // `client_order_id`로 기존 trade를 찾아 없으면 복구 삽입한다. 두 크론은 **서로 다른
        // 락**을 잡으므로(`cron:execute:lock` vs `cron:reconcile:lock`) execute의 커밋 전에
        // reconcile이 같은 주문을 복구하면 체결 1건에 trade 2행 + 포지션 2회 변경이 된다.
        // 코드로 창을 좁히는 것보다 제약으로 불가능하게 만드는 편이 확실하다 — 두 번째
        // insert가 실패하며 그쪽 트랜잭션이 통째로 롤백된다.
        //
        // partial index인 이유: `client_order_id`는 dry_run·수동 청산·구 데이터에서 NULL이고,
        // Postgres는 NULL을 서로 다른 값으로 보지만 의도를 명시해 두는 편이 안전하다.
        uniqueIndex('idx_trades_client_order_id')
            .on(table.clientOrderId)
            .where(sql`client_order_id IS NOT NULL`),
    ],
);

export const pendingOrders = pgTable(
    'pending_orders',
    {
        id: serial('id').primaryKey(),
        symbol: text('symbol').notNull(),
        side: text('side').notNull(),
        quantity: integer('quantity').notNull(),
        priceLimit: numeric('price_limit'),
        analysisSummary: text('analysis_summary'),
        signalScore: numeric('signal_score'),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
        status: text('status').default('pending').notNull(),
        userId: ownerUserId(),
    },
    (table) => [index('idx_pending_orders_status').on(table.status, table.expiresAt)],
);

export const config = pgTable('config', {
    key: text('key').primaryKey(),
    value: jsonb('value').notNull(),
    userId: ownerUserId(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const orderTracking = pgTable('order_tracking', {
    id: serial('id').primaryKey(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    symbol: text('symbol').notNull(),
    side: text('side').notNull(),
    quantity: integer('quantity').notNull(),
    tossOrderId: text('toss_order_id'),
    clientOrderId: text('client_order_id'),
    status: text('status').notNull(),
    filledPrice: numeric('filled_price'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    cronRunId: text('cron_run_id'),
    userId: ownerUserId(),
});

export const notificationConfig = pgTable('notification_config', {
    id: serial('id').primaryKey(),
    channel: text('channel').notNull().unique(),
    enabled: boolean('enabled').default(true).notNull(),
    target: text('target').notNull(),
    events: text('events').array().default([]).notNull(),
    userId: ownerUserId(),
});

// status = lifecycle (running→completed/skipped/error); outcome = machine-readable reason (market_closed, locked, …); summary = structured counts
export const cronRuns = pgTable(
    'cron_runs',
    {
        id: serial('id').primaryKey(),
        runId: text('run_id').notNull().unique(),
        cronType: text('cron_type').notNull(), // technical|news|options|fundamental|congress|execute|reconcile|digest
        status: text('status').notNull(), // running|completed|skipped|error
        outcome: text('outcome'),
        startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
        finishedAt: timestamp('finished_at', { withTimezone: true }),
        durationMs: integer('duration_ms'),
        summary: jsonb('summary'),
        error: text('error'),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [index('idx_cron_runs_type_started').on(table.cronType, table.startedAt)],
);

export const cronDecisions = pgTable(
    'cron_decisions',
    {
        id: serial('id').primaryKey(),
        runId: text('run_id').notNull(),
        cronType: text('cron_type').notNull(), // denormalized from cron_runs for type-filtered decision queries (technical|news|options|fundamental|congress|execute|reconcile|digest)
        symbol: text('symbol'),
        action: text('action').notNull(),
        executed: boolean('executed').default(false).notNull(),
        score: numeric('score'),
        reason: text('reason'),
        detail: jsonb('detail'),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        index('idx_cron_decisions_run').on(table.runId),
        index('idx_cron_decisions_symbol_created').on(table.symbol, table.createdAt),
    ],
);

export const newsCards = pgTable(
    'news_cards',
    {
        newsId: text('news_id').primaryKey(),
        symbol: text('symbol').notNull(),
        card: jsonb('card').notNull(),
        modelId: text('model_id').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [index('idx_news_cards_symbol_created').on(table.symbol, table.createdAt)],
);

/**
 * Notifications deferred during quiet hours (00:00–09:59 Asia/Seoul).
 * The morning digest cron (01:00 UTC = 10:00 KST) drains this table and
 * sends one consolidated email. Rows whose sentAt is NULL are "pending".
 */
export const notificationQueue = pgTable(
    'notification_queue',
    {
        id: serial('id').primaryKey(),
        /** Mirrors the dashboard event keys: 'trade_executed' | 'order_pending' | 'stop_loss' | 'error' */
        kind: text('kind').notNull(),
        subject: text('subject').notNull(),
        html: text('html').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        /** NULL until the digest cron marks the row consumed. */
        sentAt: timestamp('sent_at', { withTimezone: true }),
    },
    (table) => [
        // Pending-lookup index: most queries filter on sentAt IS NULL.
        index('idx_notification_queue_sent_at').on(table.sentAt),
    ],
);
