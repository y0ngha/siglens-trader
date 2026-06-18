import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAnalysisCronHandler, resolveApiKey } from '../_run-analysis-cron';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockVerifyCronSecret = vi.fn<(req: Request) => boolean>();
vi.mock('../../_lib/cron-auth', () => ({
    verifyCronSecret: (...args: [Request]) => mockVerifyCronSecret(...args),
}));

const mockGetDb = vi.fn();
vi.mock('../../_lib/db', () => ({
    getDb: () => mockGetDb(),
}));

const mockGetEnabledWatchlist = vi.fn();
const mockGetAnalysisConfig = vi.fn();
const mockGetConfigValue = vi.fn();
const mockSaveAnalysisResult = vi.fn();
const mockStartCronRun = vi.fn();
const mockFinishCronRun = vi.fn();
vi.mock('../../../lib/db/queries', () => ({
    getEnabledWatchlist: (...args: unknown[]) => mockGetEnabledWatchlist(...args),
    getAnalysisConfig: (...args: unknown[]) => mockGetAnalysisConfig(...args),
    getConfigValue: (...args: unknown[]) => mockGetConfigValue(...args),
    saveAnalysisResult: (...args: unknown[]) => mockSaveAnalysisResult(...args),
    startCronRun: (...args: unknown[]) => mockStartCronRun(...args),
    finishCronRun: (...args: unknown[]) => mockFinishCronRun(...args),
}));

const mockAcquireLock = vi.fn<() => Promise<string | null>>();
const mockReleaseLock = vi.fn<() => Promise<void>>();
vi.mock('../../../lib/lock', () => ({
    acquireLock: (...args: unknown[]) => mockAcquireLock(...(args as [])),
    releaseLock: (...args: unknown[]) => mockReleaseLock(...(args as [])),
}));

const mockIsEtRegularSessionOpen = vi.fn<(now: Date) => boolean>();
vi.mock('@y0ngha/siglens-core', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@y0ngha/siglens-core')>()),
    isEtRegularSessionOpen: (...args: [Date]) => mockIsEtRegularSessionOpen(...args),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeDb = { fake: 'db' };
const fakeConfig = { enabled: true, modelId: 'claude-sonnet-4-20250514', useByok: true };
const fakeWatchlist = [
    { symbol: 'AAPL', companyName: 'Apple Inc.', enabled: true },
    { symbol: 'TSLA', companyName: 'Tesla Inc.', enabled: true },
];

function makeRequest(authorized: boolean): Request {
    const headers = new Headers();
    if (authorized) {
        headers.set('authorization', 'Bearer test-secret');
    }
    return new Request('https://example.com/api/cron/technical', { headers });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAnalysisCronHandler', () => {
    let mockRunner: ReturnType<typeof vi.fn>;
    let handler: (req: Request) => Promise<Response>;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-24T10:00:00.000Z'));

        mockRunner = vi.fn();
        handler = createAnalysisCronHandler('technical', mockRunner);

        mockGetDb.mockReturnValue(fakeDb);
        mockGetAnalysisConfig.mockResolvedValue(fakeConfig);
        mockGetConfigValue.mockResolvedValue(null);
        mockGetEnabledWatchlist.mockResolvedValue(fakeWatchlist);
        mockSaveAnalysisResult.mockResolvedValue([]);
        mockStartCronRun.mockResolvedValue(undefined);
        mockFinishCronRun.mockResolvedValue(undefined);
        mockVerifyCronSecret.mockReturnValue(true);
        mockIsEtRegularSessionOpen.mockReturnValue(true);
        mockAcquireLock.mockResolvedValue('test-lock-token');
        mockReleaseLock.mockResolvedValue(undefined);

        process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
        process.env.OPENAI_API_KEY = 'sk-openai-test';
        process.env.GEMINI_API_KEY = 'gemini-test';
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.OPENAI_API_KEY;
        delete process.env.GEMINI_API_KEY;
    });

    it('returns 401 when cron secret is invalid', async () => {
        mockVerifyCronSecret.mockReturnValue(false);

        const res = await handler(makeRequest(false));

        expect(res.status).toBe(401);
        expect(await res.text()).toBe('Unauthorized');
        expect(mockGetAnalysisConfig).not.toHaveBeenCalled();
    });

    it('returns skipped response when lock cannot be acquired', async () => {
        mockAcquireLock.mockResolvedValue(null);

        const res = await handler(makeRequest(true));
        const body = await res.json();

        expect(body).toEqual({ skipped: true, reason: 'another_execution_in_progress' });
        expect(mockGetAnalysisConfig).not.toHaveBeenCalled();
    });

    it('skips before acquiring the lock when the U.S. regular session is closed', async () => {
        mockIsEtRegularSessionOpen.mockReturnValue(false);

        const res = await handler(makeRequest(true));
        const body = await res.json();

        expect(body).toEqual({ skipped: true, reason: 'market_closed' });
        expect(mockAcquireLock).not.toHaveBeenCalled();
        expect(mockGetAnalysisConfig).not.toHaveBeenCalled();
    });

    it('uses per-type lock key with 780s TTL (< maxDuration 800s)', async () => {
        mockRunner.mockResolvedValue({ status: 'done', result: {} });

        await handler(makeRequest(true));

        expect(mockAcquireLock).toHaveBeenCalledWith('cron:technical:lock', 780);
    });

    it('releases lock after successful execution', async () => {
        mockRunner.mockResolvedValue({ status: 'done', result: {} });

        await handler(makeRequest(true));

        expect(mockReleaseLock).toHaveBeenCalledWith('cron:technical:lock', 'test-lock-token');
    });

    it('releases lock even when handler throws', async () => {
        // Throw after lock acquisition (getAnalysisConfig runs inside the lock)
        mockGetAnalysisConfig.mockRejectedValue(new Error('DB connection failed'));

        await expect(handler(makeRequest(true))).rejects.toThrow('DB connection failed');

        expect(mockReleaseLock).toHaveBeenCalledWith('cron:technical:lock', 'test-lock-token');
    });

    it('skips when config is disabled', async () => {
        mockGetAnalysisConfig.mockResolvedValue({ ...fakeConfig, enabled: false });

        const res = await handler(makeRequest(true));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ skipped: true, reason: 'disabled' });
        expect(mockGetEnabledWatchlist).not.toHaveBeenCalled();
    });

    it('skips when config explicitly has enabled:false', async () => {
        mockGetAnalysisConfig.mockResolvedValue({ ...fakeConfig, enabled: false });

        const res = await handler(makeRequest(true));
        const body = await res.json();

        expect(body).toEqual({ skipped: true, reason: 'disabled' });
    });

    it('skips when watchlist is empty', async () => {
        mockGetEnabledWatchlist.mockResolvedValue([]);

        const res = await handler(makeRequest(true));
        const body = await res.json();

        expect(body).toEqual({ skipped: true, reason: 'empty_watchlist' });
        expect(mockRunner).not.toHaveBeenCalled();
    });

    it('runs analysis for each watchlist item and saves successful results', async () => {
        mockRunner
            .mockResolvedValueOnce({
                status: 'done',
                result: { trend: 'bullish', analyzedAt: '2026-05-24T09:55:00Z' },
            })
            .mockResolvedValueOnce({ status: 'cached', result: { trend: 'bearish' } });

        const res = await handler(makeRequest(true));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.cronRunId).toMatch(/^technical-[0-9a-f-]+$/);
        expect(body.results).toHaveLength(2);
        expect(body.results[0]).toEqual({ symbol: 'AAPL', status: 'done' });
        expect(body.results[1]).toEqual({ symbol: 'TSLA', status: 'cached' });

        // Both results should be saved
        expect(mockSaveAnalysisResult).toHaveBeenCalledTimes(2);
        expect(mockSaveAnalysisResult).toHaveBeenCalledWith(fakeDb, {
            symbol: 'AAPL',
            analysisType: 'technical',
            result: { trend: 'bullish', analyzedAt: '2026-05-24T09:55:00Z' },
            modelId: 'claude-sonnet-4-20250514',
            analyzedAt: new Date('2026-05-24T10:00:00.000Z'),
            sourceAnalyzedAt: new Date('2026-05-24T09:55:00.000Z'),
            cronRunId: expect.stringMatching(/^technical-/),
        });
        expect(mockSaveAnalysisResult).toHaveBeenCalledWith(fakeDb, {
            symbol: 'TSLA',
            analysisType: 'technical',
            result: { trend: 'bearish' },
            modelId: 'claude-sonnet-4-20250514',
            analyzedAt: new Date('2026-05-24T10:00:00.000Z'),
            sourceAnalyzedAt: new Date('2026-05-24T10:00:00.000Z'),
            cronRunId: expect.stringMatching(/^technical-/),
        });
    });

    it('does not save result when analysis returns error status', async () => {
        mockRunner.mockResolvedValue({ status: 'error', error: 'API rate limited' });

        const res = await handler(makeRequest(true));
        const body = await res.json();

        expect(body.results).toEqual([
            { symbol: 'AAPL', status: 'error', error: 'API rate limited' },
            { symbol: 'TSLA', status: 'error', error: 'API rate limited' },
        ]);
        expect(mockSaveAnalysisResult).not.toHaveBeenCalled();
    });

    it('does not save result when analysis returns skipped status', async () => {
        mockRunner.mockResolvedValue({ status: 'skipped' });

        const res = await handler(makeRequest(true));
        const body = await res.json();

        expect(body.results[0]).toEqual({ symbol: 'AAPL', status: 'skipped' });
        expect(mockSaveAnalysisResult).not.toHaveBeenCalled();
    });

    it('passes userApiKey when useByok is true', async () => {
        mockRunner.mockResolvedValue({ status: 'done', result: {} });

        await handler(makeRequest(true));

        expect(mockRunner).toHaveBeenCalledWith(
            expect.objectContaining({
                symbol: 'AAPL',
                companyName: 'Apple Inc.',
                modelId: 'claude-sonnet-4-20250514',
                userApiKey: 'sk-ant-test',
            }),
        );
    });

    it('does not pass userApiKey when useByok is false', async () => {
        mockGetAnalysisConfig.mockResolvedValue({ ...fakeConfig, useByok: false });
        mockRunner.mockResolvedValue({ status: 'done', result: {} });

        await handler(makeRequest(true));

        expect(mockRunner).toHaveBeenCalledWith(
            expect.objectContaining({
                symbol: 'AAPL',
                companyName: 'Apple Inc.',
                modelId: 'claude-sonnet-4-20250514',
                userApiKey: undefined,
            }),
        );
    });

    it('includes error field in results only when present', async () => {
        mockRunner
            .mockResolvedValueOnce({ status: 'done', result: {} })
            .mockResolvedValueOnce({ status: 'error', error: 'timeout' });

        const res = await handler(makeRequest(true));
        const body = await res.json();

        expect(body.results[0].error).toBeUndefined();
        expect(body.results[1].error).toBe('timeout');
    });

    it('uses different analysis type prefix in cronRunId', async () => {
        const newsHandler = createAnalysisCronHandler('news', mockRunner);
        mockRunner.mockResolvedValue({ status: 'done', result: {} });

        const res = await newsHandler(makeRequest(true));
        const body = await res.json();

        expect(body.cronRunId).toMatch(/^news-[0-9a-f-]+$/);
    });

    it('passes correct analysisType to getAnalysisConfig', async () => {
        const optionsHandler = createAnalysisCronHandler('options', mockRunner);
        mockRunner.mockResolvedValue({ status: 'done', result: {} });

        await optionsHandler(makeRequest(true));

        expect(mockGetAnalysisConfig).toHaveBeenCalledWith(fakeDb, 'options');
    });

    // ---------------------------------------------------------------------------
    // Cron audit logging (cron_runs)
    // ---------------------------------------------------------------------------

    it('calls startCronRun with the analysisType as cronType', async () => {
        mockRunner.mockResolvedValue({ status: 'done', result: {} });

        await handler(makeRequest(true));

        expect(mockStartCronRun).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({ cronType: 'technical' }),
        );
    });

    it('calls finishCronRun with status:completed and outcome:completed on normal run', async () => {
        mockRunner.mockResolvedValue({ status: 'done', result: {} });

        await handler(makeRequest(true));

        expect(mockFinishCronRun).toHaveBeenCalledWith(
            fakeDb,
            expect.stringMatching(/^technical-/),
            expect.objectContaining({
                status: 'completed',
                outcome: 'completed',
                summary: {
                    processed: fakeWatchlist.length,
                    saved: fakeWatchlist.length,
                    byStatus: { done: fakeWatchlist.length, cached: 0, skipped: 0, error: 0 },
                    results: [
                        { symbol: 'AAPL', status: 'done' },
                        { symbol: 'TSLA', status: 'done' },
                    ],
                },
            }),
        );
    });

    it('records analysis result status counts and per-symbol errors in the audit summary', async () => {
        mockRunner
            .mockResolvedValueOnce({ status: 'done', result: { trend: 'bullish' } })
            .mockResolvedValueOnce({ status: 'error', error: 'worker timeout' });

        await handler(makeRequest(true));

        expect(mockFinishCronRun).toHaveBeenCalledWith(
            fakeDb,
            expect.stringMatching(/^technical-/),
            expect.objectContaining({
                summary: {
                    processed: 2,
                    saved: 1,
                    byStatus: { done: 1, cached: 0, skipped: 0, error: 1 },
                    results: [
                        { symbol: 'AAPL', status: 'done' },
                        { symbol: 'TSLA', status: 'error', error: 'worker timeout' },
                    ],
                },
            }),
        );
    });

    it('calls finishCronRun with status:skipped and outcome:disabled when config is disabled', async () => {
        mockGetAnalysisConfig.mockResolvedValue({ ...fakeConfig, enabled: false });

        await handler(makeRequest(true));

        expect(mockFinishCronRun).toHaveBeenCalledWith(
            fakeDb,
            expect.stringMatching(/^technical-/),
            expect.objectContaining({ status: 'skipped', outcome: 'disabled' }),
        );
    });

    it('calls finishCronRun with status:skipped and outcome:market_closed when session is closed', async () => {
        mockIsEtRegularSessionOpen.mockReturnValue(false);

        await handler(makeRequest(true));

        expect(mockFinishCronRun).toHaveBeenCalledWith(
            fakeDb,
            expect.stringMatching(/^technical-/),
            expect.objectContaining({ status: 'skipped', outcome: 'market_closed' }),
        );
    });

    it('calls finishCronRun with status:skipped and outcome:empty_watchlist when watchlist is empty', async () => {
        mockGetEnabledWatchlist.mockResolvedValue([]);

        await handler(makeRequest(true));

        expect(mockFinishCronRun).toHaveBeenCalledWith(
            fakeDb,
            expect.stringMatching(/^technical-/),
            expect.objectContaining({ status: 'skipped', outcome: 'empty_watchlist' }),
        );
    });

    it('calls finishCronRun with status:skipped and outcome:locked when lock cannot be acquired', async () => {
        mockAcquireLock.mockResolvedValue(null);

        await handler(makeRequest(true));

        expect(mockFinishCronRun).toHaveBeenCalledWith(
            fakeDb,
            expect.stringMatching(/^technical-/),
            expect.objectContaining({ status: 'skipped', outcome: 'locked' }),
        );
    });

    it('calls finishCronRun with status:error when handler throws', async () => {
        mockGetEnabledWatchlist.mockRejectedValue(new Error('DB timeout'));

        await expect(handler(makeRequest(true))).rejects.toThrow('DB timeout');

        expect(mockFinishCronRun).toHaveBeenCalledWith(
            fakeDb,
            expect.stringMatching(/^technical-/),
            expect.objectContaining({ status: 'error', error: 'DB timeout' }),
        );
    });

    it('does not break the cron when startCronRun fails', async () => {
        mockStartCronRun.mockRejectedValue(new Error('audit DB down'));
        mockRunner.mockResolvedValue({ status: 'done', result: {} });

        const res = await handler(makeRequest(true));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.cronRunId).toMatch(/^technical-/);
    });

    it('does not break the cron when finishCronRun fails', async () => {
        mockFinishCronRun.mockRejectedValue(new Error('audit DB down'));
        mockRunner.mockResolvedValue({ status: 'done', result: {} });

        const res = await handler(makeRequest(true));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.cronRunId).toMatch(/^technical-/);
    });
});

describe('resolveApiKey', () => {
    beforeEach(() => {
        process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
        process.env.OPENAI_API_KEY = 'sk-openai-test';
        process.env.GEMINI_API_KEY = 'gemini-test';
    });

    afterEach(() => {
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.OPENAI_API_KEY;
        delete process.env.GEMINI_API_KEY;
    });

    it('returns ANTHROPIC_API_KEY for claude model', () => {
        expect(resolveApiKey('claude-sonnet-4-20250514')).toBe('sk-ant-test');
        expect(resolveApiKey('claude-3-haiku')).toBe('sk-ant-test');
    });

    it('returns OPENAI_API_KEY for gpt model', () => {
        expect(resolveApiKey('gpt-4o')).toBe('sk-openai-test');
        expect(resolveApiKey('gpt-4-turbo')).toBe('sk-openai-test');
    });

    it('returns GEMINI_API_KEY for gemini model', () => {
        expect(resolveApiKey('gemini-2.0-flash')).toBe('gemini-test');
        expect(resolveApiKey('gemini-pro')).toBe('gemini-test');
    });

    it('returns undefined for unknown model prefix', () => {
        expect(resolveApiKey('llama-3')).toBeUndefined();
        expect(resolveApiKey('mistral-large')).toBeUndefined();
    });
});
