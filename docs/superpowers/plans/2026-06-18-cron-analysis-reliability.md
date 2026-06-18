# Cron Analysis Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기술 분석을 설정 가능한 15분·30분·1시간봉으로 실행하고, 실제 분석 시각·크론 timeout·결정 근거·뉴스 처리 시간·운영 설정을 신뢰할 수 있게 만든다.

**Architecture:** 설정 계약과 분석 시각 처리를 작은 공용 모듈로 분리하고, 모든 크론이 동일한 감사 복구 함수를 호출한다. 뉴스 카드는 최대 3개 worker-pool과 절대 deadline을 사용하며, DB 마이그레이션은 스키마 추가와 운영 기본값 명시를 한 번에 적용한다.

**Tech Stack:** TypeScript 5, React 19, Vite, Vitest, Drizzle ORM/PostgreSQL, Vercel Functions, `@y0ngha/siglens-core@0.23.0`

---

## File Structure

- Create `lib/analysis/timeframe.ts`: 허용 타임프레임, 기본값, stale 허용시간을 단일 정의한다.
- Create `lib/analysis/source-time.ts`: 분석 결과의 원본 `analyzedAt` 파싱과 기준 시각 선택을 담당한다.
- Modify `lib/db/schema.ts`: `analysis_results.source_analyzed_at`을 선언한다.
- Modify `lib/db/queries.ts`: 원본 분석 시각 저장, 오래된 running 종결, timeout outcome을 구현한다.
- Modify `api/cron/_run-analysis-cron.ts`: 설정 정규화, deadline 전달, stale 감사 종결, 원본 분석 시각 저장을 연결한다.
- Modify `api/cron/execute.ts`: 타임프레임별 신선도 검사와 hold 상세 감사를 연결한다.
- Modify `api/cron/reconcile.ts`: 크론 시작 전 stale 감사 종결을 연결한다.
- Modify `lib/analysis/types.ts`: 분석 deadline을 runner 계약에 추가한다.
- Modify `lib/analysis/enrich-news-cards.ts`: 최신 10건, 동시성 3, deadline, 실패 상한을 구현한다.
- Modify `lib/analysis/run-news.ts`: deadline을 카드 생성과 종합 분석 전에 검사한다.
- Modify `api/config.ts`, `src/pages/Settings.tsx`: 세 타임프레임만 허용하고 표시한다.
- Modify `src/pages/Analysis.tsx`: 원본 분석 시각을 표시 및 stale 판정에 사용한다.
- Modify `lib/db/seed.ts`, `src/mocks/handlers.ts`: 기본 타임프레임을 `1Hour`로 맞춘다.
- Create `drizzle/0010_cron_analysis_reliability.sql` and snapshot: 컬럼과 운영 기본값을 배포한다.
- Modify `package.json`, `yarn.lock`: siglens-core를 `0.23.0`으로 고정한다.

### Task 1: Analysis Timeframe Contract

**Files:**
- Create: `lib/analysis/timeframe.ts`
- Create: `lib/analysis/__tests__/timeframe.test.ts`
- Modify: `api/config.ts`
- Modify: `api/__tests__/routes.test.ts`

- [ ] **Step 1: Write failing timeframe contract tests**

```ts
import { describe, expect, it } from 'vitest';
import {
    ANALYSIS_TIMEFRAMES,
    DEFAULT_ANALYSIS_TIMEFRAME,
    normalizeAnalysisTimeframe,
    getTechnicalMaxAgeMs,
} from '../timeframe';

describe('analysis timeframe contract', () => {
    it('supports only 15m, 30m, and 1h', () => {
        expect(ANALYSIS_TIMEFRAMES).toEqual(['15Min', '30Min', '1Hour']);
        expect(DEFAULT_ANALYSIS_TIMEFRAME).toBe('1Hour');
    });

    it('falls back to 1Hour for missing or legacy values', () => {
        expect(normalizeAnalysisTimeframe(null)).toBe('1Hour');
        expect(normalizeAnalysisTimeframe('1Day')).toBe('1Hour');
    });

    it.each([
        ['15Min', 45 * 60_000],
        ['30Min', 90 * 60_000],
        ['1Hour', 2 * 60 * 60_000],
    ] as const)('maps %s to its max age', (timeframe, expected) => {
        expect(getTechnicalMaxAgeMs(timeframe)).toBe(expected);
    });
});
```

Update the config API tests so only `15Min`, `30Min`, and `1Hour` return 200, while `5Min`, `4Hour`, and `1Day` return 400.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
yarn vitest run lib/analysis/__tests__/timeframe.test.ts api/__tests__/routes.test.ts
```

Expected: FAIL because `lib/analysis/timeframe.ts` does not exist and the API still accepts six values.

- [ ] **Step 3: Implement the shared contract**

```ts
import type { Timeframe } from '@y0ngha/siglens-core';

export const ANALYSIS_TIMEFRAMES = ['15Min', '30Min', '1Hour'] as const;
export type AnalysisTimeframe = (typeof ANALYSIS_TIMEFRAMES)[number];
export const DEFAULT_ANALYSIS_TIMEFRAME: AnalysisTimeframe = '1Hour';

export function isAnalysisTimeframe(value: unknown): value is AnalysisTimeframe {
    return (
        typeof value === 'string' &&
        (ANALYSIS_TIMEFRAMES as readonly string[]).includes(value)
    );
}

export function normalizeAnalysisTimeframe(value: unknown): AnalysisTimeframe {
    return isAnalysisTimeframe(value) ? value : DEFAULT_ANALYSIS_TIMEFRAME;
}

export function toCoreTimeframe(value: unknown): Timeframe {
    return normalizeAnalysisTimeframe(value);
}

const MAX_AGE_MS: Record<AnalysisTimeframe, number> = {
    '15Min': 45 * 60_000,
    '30Min': 90 * 60_000,
    '1Hour': 2 * 60 * 60_000,
};

export function getTechnicalMaxAgeMs(timeframe: AnalysisTimeframe): number {
    return MAX_AGE_MS[timeframe];
}
```

In `api/config.ts`, replace the six-value set with `isAnalysisTimeframe(value)` and return:

```ts
{
    error: 'analysis_timeframe must be one of: 15Min, 30Min, 1Hour'
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
yarn vitest run lib/analysis/__tests__/timeframe.test.ts api/__tests__/routes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/analysis/timeframe.ts lib/analysis/__tests__/timeframe.test.ts api/config.ts api/__tests__/routes.test.ts
git commit -m "feat: constrain technical analysis timeframes"
```

### Task 2: Settings UI and Defaults

**Files:**
- Modify: `src/pages/Settings.tsx`
- Modify: `src/pages/__tests__/Settings.test.tsx`
- Modify: `src/mocks/handlers.ts`
- Modify: `lib/db/seed.ts`

- [ ] **Step 1: Add failing UI tests**

Add `analysis_timeframe: '1Hour'` to the settings fixture and test:

```ts
it('renders only the supported analysis timeframes', async () => {
    mockedApi.getConfig.mockResolvedValue(mockConfig);
    renderWithQuery(<SettingsPage />);

    const select = await screen.findByLabelText('기술 분석 차트 주기');
    expect(select).toHaveValue('1Hour');
    expect(screen.getByRole('option', { name: '15분' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '30분' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '1시간' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '1일' })).not.toBeInTheDocument();
});

it('saves the selected analysis timeframe', async () => {
    const user = userEvent.setup();
    mockedApi.getConfig.mockResolvedValue(mockConfig);
    mockedApi.updateConfig.mockResolvedValue(undefined);
    renderWithQuery(<SettingsPage />);

    const select = await screen.findByLabelText('기술 분석 차트 주기');
    await user.selectOptions(select, '30Min');

    expect(mockedApi.updateConfig).toHaveBeenCalledWith({
        type: 'config',
        key: 'analysis_timeframe',
        value: '30Min',
    });
});
```

- [ ] **Step 2: Verify the UI tests fail**

Run:

```bash
yarn vitest run src/pages/__tests__/Settings.test.tsx
```

Expected: FAIL because no timeframe selector exists.

- [ ] **Step 3: Add the selector and defaults**

In `Settings.tsx`, read the value with fallback `1Hour` and render:

```tsx
<label htmlFor="analysis-timeframe" className="text-xs text-neutral-400">
    기술 분석 차트 주기
</label>
<select
    id="analysis-timeframe"
    className="mt-1 w-full rounded-lg border border-[#262626] bg-[#0a0a0a] px-3 py-2 text-sm"
    value={analysisTimeframe}
    onChange={(event) =>
        mutate({
            type: 'config',
            key: 'analysis_timeframe',
            value: event.target.value,
        })
    }
>
    <option value="15Min">15분</option>
    <option value="30Min">30분</option>
    <option value="1Hour">1시간</option>
</select>
```

Change seed and mock defaults from `1Day` to `1Hour`.

- [ ] **Step 4: Run the UI tests**

Run:

```bash
yarn vitest run src/pages/__tests__/Settings.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Settings.tsx src/pages/__tests__/Settings.test.tsx src/mocks/handlers.ts lib/db/seed.ts
git commit -m "feat: add technical timeframe setting"
```

### Task 3: Persist Source Analysis Time

**Files:**
- Create: `lib/analysis/source-time.ts`
- Create: `lib/analysis/__tests__/source-time.test.ts`
- Modify: `lib/db/schema.ts`
- Modify: `lib/db/queries.ts`
- Modify: `lib/db/__tests__/queries.test.ts`
- Modify: `api/cron/_run-analysis-cron.ts`
- Modify: `api/cron/__tests__/analysis-crons.test.ts`
- Modify: `api/cron/execute.ts`

- [ ] **Step 1: Write failing source-time tests**

```ts
import { describe, expect, it } from 'vitest';
import { extractSourceAnalyzedAt, getAnalysisReferenceTime } from '../source-time';

describe('source analysis time', () => {
    it('extracts a valid result analyzedAt', () => {
        expect(
            extractSourceAnalyzedAt({ analyzedAt: '2026-06-17T14:03:03.109Z' })?.toISOString(),
        ).toBe('2026-06-17T14:03:03.109Z');
    });

    it('returns the fallback for missing or invalid values', () => {
        const fallback = new Date('2026-06-17T15:00:00Z');
        expect(extractSourceAnalyzedAt({}, fallback)).toEqual(fallback);
        expect(extractSourceAnalyzedAt({ analyzedAt: 'bad' }, fallback)).toEqual(fallback);
    });

    it('prefers sourceAnalyzedAt over analyzedAt', () => {
        expect(
            getAnalysisReferenceTime({
                sourceAnalyzedAt: new Date('2026-06-17T14:00:00Z'),
                analyzedAt: new Date('2026-06-17T15:00:00Z'),
            }).toISOString(),
        ).toBe('2026-06-17T14:00:00.000Z');
    });
});
```

Update query tests to expect `sourceAnalyzedAt` in inserted values. Update analysis cron tests to return `{ analyzedAt: '2026-05-24T09:55:00Z' }` and assert that exact date is saved.

- [ ] **Step 2: Verify focused tests fail**

Run:

```bash
yarn vitest run lib/analysis/__tests__/source-time.test.ts lib/db/__tests__/queries.test.ts api/cron/__tests__/analysis-crons.test.ts
```

Expected: FAIL because the helper and column do not exist.

- [ ] **Step 3: Implement source-time parsing and persistence**

```ts
export function extractSourceAnalyzedAt(
    result: unknown,
    fallback?: Date,
): Date | undefined {
    if (result && typeof result === 'object' && 'analyzedAt' in result) {
        const value = (result as { analyzedAt?: unknown }).analyzedAt;
        if (typeof value === 'string') {
            const parsed = new Date(value);
            if (Number.isFinite(parsed.getTime())) return parsed;
        }
    }
    return fallback;
}

export function getAnalysisReferenceTime(row: {
    sourceAnalyzedAt?: Date | string | null;
    analyzedAt: Date | string;
}): Date {
    const source = row.sourceAnalyzedAt ? new Date(row.sourceAnalyzedAt) : null;
    if (source && Number.isFinite(source.getTime())) return source;
    return new Date(row.analyzedAt);
}
```

Add to `analysisResults`:

```ts
sourceAnalyzedAt: timestamp('source_analyzed_at', { withTimezone: true }),
```

Extend `saveAnalysisResult` params with `sourceAnalyzedAt?: Date` and pass it to `.values()`.

In `_run-analysis-cron.ts`, use one save timestamp:

```ts
const savedAt = new Date();
await saveAnalysisResult(db, {
    symbol: item.symbol,
    analysisType,
    result: result.result,
    modelId: config.modelId,
    analyzedAt: savedAt,
    sourceAnalyzedAt: extractSourceAnalyzedAt(result.result, savedAt),
    cronRunId,
});
```

Apply the same helper to overall-result saves in `execute.ts`.

- [ ] **Step 4: Run focused tests**

Run:

```bash
yarn vitest run lib/analysis/__tests__/source-time.test.ts lib/db/__tests__/queries.test.ts api/cron/__tests__/analysis-crons.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/analysis/source-time.ts lib/analysis/__tests__/source-time.test.ts lib/db/schema.ts lib/db/queries.ts lib/db/__tests__/queries.test.ts api/cron/_run-analysis-cron.ts api/cron/__tests__/analysis-crons.test.ts api/cron/execute.ts
git commit -m "feat: preserve source analysis timestamps"
```

### Task 4: Timeframe-Aware Freshness Checks

**Files:**
- Modify: `api/cron/execute.ts`
- Modify: `api/cron/__tests__/execute.test.ts`
- Modify: `src/pages/Analysis.tsx`
- Modify: `src/pages/__tests__/Analysis.test.tsx`

- [ ] **Step 1: Add failing execute freshness tests**

Add cases proving:

```ts
it.each([
    ['15Min', 46],
    ['30Min', 91],
    ['1Hour', 121],
] as const)('rejects stale %s source analysis', async (timeframe, ageMinutes) => {
    mockGetConfigValue.mockImplementation(async (_db, key) => {
        if (key === 'analysis_timeframe') return timeframe;
        return configDefaults[key];
    });
    mockGetLatestAnalysisResult.mockResolvedValue({
        result: fakeTechResult,
        analyzedAt: new Date(),
        sourceAnalyzedAt: new Date(Date.now() - ageMinutes * 60_000),
    });

    const response = await handler(makeRequest());
    expect(await response.json()).toEqual(
        expect.objectContaining({
            decisions: expect.arrayContaining([
                expect.objectContaining({ action: 'stale_analysis' }),
            ]),
        }),
    );
});
```

Add a case where `analyzedAt` is fresh but `sourceAnalyzedAt` is stale, and a legacy case where `sourceAnalyzedAt` is null and `analyzedAt` is used.

Update Analysis page tests so the rendered timestamp comes from `sourceAnalyzedAt ?? analyzedAt ?? createdAt`.

- [ ] **Step 2: Verify focused tests fail**

Run:

```bash
yarn vitest run api/cron/__tests__/execute.test.ts src/pages/__tests__/Analysis.test.tsx
```

Expected: FAIL because freshness still uses a fixed four-hour threshold and `createdAt`.

- [ ] **Step 3: Implement shared freshness use**

At execute startup, normalize the configured timeframe once:

```ts
const analysisTimeframe = normalizeAnalysisTimeframe(
    await getConfigValue<string>(db, 'analysis_timeframe'),
);
const maxTechnicalAgeMs = getTechnicalMaxAgeMs(analysisTimeframe);
```

Replace both technical age checks with:

```ts
const technicalSourceTime = tech ? getAnalysisReferenceTime(tech) : null;
const techAge = technicalSourceTime
    ? Date.now() - technicalSourceTime.getTime()
    : Infinity;
if (techAge > maxTechnicalAgeMs) {
    decisions.push({
        symbol,
        action: 'stale_analysis',
        score: 0,
        detail: {
            timeframe: analysisTimeframe,
            maxAgeMs: maxTechnicalAgeMs,
            sourceAnalyzedAt: technicalSourceTime?.toISOString() ?? null,
        },
    });
    continue;
}
```

Extend `AnalysisEntry` with `analyzedAt` and `sourceAnalyzedAt`; use a helper that selects `sourceAnalyzedAt ?? analyzedAt ?? createdAt`.

- [ ] **Step 4: Run focused tests**

Run:

```bash
yarn vitest run api/cron/__tests__/execute.test.ts src/pages/__tests__/Analysis.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/cron/execute.ts api/cron/__tests__/execute.test.ts src/pages/Analysis.tsx src/pages/__tests__/Analysis.test.tsx
git commit -m "feat: enforce timeframe-aware analysis freshness"
```

### Task 5: Finalize Stale Cron Runs

**Files:**
- Modify: `lib/db/queries.ts`
- Modify: `lib/db/__tests__/queries.test.ts`
- Modify: `api/cron/_run-analysis-cron.ts`
- Modify: `api/cron/execute.ts`
- Modify: `api/cron/reconcile.ts`
- Modify: `api/cron/__tests__/analysis-crons.test.ts`
- Modify: `api/cron/__tests__/execute.test.ts`
- Modify: `api/cron/__tests__/reconcile.test.ts`

- [ ] **Step 1: Write failing stale-run query tests**

Test that the query performs an update equivalent to:

```sql
UPDATE cron_runs
SET status = 'error',
    outcome = 'timeout',
    finished_at = now,
    duration_ms = EXTRACT(EPOCH FROM (now - started_at)) * 1000,
    error = 'Cron exceeded maximum execution time'
WHERE status = 'running'
  AND started_at < now - 15 minutes
```

Also update `finishCronRun` tests to accept:

```ts
{
    status: 'error',
    outcome: 'timeout',
    error: 'Cron exceeded maximum execution time',
    finishedAt
}
```

- [ ] **Step 2: Verify query tests fail**

Run:

```bash
yarn vitest run lib/db/__tests__/queries.test.ts
```

Expected: FAIL because `finalizeStaleCronRuns` and error outcome support do not exist.

- [ ] **Step 3: Implement the atomic finalizer**

Add:

```ts
export const CRON_STALE_AFTER_MS = 15 * 60_000;

export async function finalizeStaleCronRuns(
    db: Db,
    now = new Date(),
): Promise<unknown> {
    const cutoff = new Date(now.getTime() - CRON_STALE_AFTER_MS);
    return db.execute(sql`
        UPDATE cron_runs
        SET status = 'error',
            outcome = 'timeout',
            finished_at = ${now},
            duration_ms = FLOOR(EXTRACT(EPOCH FROM (${now} - started_at)) * 1000),
            error = 'Cron exceeded maximum execution time'
        WHERE status = 'running'
          AND started_at < ${cutoff}
    `);
}
```

Add `'timeout'` to `CronOutcome`, and allow the error finish variant to carry `outcome?: 'timeout'`. Set that outcome in `finishCronRun`.

- [ ] **Step 4: Call the finalizer before every new audit row**

In `_run-analysis-cron.ts`, `execute.ts`, and `reconcile.ts`:

```ts
await safe(finalizeStaleCronRuns(db, startedAt));
await safe(startCronRun(db, { ... }));
```

Update route mocks and assert this call precedes `startCronRun`.

- [ ] **Step 5: Run audit tests**

Run:

```bash
yarn vitest run lib/db/__tests__/queries.test.ts api/cron/__tests__/analysis-crons.test.ts api/cron/__tests__/execute.test.ts api/cron/__tests__/reconcile.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/db/queries.ts lib/db/__tests__/queries.test.ts api/cron/_run-analysis-cron.ts api/cron/execute.ts api/cron/reconcile.ts api/cron/__tests__/analysis-crons.test.ts api/cron/__tests__/execute.test.ts api/cron/__tests__/reconcile.test.ts
git commit -m "feat: finalize timed out cron audit rows"
```

### Task 6: Persist Decision Reasons and Score Components

**Files:**
- Modify: `api/cron/execute.ts`
- Modify: `api/cron/__tests__/execute.test.ts`
- Modify: `src/pages/CronRuns.tsx`
- Modify: `src/pages/__tests__/CronRuns.test.tsx`

- [ ] **Step 1: Add failing hold-audit tests**

Assert that a hold decision passed to `insertCronDecisions` contains:

```ts
expect.objectContaining({
    symbol: 'NVDA',
    action: 'hold',
    executed: false,
    reason: expect.stringContaining('신호'),
    detail: {
        components: {
            technical: expect.any(Number),
            news: expect.any(Number),
            options: expect.any(Number),
            fundamental: expect.any(Number),
            overall: expect.any(Number),
        },
        signal: 'hold',
        thresholds: { buy: 70, sell: 30 },
        sourceAnalyzedAt: expect.any(String),
    },
})
```

Add a CronRuns UI test that displays the reason and component scores when detail is present.

- [ ] **Step 2: Verify focused tests fail**

Run:

```bash
yarn vitest run api/cron/__tests__/execute.test.ts src/pages/__tests__/CronRuns.test.tsx
```

Expected: FAIL because hold drops `reason` and `detail`.

- [ ] **Step 3: Add a decision audit-detail helper**

Inside `execute.ts`, add:

```ts
function scoreDecisionDetail(
    signalScore: SignalScore,
    buyThreshold: number,
    sellThreshold: number,
    sourceAnalyzedAt: Date | null,
) {
    return {
        components: signalScore.components,
        signal: signalScore.signal,
        thresholds: { buy: buyThreshold, sell: sellThreshold },
        sourceAnalyzedAt: sourceAnalyzedAt?.toISOString() ?? null,
    };
}
```

Use it in the hold branch:

```ts
decisions.push({
    symbol: item.symbol,
    action: decision.action,
    score: decision.score,
    executed: false,
    reason: decision.reason,
    detail: scoreDecisionDetail(
        signalScore,
        buyThreshold,
        sellThreshold,
        technicalSourceTime,
    ),
});
```

Carry the same detail into successful buy/sell/average-in decisions where no more specific error detail replaces it.

- [ ] **Step 4: Render structured decision detail**

In `CronRuns.tsx`, safely read `detail.components` and show:

```tsx
<span>
    기술 {components.technical} · 뉴스 {components.news} · 옵션 {components.options} ·
    펀더멘털 {components.fundamental} · 종합 {components.overall}
</span>
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
yarn vitest run api/cron/__tests__/execute.test.ts src/pages/__tests__/CronRuns.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/cron/execute.ts api/cron/__tests__/execute.test.ts src/pages/CronRuns.tsx src/pages/__tests__/CronRuns.test.tsx
git commit -m "feat: audit trading decision rationale"
```

### Task 7: News Card Worker Pool and Deadline

**Files:**
- Modify: `lib/analysis/types.ts`
- Modify: `lib/analysis/enrich-news-cards.ts`
- Modify: `lib/analysis/run-news.ts`
- Modify: `api/cron/_run-analysis-cron.ts`
- Modify: `lib/analysis/__tests__/enrich-news-cards.test.ts`
- Modify: `lib/analysis/__tests__/run-news.test.ts`
- Modify: `api/cron/__tests__/analysis-crons.test.ts`

- [ ] **Step 1: Replace sequential-behavior tests with pool tests**

Add deterministic tests for:

```ts
it('caps input at 10 articles', async () => {
    // 100 inputs -> getCards receives 10 ids and submit is called 10 times.
});

it('never exceeds concurrency 3', async () => {
    let active = 0;
    let maxActive = 0;
    mockSubmit.mockImplementation(async ({ item }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gates[item.id];
        active -= 1;
        return { status: 'submitted', jobId: item.id };
    });
    await enrichNewsCards(fakeStore, 'NVDA', news, { deadlineMs: Infinity });
    expect(maxActive).toBe(3);
});

it('does not submit new cards after the deadline', async () => {
    await enrichNewsCards(fakeStore, 'NVDA', news, { deadlineMs: Date.now() - 1 });
    expect(mockSubmit).not.toHaveBeenCalled();
});

it('stops new work after six total failures', async () => {
    mockPoll.mockResolvedValue({ status: 'error', error: 'worker down' });
    await enrichNewsCards(fakeStore, 'NVDA', tenNews, { deadlineMs: Infinity });
    expect(mockSubmit.mock.calls.length).toBeLessThanOrEqual(8);
});
```

Update run-news tests to assert deadline forwarding and pre-submit skipping when expired.

- [ ] **Step 2: Verify focused tests fail**

Run:

```bash
yarn vitest run lib/analysis/__tests__/enrich-news-cards.test.ts lib/analysis/__tests__/run-news.test.ts api/cron/__tests__/analysis-crons.test.ts
```

Expected: FAIL because the implementation is sequential and has no deadline.

- [ ] **Step 3: Extend the runner contract**

In `RunAnalysisOptions`:

```ts
deadlineMs?: number;
```

In `_run-analysis-cron.ts`:

```ts
const analysisDeadlineMs = startedMs + 690_000;
// runner options
deadlineMs: analysisDeadlineMs,
```

Normalize the configured timeframe with `toCoreTimeframe(timeframe)`.

- [ ] **Step 4: Implement the fixed worker pool**

Use:

```ts
export const NEWS_ENRICH_LIMIT = 10;
export const NEWS_ENRICH_CONCURRENCY = 3;
export const ENRICH_TOTAL_FAILURE_LIMIT = 6;

export async function enrichNewsCards(
    store: NewsCardStore,
    symbol: string,
    news: NewsItem[],
    options: { deadlineMs?: number } = {},
): Promise<EnrichedNewsItem[]> {
    const deadlineMs = options.deadlineMs ?? Number.POSITIVE_INFINITY;
    const capped = news.slice(0, NEWS_ENRICH_LIMIT);
    const cached = await store.getCards(capped.map((item) => item.id));
    const missing = capped.filter((item) => !cached.has(item.id));
    const fresh: Array<{ item: NewsItem; card: NewsCardAnalysis }> = [];
    let nextIndex = 0;
    let failures = 0;

    async function worker(): Promise<void> {
        while (Date.now() < deadlineMs && failures < ENRICH_TOTAL_FAILURE_LIMIT) {
            const index = nextIndex++;
            const item = missing[index];
            if (!item) return;
            const generated = await generateCard(item).catch(() => null);
            if (generated === null) {
                failures += 1;
                continue;
            }
            fresh.push({ item, card: generated });
        }
    }

    await Promise.all(
        Array.from(
            { length: Math.min(NEWS_ENRICH_CONCURRENCY, missing.length) },
            () => worker(),
        ),
    );

    if (fresh.length > 0) {
        await store
            .upsertCards(
                fresh.map(({ item, card }) => ({
                    newsId: item.id,
                    symbol,
                    card,
                    modelId: CARD_MODEL_ID,
                })),
            )
            .catch((error) =>
                console.error(
                    '[enrich-news-cards] persist failed (proceeding with in-memory)',
                    error,
                ),
            );
        for (const { item, card } of fresh) cached.set(item.id, card);
    }

    return capped.flatMap((item) => {
        const card = cached.get(item.id);
        return card ? [{ ...item, card }] : [];
    });
}
```

Implement `generateCard` as:

```ts
async function generateCard(item: NewsItem): Promise<NewsCardAnalysis | null> {
    try {
        const submission = await submitNewsCardAnalysis({ item, thinkingBudget: 0 });
        if (submission.status !== 'submitted' || !('jobId' in submission)) return null;
        const polled = await pollUntilDone(pollNewsCardAnalysis, submission.jobId);
        if ('error' in polled) {
            console.warn('[enrich-news-cards] card failed', {
                symbol,
                id: item.id,
                error: polled.error,
            });
            return null;
        }
        return polled.result as NewsCardAnalysis;
    } catch (error) {
        console.warn('[enrich-news-cards] card threw', {
            symbol,
            id: item.id,
            error,
        });
        return null;
    }
}
```

- [ ] **Step 5: Guard the aggregate news submission**

In `run-news.ts`:

```ts
const deadlineMs = options.deadlineMs ?? Number.POSITIVE_INFINITY;
const enriched = await enrichNewsCards(options.cardStore, options.symbol, news, { deadlineMs });
if (enriched.length === 0 || Date.now() >= deadlineMs) return { status: 'skipped' };
```

Do not start earnings fetch or aggregate LLM submission after the deadline.

- [ ] **Step 6: Run focused tests**

Run:

```bash
yarn vitest run lib/analysis/__tests__/enrich-news-cards.test.ts lib/analysis/__tests__/run-news.test.ts api/cron/__tests__/analysis-crons.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/analysis/types.ts lib/analysis/enrich-news-cards.ts lib/analysis/run-news.ts api/cron/_run-analysis-cron.ts lib/analysis/__tests__/enrich-news-cards.test.ts lib/analysis/__tests__/run-news.test.ts api/cron/__tests__/analysis-crons.test.ts
git commit -m "feat: bound news card concurrency and runtime"
```

### Task 8: Upgrade siglens-core

**Files:**
- Modify: `package.json`
- Modify: `yarn.lock`

- [ ] **Step 1: Record the current dependency contract**

Run:

```bash
node -e "console.log(require('./node_modules/@y0ngha/siglens-core/package.json').version)"
yarn typecheck
```

Expected before change: version `0.21.1`; typecheck PASS.

- [ ] **Step 2: Upgrade the exact dependency**

Run:

```bash
yarn add -E @y0ngha/siglens-core@0.23.0
```

Expected: `package.json` contains `"@y0ngha/siglens-core": "0.23.0"` and the lockfile resolves `0.23.0`.

- [ ] **Step 3: Run analysis contract tests**

Run:

```bash
yarn vitest run \
  lib/analysis/__tests__/run-technical.test.ts \
  lib/analysis/__tests__/run-news.test.ts \
  lib/analysis/__tests__/run-options.test.ts \
  lib/analysis/__tests__/run-fundamental.test.ts \
  lib/analysis/__tests__/run-overall.test.ts \
  lib/data/__tests__/fmp-market-data-provider.test.ts
yarn typecheck
```

Expected: PASS. A failure means the dependency contract differs from the approved design; stop this task, record the exact compiler/test failure, and update the plan before changing application behavior.

- [ ] **Step 4: Commit**

```bash
git add package.json yarn.lock
git commit -m "chore: upgrade siglens core to 0.23.0"
```

### Task 9: Database Migration and Explicit Operational Defaults

**Files:**
- Modify: `lib/db/schema.ts`
- Create: `drizzle/0010_cron_analysis_reliability.sql`
- Create/Modify: `drizzle/meta/0010_snapshot.json`
- Modify: `drizzle/meta/_journal.json`
- Modify: `lib/db/__tests__/migrate.test.ts`

- [ ] **Step 1: Generate the schema migration**

Run:

```bash
yarn db:generate --name cron_analysis_reliability
```

Expected: `drizzle/0010_cron_analysis_reliability.sql` adds `analysis_results.source_analyzed_at`.

- [ ] **Step 2: Add idempotent operational data SQL**

Append SQL equivalent to:

```sql
INSERT INTO "config" ("key", "value") VALUES
('trading_mode', '"dry_run"'::jsonb),
('trading_enabled', 'true'::jsonb),
('max_position_size', '5000'::jsonb),
('max_total_exposure', '25000'::jsonb),
('stop_loss_percent', '5'::jsonb),
('take_profit_percent', '10'::jsonb),
('buy_threshold', '70'::jsonb),
('sell_threshold', '30'::jsonb),
('analysis_timeframe', '"1Hour"'::jsonb),
('score_weights', '{"technical":8,"news":6,"options":5,"fundamental":4,"overall":3}'::jsonb),
('fixed_exit_enabled', 'false'::jsonb),
('max_trades_per_day', '20'::jsonb),
('max_daily_loss_usd', '500'::jsonb)
ON CONFLICT ("key") DO NOTHING;

UPDATE "config"
SET "value" = '"1Hour"'::jsonb, "updated_at" = now()
WHERE "key" = 'analysis_timeframe'
  AND "value" = '"1Day"'::jsonb;

INSERT INTO "analysis_model_config"
    ("analysis_type", "enabled", "model_id", "use_byok")
VALUES
    ('technical', true, 'gemini-2.5-flash', false),
    ('news', true, 'gemini-2.5-flash', false),
    ('options', true, 'gemini-2.5-flash', false),
    ('fundamental', true, 'gemini-2.5-flash', false),
    ('overall', true, 'gemini-2.5-flash', false)
ON CONFLICT ("analysis_type") DO NOTHING;
```

Do not alter any other existing config value.

- [ ] **Step 3: Add migration content assertions**

Extend `migrate.test.ts` or add a migration SQL test that reads the new file and asserts it contains:

```ts
expect(sql).toContain('source_analyzed_at');
expect(sql).toContain(`'analysis_timeframe', '"1Hour"'::jsonb`);
expect(sql).toContain(`"value" = '"1Hour"'::jsonb`);
expect(sql).toContain(`ON CONFLICT ("analysis_type") DO NOTHING`);
```

- [ ] **Step 4: Run migration tests and schema checks**

Run:

```bash
yarn vitest run lib/db/__tests__/migrate.test.ts lib/db/__tests__/queries.test.ts
yarn db:generate
git status --short
```

Expected: tests PASS; the second generation creates no additional migration.

- [ ] **Step 5: Commit**

```bash
git add lib/db/schema.ts drizzle lib/db/__tests__/migrate.test.ts
git commit -m "feat: migrate analysis timestamps and operational defaults"
```

### Task 10: Documentation and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `api/CLAUDE.md`
- Modify: `lib/analysis/CLAUDE.md`

- [ ] **Step 1: Update operational documentation**

Document:

```text
analysis_timeframe: 15Min | 30Min | 1Hour (default 1Hour)
technical cache remains enabled and force=false
source_analyzed_at is the freshness source
running >15 minutes becomes error/timeout on the next cron invocation
news card processing: latest 10, concurrency 3, new work stops at 690 seconds
```

Update deployment verification SQL:

```sql
SELECT key, value
FROM config
WHERE key = 'analysis_timeframe';

SELECT analysis_type, model_id, enabled, use_byok
FROM analysis_model_config
ORDER BY analysis_type;

SELECT run_id, status, outcome, started_at, finished_at
FROM cron_runs
WHERE status = 'running'
  AND started_at < now() - interval '15 minutes';
```

- [ ] **Step 2: Run complete static and test verification**

Run:

```bash
yarn test:quiet
yarn typecheck
yarn lint
yarn build
yarn format:check
```

Expected:

```text
53+ test files passed
1267+ tests passed
typecheck exits 0
lint exits 0
build exits 0
format check exits 0
```

- [ ] **Step 3: Inspect final diff**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors; only in-scope source, test, migration, dependency, and documentation files are changed.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/DEPLOYMENT.md api/CLAUDE.md lib/analysis/CLAUDE.md
git commit -m "docs: document cron analysis reliability controls"
```

### Task 11: Production Migration and Post-Deploy Verification

**Files:**
- No source changes expected

- [ ] **Step 1: Apply the production migration**

Run only after the reviewed code is deployed or in the agreed release sequence:

```bash
yarn db:migrate
```

Expected: `Migration complete`.

- [ ] **Step 2: Verify explicit production configuration without printing secrets**

Run a read-only script using `.env.local` and assert:

```sql
SELECT key, value FROM config ORDER BY key;
SELECT analysis_type, enabled, model_id, use_byok
FROM analysis_model_config
ORDER BY analysis_type;
```

Expected: `analysis_timeframe` is `1Hour`; all required config keys and five model rows exist.

- [ ] **Step 3: Verify the first completed technical cron**

Check:

```sql
SELECT symbol, analyzed_at, source_analyzed_at, model_id
FROM analysis_results
WHERE analysis_type = 'technical'
ORDER BY analyzed_at DESC
LIMIT 10;
```

Expected: new rows have non-null `source_analyzed_at`; cached rows preserve the original source time.

- [ ] **Step 4: Verify decision audit and timeout cleanup**

Check:

```sql
SELECT symbol, action, score, reason, detail
FROM cron_decisions
WHERE cron_type = 'execute'
ORDER BY created_at DESC
LIMIT 20;

SELECT run_id, status, outcome, error
FROM cron_runs
WHERE started_at < now() - interval '15 minutes'
  AND status = 'running';
```

Expected: hold rows contain reason and component detail; the stale-running query returns zero rows after a cron invocation.

- [ ] **Step 5: Report operational outcome**

Report actual cron IDs, source-vs-save timestamp differences, news duration, partial failures, and whether any stale audit rows remain. Do not mutate production data beyond the approved migration.
