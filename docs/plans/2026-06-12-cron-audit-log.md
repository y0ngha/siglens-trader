# Plan: 크론 헬스 + 의사결정 감사 로그

## 목표
1. 모든 크론 호출을 기록 (정상/스킵/락충돌/휴장/에러 등 **빈손 종료 포함**)
2. 모든 의사결정의 "왜"를 영속·쿼리 가능하게 (심볼별 action + reason)
3. 실행 결과(`trades`)와 `run_id`로 교차 추적

## 비목표 (후속)
- 대시보드 UI 노출 (`/api/cron-runs` + 감사 탭)
- 누락 탐지 알림 (스케줄됐는데 행이 없는 경우)
- 보존 정책(90일 정리)

## 공통 원칙
- **베스트-에포트**: 감사 기록 쓰기는 모두 `try/catch`로 감싸 실패해도 매매/크론 로직을 절대 중단하지 않는다.
- 금액/numeric은 insert 시 `String(...)`, 없으면 `null`.
- ESM: api/lib 상대 import는 `.js` 확장자 필수.

---

## Task 1 — 스키마 + 마이그레이션 (cron_runs, cron_decisions)

`lib/db/schema.ts`에 테이블 2개 추가. `index`를 `drizzle-orm/pg-core` import에 추가.

```ts
export const cronRuns = pgTable(
    'cron_runs',
    {
        id: serial('id').primaryKey(),
        runId: text('run_id').notNull().unique(),
        cronType: text('cron_type').notNull(), // technical|news|options|fundamental|execute|reconcile
        status: text('status').notNull(), // running|completed|skipped|error
        outcome: text('outcome'), // completed|market_closed|us_market_holiday|trading_disabled|
                                  //   empty_watchlist|locked|daily_trade_limit|daily_loss_limit|error
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
        cronType: text('cron_type').notNull(),
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
```

- `yarn db:generate`로 마이그레이션 생성(`drizzle/00xx_*.sql`).
- `lib/db/clear.ts`: 삭제 대상 테이블 배열에 `cronRuns`, `cronDecisions` 추가(삭제 순서상 자식격인 cron_decisions 먼저 무방 — FK 없음).
- `lib/db/CLAUDE.md`: 테이블 표(9 → 11) 및 설명 갱신.

**검증**: `yarn typecheck`, `yarn db:generate`가 새 마이그레이션을 만든다. clear.ts가 새 테이블을 포함.

---

## Task 2 — DB 쿼리 헬퍼 + 단위 테스트

`lib/db/queries.ts`에 추가 (스키마 import에 `cronRuns`, `cronDecisions` 추가):

```ts
export async function startCronRun(
    db: Db,
    params: { runId: string; cronType: string; startedAt: Date },
) {
    return db
        .insert(cronRuns)
        .values({
            runId: params.runId,
            cronType: params.cronType,
            status: 'running',
            startedAt: params.startedAt,
        })
        .onConflictDoNothing();
}

export interface CronRunFinish {
    status: 'completed' | 'skipped' | 'error';
    outcome?: string;
    summary?: unknown;
    error?: string;
    durationMs?: number;
    finishedAt: Date;
}

export async function finishCronRun(db: Db, runId: string, p: CronRunFinish) {
    return db
        .update(cronRuns)
        .set({
            status: p.status,
            outcome: p.outcome,
            summary: p.summary,
            error: p.error,
            durationMs: p.durationMs,
            finishedAt: p.finishedAt,
        })
        .where(eq(cronRuns.runId, runId));
}

export interface CronDecisionInput {
    symbol?: string;
    action: string;
    executed?: boolean;
    score?: number;
    reason?: string;
    detail?: unknown;
}

export async function insertCronDecisions(
    db: Db,
    runId: string,
    cronType: string,
    decisions: CronDecisionInput[],
) {
    if (decisions.length === 0) return;
    return db.insert(cronDecisions).values(
        decisions.map((d) => ({
            runId,
            cronType,
            symbol: d.symbol,
            action: d.action,
            executed: d.executed ?? false,
            score: d.score != null ? String(d.score) : null,
            reason: d.reason,
            detail: d.detail,
        })),
    );
}
```

- `lib/db/__tests__/queries.test.ts`에 단위 테스트 추가 (기존 mock 빌더 패턴 사용): startCronRun이 insert().values().onConflictDoNothing() 호출, finishCronRun이 update().set().where(), insertCronDecisions가 빈 배열일 때 no-op·아닐 때 values에 매핑된 행(특히 score를 String으로) 전달.

**검증**: `yarn typecheck`, `yarn test lib/db/__tests__/queries.test.ts` 통과.

---

## Task 3 — 분석 크론 계측 (`api/cron/_run-analysis-cron.ts`)

공용 팩토리 한 곳을 계측하면 technical/news/options/fundamental 4종이 모두 커버됨.

- 진입부에서 `runId`(이미 `${analysisType}-${randomUUID()}` 형태로 생성됨, line 46 부근)를 **함수 최상단으로 끌어올려** 모든 조기 return 이전에 확보.
- `getDb()`로 db 확보 후 `startCronRun(db, { runId, cronType: analysisType, startedAt })`.
- `try/finally`로 종료 시 `finishCronRun` 호출:
  - `market_closed` → status:'skipped', outcome:'market_closed'
  - `another_execution_in_progress` → status:'skipped', outcome:'locked'
  - `disabled` → status:'skipped', outcome:'disabled'
  - `empty_watchlist` → status:'skipped', outcome:'empty_watchlist'
  - 정상 완료 → status:'completed', outcome:'completed', summary:{ analyzed: results.length }
  - 예외 → status:'error', error: message
- 분석 결과 자체는 `analysis_results`(cron_run_id 포함)에 이미 남으므로 `cron_decisions`는 분석 크론에선 생략(또는 심볼별 1행 action:'analyzed'). **이번 작업에선 생략**하고 cron_runs만 기록.
- 모든 감사 쓰기는 `try/catch`(베스트-에포트).
- `api/cron/__tests__/analysis-crons.test.ts`: 새 쿼리 mock 추가, 정상/스킵 시 startCronRun·finishCronRun이 적절한 outcome으로 호출되는지 검증.

**검증**: `yarn typecheck`, 해당 테스트 통과.

---

## Task 4 — execute 크론 계측 (`api/cron/execute.ts`)

- `cronRunId`(현재 232행 부근 `exec-<uuid>`) 생성을 **핸들러 최상단(락 시도 이전)** 으로 이동. `getDb()`도 락 이전에 호출(싱글톤이라 저렴).
- 락 시도 이전에 `startCronRun(db, { runId, cronType: 'execute', startedAt })`.
- `another_execution_in_progress`(락 실패)도 status:'skipped', outcome:'locked'로 기록 후 return.
- 기존 조기 return들에 outcome 매핑: market_closed / us_market_holiday / trading_disabled / daily_trade_limit_reached→'daily_trade_limit' / daily_loss_limit_reached(및 미실현 포함)→'daily_loss_limit' / empty_watchlist.
- 정상 완료: status:'completed', outcome:'completed', summary 집계:
  - `{ symbolsEvaluated, tradesExecuted, ordersCreated, positionsClosed, pendingCreated, decisionsByAction }`
  - `decisionsByAction`은 `decisions[]`의 action별 카운트.
- `finally`에서 `finishCronRun` + `insertCronDecisions(db, runId, 'execute', mapped)` 호출.
  - `decisions[]`(각 `{symbol, action, score}`)를 `CronDecisionInput[]`으로 매핑. 가능하면 reason도 포함(현재 decisions엔 reason이 없는 항목이 많으므로 있으면 채우고 없으면 생략).
  - 실제 체결 케이스(buy/sell/average_in 성공)는 executed:true, 나머지는 false.
- 모든 감사 쓰기는 베스트-에포트(try/catch). 락 해제(`finally`의 releaseLock)와 충돌하지 않도록 순서 유지.
- `api/cron/__tests__/execute.test.ts`: 새 쿼리 mock(startCronRun/finishCronRun/insertCronDecisions) 추가(기존 테스트가 깨지지 않게 기본 resolve). 대표 케이스(정상 완료, market_closed, locked, daily_loss_limit) 시 finishCronRun outcome 검증 + insertCronDecisions 호출 검증 1건.

**검증**: `yarn typecheck`, `yarn test api/cron/__tests__/execute.test.ts` 통과.

---

## Task 5 — reconcile 크론 계측 (`api/cron/reconcile.ts`)

- 핸들러 최상단에서 `runId = 'reconcile-<randomUUID()>'` 생성. 락 실패 시에도 기록하려면 `getDb()`를 락 이전에 호출.
- `startCronRun(db, { runId, cronType: 'reconcile', startedAt })` (락 이전).
- 락 실패 → status:'skipped', outcome:'locked'.
- 정상 완료 → status:'completed', outcome:'completed', summary: `{ processed: results.length, resolved, timeouts, needsReview, recovered: recovery.recovered, recoveryFailed: recovery.failed, consistencyAlerts: consistency.alerts.length, holdingsMismatches }`.
- 예외 → status:'error'.
- `finally`에서 finishCronRun + `insertCronDecisions(db, runId, 'reconcile', results.map(r => ({ symbol: r.symbol, action: r.action })))`.
- 베스트-에포트(try/catch). 기존 `notifyError` 게이트/락 로직 보존.
- `api/cron/__tests__/reconcile.test.ts`: 새 쿼리 mock 추가, 정상/락 시 finishCronRun outcome 검증 + insertCronDecisions 호출 검증.

**검증**: `yarn typecheck`, `yarn test api/cron/__tests__/reconcile.test.ts` 통과.

---

## 최종 검증
- `yarn typecheck && yarn lint && yarn test` 전체 통과.
- 마이그레이션 파일 1개 신규 생성.
- 문서(`lib/db/CLAUDE.md`) 갱신.
