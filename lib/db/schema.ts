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
        /**
         * 이 결과를 만든 **프롬프트 세대**. 배포 이미지 태그(`APP_VERSION`)를 그대로 쓴다.
         *
         * 프롬프트는 저장하지 않는다 — 스킬이 샘플링돼 실려 한 건에 수십 KB이고, 응답 쪽은
         * `result`가 곧 파싱된 원문이라 원문을 따로 둘 이유가 없다. 하지만 **어느 세대가
         * 만든 행인지**를 모르면 프롬프트를 바꾼 전후를 데이터만으로 가를 수 없고, 그러면
         * 감사 테이블을 두고도 전후 비교가 불가능해진다(원칙 11).
         *
         * core 버전이 아니라 앱 태그인 이유: core의 `package.json`은 `exports`에 막혀
         * 런타임에 읽을 수 없고, core 업그레이드는 언제나 새 릴리스로만 나가므로 태그가
         * 세대를 그대로 가리킨다. 게다가 앱 태그는 **trader 자신의 프롬프트 변경**
         * (`lib/analysis/trade-gate.ts`)까지 함께 잡는다. 태그 → core 버전은 그 태그의
         * `package.json`으로 역추적한다.
         *
         * 로컬 개발에서는 `APP_VERSION`이 없어 NULL이다.
         */
        appVersion: text('app_version'),
        /**
         * 이 결과가 생성될 때 적용 중이던 `analysis_timeframe`(전역 설정, `POST /api/config`로
         * 런타임에 바뀔 수 있다 — `lib/analysis/timeframe.ts`). '1Hour'로 백필한다
         * (`DEFAULT_ANALYSIS_TIMEFRAME`과 같은 값이지만, `lib/db/`는 `lib/analysis/`를
         * import할 수 없어(레이어 규칙) 리터럴을 중복해 둔다).
         *
         * **왜 필요한가.** 운영자가 타임프레임을 바꾸면 그 전후에 쌓인 행이 이 컬럼 없이는
         * 구분되지 않는다. prior-analysis 이력 기능은 과거 분석을 **봉에 고정**해 프롬프트에
         * 넣는데(siglens-core가 바 앵커드 윈도우로 재단), 예를 들어 1Hour로 생성된 분석을
         * 15Min 봉 옆에 놓고 비교하면 애초에 그 해상도로 조건화된 적 없는 신호를 실제
         * 가격 움직임에 잘못 귀속시키게 된다.
         */
        timeframe: text('timeframe').notNull().default('1Hour'),
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
        // prior-analysis 읽기 쿼리(getRecentAnalysisResults) 전용 — symbol + analysisType +
        // timeframe 동등 비교 후 analyzedAt DESC. 위 인덱스에 timeframe을 끼워 넣지 않는
        // 이유: getAllLatestAnalysisResults의 DISTINCT ON (symbol, analysisType) ORDER BY
        // symbol, analysisType, analyzedAt DESC가 그 인덱스 순서와 정확히 일치해야 인덱스만으로
        // 풀리는데, 중간에 timeframe이 끼면 그 일치가 깨진다.
        index('idx_analysis_symbol_type_timeframe_date').on(
            table.symbol,
            table.analysisType,
            table.timeframe,
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
 * 사이징 게이트 호출 1건의 원문 기록 — 나간 프롬프트와 받은 응답 그대로.
 *
 * **왜 별도 테이블인가.** `cron_decisions.detail.gate`는 이미 게이트의 *결론*
 * (fraction·confidence·reason)을 남긴다. 없는 것은 그 결론이 나온 *입력*이다. 프롬프트는
 * 6축 요약·계좌 상태·예산·보유 맥락을 다 담아 수 KB이고, 그걸 모든 결정 행의 jsonb에 넣으면
 * 매 틱 모든 종목이 그 비용을 낸다. 실제로 읽는 시점은 "이 매매는 왜 이렇게 됐나"를 되짚을
 * 때뿐이라 조회 빈도와 크기가 정확히 반대다.
 *
 * **왜 `trade_id` FK가 아닌가.** 게이트는 주문이 나가기 전에 호출되고, 그 호출이 트레이드
 * 행으로 이어지지 않는 경우(fraction 0, 게이트 오류로 진입 취소, 브로커 거절)가 오히려 더
 * 알고 싶은 케이스다. FK를 걸면 그 행들이 기록될 자리가 없다. 대신 이 스키마가 이미 쓰는
 * 상관 키를 따른다 — `cron_decisions`가 `run_id` + `symbol`로 묶이는 것과 같은 방식이고,
 * `trades.cron_run_id`도 같은 값을 들고 있어 셋이 한 런에서 조인된다.
 *
 * 조인 예:
 *   SELECT t.*, a.user_prompt, a.raw_response
 *   FROM trades t JOIN trade_audit a
 *     ON a.cron_run_id = t.cron_run_id AND a.symbol = t.symbol
 *    AND a.kind = CASE WHEN t.side = 'buy' THEN 'entry' ELSE 'exit' END
 *   WHERE t.realized_pnl::numeric < 0;
 *
 * 한 런에서 같은 심볼이 `exit` 게이트를 두 번 탈 수 있으므로(아래 `correlationId` 참고)
 * 정확히 1:1로 묶어야 하면 `correlation_id`로 조인한다.
 */
export const tradeAudit = pgTable(
    'trade_audit',
    {
        id: serial('id').primaryKey(),
        symbol: text('symbol').notNull(),
        /** 'entry' | 'exit' — 같은 런·같은 종목에서 둘 다 나올 수 있어 상관 키의 일부다. */
        kind: text('kind').notNull(),
        modelId: text('model_id').notNull(),
        systemPrompt: text('system_prompt').notNull(),
        userPrompt: text('user_prompt').notNull(),
        /** NULL = 호출 자체가 실패해 응답이 없었다 (타임아웃·provider 오류). */
        rawResponse: text('raw_response'),
        /** 'ok' | 'error' — 파싱까지 성공했는가. 실패 사유는 `gateError`. */
        status: text('status').notNull(),
        gateError: text('gate_error'),
        /** 파싱된 결론. 실패면 NULL — 그때 무엇이 대신 결정했는지는 `cron_decisions`에 있다. */
        fraction: numeric('fraction'),
        confidence: integer('confidence'),
        cronRunId: text('cron_run_id'),
        /**
         * 게이트 호출 1건의 유일 키 (`<runId>-<symbol>-entry|exit|signal-sell`).
         *
         * `(cron_run_id, symbol, kind)`만으로는 유일하지 않다 — 재평가 청산이 `fraction 0`으로
         * 미뤄지면 그 심볼은 `exitedSymbols`에 기록되지 않아 같은 런의 시그널 매도가 다시
         * 게이트를 태울 수 있고, `kind: 'exit'` 행이 둘이 되어 아래 조인이 팬아웃한다.
         * 두 행을 구분할 값은 execute가 이미 게이트에 넘기고 있었고, 여기 같이 저장한다.
         */
        correlationId: text('correlation_id'),
        userId: ownerUserId(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        index('idx_trade_audit_run_symbol').on(table.cronRunId, table.symbol),
        index('idx_trade_audit_symbol_created').on(table.symbol, table.createdAt),
        // 보존 정책이 생기면 `WHERE created_at < …`가 이 인덱스를 탄다. TOAST된 테이블을
        // seq-scan하는 것과 차이가 크고, 인덱스 하나 값이 그보다 싸다.
        index('idx_trade_audit_created').on(table.createdAt),
    ],
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
