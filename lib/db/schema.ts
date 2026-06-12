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
    uniqueIndex,
    index,
} from 'drizzle-orm/pg-core';

export const watchlist = pgTable('watchlist', {
    id: serial('id').primaryKey(),
    symbol: text('symbol').notNull().unique(),
    companyName: text('company_name').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const analysisModelConfig = pgTable('analysis_model_config', {
    id: serial('id').primaryKey(),
    analysisType: text('analysis_type').notNull().unique(),
    enabled: boolean('enabled').default(true).notNull(),
    modelId: text('model_id').notNull(),
    useByok: boolean('use_byok').default(false).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const analysisResults = pgTable('analysis_results', {
    id: serial('id').primaryKey(),
    symbol: text('symbol').notNull(),
    analysisType: text('analysis_type').notNull(),
    result: jsonb('result').notNull(),
    modelId: text('model_id').notNull(),
    analyzedAt: timestamp('analyzed_at', { withTimezone: true }).notNull(),
    cronRunId: text('cron_run_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

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
    },
    (table) => [
        uniqueIndex('idx_positions_symbol_open')
            .on(table.symbol)
            .where(sql`status = 'open'`),
    ],
);

export const trades = pgTable('trades', {
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const pendingOrders = pgTable('pending_orders', {
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
});

export const config = pgTable('config', {
    key: text('key').primaryKey(),
    value: jsonb('value').notNull(),
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
});

export const notificationConfig = pgTable('notification_config', {
    id: serial('id').primaryKey(),
    channel: text('channel').notNull().unique(),
    enabled: boolean('enabled').default(true).notNull(),
    target: text('target').notNull(),
    events: text('events').array().default([]).notNull(),
});

// status = lifecycle (running→completed/skipped/error); outcome = machine-readable reason (market_closed, locked, …); summary = structured counts
export const cronRuns = pgTable(
    'cron_runs',
    {
        id: serial('id').primaryKey(),
        runId: text('run_id').notNull().unique(),
        cronType: text('cron_type').notNull(), // technical|news|options|fundamental|execute|reconcile
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
        cronType: text('cron_type').notNull(), // denormalized from cron_runs for type-filtered decision queries
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
