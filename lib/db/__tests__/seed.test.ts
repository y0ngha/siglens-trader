import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockOnConflictDoNothing = vi.fn().mockResolvedValue(undefined);
const mockValues = vi.fn().mockReturnValue({ onConflictDoNothing: mockOnConflictDoNothing });
const mockInsert = vi.fn().mockReturnValue({ values: mockValues });

const mockDb = {
    insert: mockInsert,
};

vi.mock('@neondatabase/serverless', () => ({
    neon: vi.fn(() => vi.fn()),
}));

vi.mock('drizzle-orm/neon-http', () => ({
    drizzle: vi.fn(() => mockDb),
}));

describe('seed', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env = { ...originalEnv, DATABASE_URL: 'postgresql://test:test@localhost/test' };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it('throws if DATABASE_URL is missing', async () => {
        delete process.env.DATABASE_URL;

        const { seed } = await import('../seed');
        await expect(seed()).rejects.toThrow('DATABASE_URL is required');
    });

    it('inserts default config values (13 entries)', async () => {
        const { seed } = await import('../seed');
        await seed();

        // Count insert calls that received config values
        const configValueCalls = mockValues.mock.calls.filter(
            (call) =>
                call[0] && typeof call[0] === 'object' && 'key' in call[0] && 'value' in call[0],
        );
        expect(configValueCalls.length).toBe(13);
    });

    it('inserts analysis model configs (4 types)', async () => {
        const { seed } = await import('../seed');
        await seed();

        const modelConfigCalls = mockValues.mock.calls.filter(
            (call) =>
                call[0] &&
                typeof call[0] === 'object' &&
                !Array.isArray(call[0]) &&
                'analysisType' in call[0] &&
                'modelId' in call[0] &&
                'useByok' in call[0],
        );
        expect(modelConfigCalls.length).toBe(4);
    });

    it('inserts notification config', async () => {
        const { seed } = await import('../seed');
        await seed();

        const notifCalls = mockValues.mock.calls.filter(
            (call) =>
                call[0] &&
                typeof call[0] === 'object' &&
                'channel' in call[0] &&
                'target' in call[0],
        );
        expect(notifCalls.length).toBe(1);
        expect(notifCalls[0][0]).toMatchObject({
            channel: 'email',
            enabled: true,
            target: 'dev.y0ngha@gmail.com',
        });
    });

    it('inserts watchlist items (5 symbols)', async () => {
        const { seed } = await import('../seed');
        await seed();

        const watchlistCalls = mockValues.mock.calls.filter(
            (call) =>
                call[0] &&
                typeof call[0] === 'object' &&
                'symbol' in call[0] &&
                'companyName' in call[0] &&
                !('side' in call[0]),
        );
        expect(watchlistCalls.length).toBe(5);
    });

    it('inserts mock positions', async () => {
        const { seed } = await import('../seed');
        await seed();

        const positionCalls = mockValues.mock.calls.filter(
            (call) =>
                Array.isArray(call[0]) &&
                call[0].length > 0 &&
                'avgPrice' in call[0][0] &&
                'openedAt' in call[0][0],
        );
        expect(positionCalls.length).toBe(1);
        expect(positionCalls[0][0]).toHaveLength(3);
    });

    it('inserts mock trades', async () => {
        const { seed } = await import('../seed');
        await seed();

        const tradeCalls = mockValues.mock.calls.filter(
            (call) =>
                call[0] &&
                typeof call[0] === 'object' &&
                !Array.isArray(call[0]) &&
                'side' in call[0] &&
                'orderType' in call[0] &&
                'executedAt' in call[0],
        );
        expect(tradeCalls.length).toBe(10);
    });

    it('inserts mock analysis results', async () => {
        const { seed } = await import('../seed');
        await seed();

        const analysisCalls = mockValues.mock.calls.filter(
            (call) =>
                call[0] &&
                typeof call[0] === 'object' &&
                !Array.isArray(call[0]) &&
                'analysisType' in call[0] &&
                'result' in call[0] &&
                'cronRunId' in call[0],
        );
        // 5 symbols x 4 types = 20
        expect(analysisCalls.length).toBe(20);
    });

    it('inserts mock pending orders', async () => {
        const { seed } = await import('../seed');
        await seed();

        const pendingCalls = mockValues.mock.calls.filter(
            (call) =>
                Array.isArray(call[0]) &&
                call[0].length > 0 &&
                'priceLimit' in call[0][0] &&
                'signalScore' in call[0][0],
        );
        expect(pendingCalls.length).toBe(1);
        expect(pendingCalls[0][0]).toHaveLength(2);
    });
});
