import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../_lib/cron-auth', () => ({ verifyCronSecret: () => true }));
const fakeDb = { fake: 'db' };
vi.mock('../../_lib/db', () => ({ getDb: () => fakeDb }));

const q = vi.hoisted(() => ({
    finishCronRun: vi.fn(),
    getAnalysisConfig: vi.fn(),
    getEnabledWatchlist: vi.fn(),
    getLatestAnalysisResult: vi.fn(),
    getMrSignalDecisionsSince: vi.fn(),
    hasTradeAuditCorrelation: vi.fn(),
    insertCronDecisions: vi.fn(),
    insertTradeAudit: vi.fn(),
    saveAnalysisResult: vi.fn(),
    startCronRun: vi.fn(),
    finalizeStaleCronRuns: vi.fn(),
}));
vi.mock('../../../lib/db/queries', () =>
    Object.fromEntries(
        Object.entries(q).map(([k, fn]) => [
            k,
            (...a: unknown[]) => (fn as (...x: unknown[]) => unknown)(...a),
        ]),
    ),
);

const runners = vi.hoisted(() => ({ technical: vi.fn(), news: vi.fn(), fundamental: vi.fn() }));
vi.mock('../../../lib/analysis/run-technical', () => ({
    runTechnicalAnalysis: (...a: unknown[]) => runners.technical(...a),
}));
vi.mock('../../../lib/analysis/run-news', () => ({
    runNewsAnalysis: (...a: unknown[]) => runners.news(...a),
}));
vi.mock('../../../lib/analysis/run-fundamental', () => ({
    runFundamentalAnalysis: (...a: unknown[]) => runners.fundamental(...a),
}));

const mockRunEntryReview = vi.fn();
vi.mock('../../../lib/analysis/entry-review', () => ({
    runEntryReview: (...a: unknown[]) => mockRunEntryReview(...a),
}));

const mockFetchDailyBars = vi.fn();
vi.mock('../../../lib/analysis/daily-bars', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../lib/analysis/daily-bars')>()),
    fetchDailyBars: (...a: unknown[]) => mockFetchDailyBars(...a),
}));

const mockLock = vi.fn();
vi.mock('../../../lib/lock', () => ({
    acquireLockDetailed: (...a: unknown[]) => mockLock(...a),
    releaseLock: async () => {},
}));

import { GET as handler, MAX_REVIEWS_PER_RUN } from '../review';

const NOW = new Date('2026-01-05T21:10:00Z'); // 16:10 ET
const TODAY_START = new Date('2026-01-05T05:00:00Z');

const signal = (id: number, o: Record<string, unknown> = {}) => ({
    id,
    symbol: 'NVDA',
    action: 'mr_buy',
    executed: true,
    createdAt: new Date('2026-01-05T20:47:00Z'),
    detail: { mr: { price: 100, rsi2: 3, sma200: 90, sma5: 104, spyPrice: 600, spySma200: 550 } },
    ...o,
});
const okOutcome = {
    status: 'ok',
    fraction: 0.3,
    confidence: 70,
    dropCause: 'news',
    reason: '악재',
    model: 'deepseek-v4.1-pro',
    transcript: { systemPrompt: 's', userPrompt: 'u', rawResponse: '{}' },
};
const decisions = () =>
    (q.insertCronDecisions.mock.calls.at(-1)?.[3] ?? []) as Array<Record<string, unknown>>;

async function run() {
    vi.setSystemTime(NOW);
    const res = await handler(new Request('https://x/api/cron/review'));
    return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.clearAllMocks();
    for (const fn of [
        q.finishCronRun,
        q.insertCronDecisions,
        q.insertTradeAudit,
        q.saveAnalysisResult,
        q.startCronRun,
        q.finalizeStaleCronRuns,
    ]) {
        fn.mockResolvedValue(undefined);
    }
    q.getMrSignalDecisionsSince.mockResolvedValue([signal(1)]);
    q.hasTradeAuditCorrelation.mockResolvedValue(false);
    q.getAnalysisConfig.mockImplementation(async (_db: unknown, type: string) => ({
        analysisType: type,
        enabled: true,
        modelId: type === 'entry_review' ? 'deepseek-v4.1-pro' : 'deepseek-v4.1-flash',
        useByok: false,
    }));
    q.getEnabledWatchlist.mockResolvedValue([{ symbol: 'NVDA', companyName: 'NVIDIA' }]);
    q.getLatestAnalysisResult.mockResolvedValue(null);
    for (const r of Object.values(runners))
        r.mockResolvedValue({ status: 'done', result: { analyzedAt: '2026-01-05T21:00:00.000Z' } });
    mockRunEntryReview.mockResolvedValue(okOutcome);
    mockFetchDailyBars.mockResolvedValue(
        [90, 95, 97, 99, 101, 104, 100].map((c, i) => ({
            date: `2026-01-0${i}`,
            open: c,
            high: c,
            low: c,
            close: c,
        })),
    );
    mockLock.mockResolvedValue({ token: 't' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

describe('review cron', () => {
    it('no pending signal → no audit row', async () => {
        q.getMrSignalDecisionsSince.mockResolvedValue([signal(1)]);
        q.hasTradeAuditCorrelation.mockResolvedValue(true);
        expect(await run()).toEqual({ skipped: true, reason: 'nothing_pending' });
        expect(q.getMrSignalDecisionsSince).toHaveBeenCalledWith(fakeDb, TODAY_START);
        expect(q.hasTradeAuditCorrelation).toHaveBeenCalledWith(fakeDb, 'review-1');
        expect(q.startCronRun).not.toHaveBeenCalled();
    });

    it('runs the three analyses on 1Day, saves them, and records the review under its idempotency key', async () => {
        await run();
        for (const [type, r] of Object.entries(runners)) {
            expect(r).toHaveBeenCalledWith(
                expect.objectContaining({
                    symbol: 'NVDA',
                    companyName: 'NVIDIA',
                    timeframe: '1Day',
                    reasoning: false,
                }),
            );
            expect(q.saveAnalysisResult).toHaveBeenCalledWith(
                fakeDb,
                expect.objectContaining({ analysisType: type, timeframe: '1Day' }),
            );
        }
        expect(runners.technical.mock.calls[0]![0]).toHaveProperty('priorAnalysisStore');
        expect(runners.news.mock.calls[0]![0].priorAnalysisStore).toBeUndefined();
        const [input] = mockRunEntryReview.mock.calls[0]!;
        expect(input).toMatchObject({
            symbol: 'NVDA',
            executed: true,
            modelId: 'deepseek-v4.1-pro',
            correlationId: 'review-1',
        });
        expect(input.mr).toMatchObject({ price: 100, spyUp: true });
        expect(input.mr.change1d).toBeCloseTo((100 / 104 - 1) * 100);
        expect(input.mr.change5d).toBeCloseTo((100 / 95 - 1) * 100);
        expect(q.insertTradeAudit).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({
                kind: 'entry_review',
                correlationId: 'review-1',
                fraction: 0.3,
                confidence: 70,
                status: 'ok',
            }),
        );
        expect(decisions()).toEqual([
            expect.objectContaining({
                symbol: 'NVDA',
                action: 'reviewed',
                detail: expect.objectContaining({ dropCause: 'news' }),
            }),
        ]);
        expect(q.insertCronDecisions.mock.calls[0]![2]).toBe('review');
    });

    it('reuses today’s analyses (technical only when it is 1Day)', async () => {
        q.getLatestAnalysisResult.mockImplementation(
            async (_db: unknown, _s: string, type: string) => ({
                result: { t: type },
                analyzedAt: new Date('2026-01-05T15:00:00Z'),
                sourceAnalyzedAt: null,
                modelId: 'm',
                timeframe: type === 'technical' ? '1Hour' : '1Day',
            }),
        );
        await run();
        expect(runners.news).not.toHaveBeenCalled();
        expect(runners.fundamental).not.toHaveBeenCalled();
        expect(runners.technical).toHaveBeenCalled(); // yesterday's 1Hour row is not today's daily read
    });

    it('a failing analysis axis does not stop the review', async () => {
        runners.news.mockResolvedValue({ status: 'error', error: 'x' });
        runners.fundamental.mockRejectedValueOnce(new Error('boom'));
        await run();
        const { analyses } = mockRunEntryReview.mock.calls[0]![0];
        expect(
            analyses.map((a: { type: string; result: unknown }) => [a.type, a.result != null]),
        ).toEqual([
            ['technical', true],
            ['news', false],
            ['fundamental', false],
        ]);
        expect(decisions()[0]!.action).toBe('reviewed');
    });

    it('a disabled axis is skipped without a runner call', async () => {
        q.getAnalysisConfig.mockImplementation(async (_db: unknown, type: string) => ({
            enabled: type !== 'fundamental',
            modelId: 'm',
            useByok: false,
        }));
        await run();
        expect(runners.fundamental).not.toHaveBeenCalled();
    });

    it('a review error is still written so the signal is not retried every tick', async () => {
        mockRunEntryReview.mockResolvedValue({
            status: 'error',
            error: 'timeout',
            model: 'm',
            transcript: { systemPrompt: 's', userPrompt: 'u', rawResponse: null },
        });
        await run();
        expect(q.insertTradeAudit).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({
                status: 'error',
                gateError: 'timeout',
                correlationId: 'review-1',
            }),
        );
        expect(decisions()[0]!.action).toBe('review_error');
    });

    it('processes at most MAX_REVIEWS_PER_RUN signals, skipped-budget ones included', async () => {
        q.getMrSignalDecisionsSince.mockResolvedValue(
            Array.from({ length: 7 }, (_, i) =>
                signal(i + 1, {
                    action: i % 2 ? 'mr_skip_budget' : 'mr_buy',
                    executed: i % 2 === 0,
                }),
            ),
        );
        await run();
        expect(mockRunEntryReview).toHaveBeenCalledTimes(MAX_REVIEWS_PER_RUN);
        expect(mockRunEntryReview.mock.calls[1]![0].executed).toBe(false);
        expect(q.finishCronRun.mock.calls[0]![2]).toMatchObject({
            status: 'completed',
            summary: { pending: 7, processed: 5 },
        });
    });

    it('an unreadable signal detail is recorded, not reviewed', async () => {
        q.getMrSignalDecisionsSince.mockResolvedValue([signal(1, { detail: {} })]);
        await run();
        expect(mockRunEntryReview).not.toHaveBeenCalled();
        expect(decisions()[0]!.action).toBe('review_error');
    });

    it('disabled review model → skipped', async () => {
        q.getAnalysisConfig.mockImplementation(async (_db: unknown, type: string) => ({
            enabled: type !== 'entry_review',
            modelId: 'm',
            useByok: false,
        }));
        expect(await run()).toEqual({ skipped: true, reason: 'disabled' });
        expect(q.finishCronRun.mock.calls[0]![2]).toMatchObject({
            status: 'skipped',
            outcome: 'disabled',
        });
    });

    it('lock contention skips; a lock outage is an error', async () => {
        mockLock.mockResolvedValue({ token: null, reason: 'contended' });
        await run();
        expect(q.finishCronRun.mock.calls.at(-1)![2]).toMatchObject({
            status: 'skipped',
            outcome: 'locked',
        });
        mockLock.mockResolvedValue({ token: null, reason: 'unavailable' });
        await run();
        expect(q.finishCronRun.mock.calls.at(-1)![2]).toMatchObject({
            status: 'error',
            outcome: 'locked',
        });
    });

    it('an unexpected per-signal exception is recorded and the run completes', async () => {
        q.insertTradeAudit.mockRejectedValueOnce(new Error('db'));
        await run();
        expect(decisions()[0]).toMatchObject({ action: 'error' });
        expect(q.finishCronRun.mock.calls[0]![2]).toMatchObject({ status: 'completed' });
    });
});
