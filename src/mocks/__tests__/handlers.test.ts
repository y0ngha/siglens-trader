import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';
import { handlers } from '../handlers';

interface AnalysisConfig {
    modelId: string;
}

interface ConfigResponse {
    analysis: AnalysisConfig[];
}

const server = setupServer(...handlers);

beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
    server.resetHandlers();
});

afterAll(() => {
    server.close();
});

describe('mock config handler', () => {
    it('returns deepseek flash defaults for all analysis configs', async () => {
        const response = await fetch(new URL('/api/config', window.location.href));
        const body = (await response.json()) as ConfigResponse;

        expect(response.ok).toBe(true);
        expect(body.analysis).toHaveLength(4);
        expect(body.analysis.every(({ modelId }) => modelId === 'deepseek-v4.1-flash')).toBe(true);
    });

    // ─── C8: numeric bounds mirror api/config.ts NUMERIC_BOUNDS ────────────────

    async function postConfig(key: string, value: unknown) {
        return fetch(new URL('/api/config', window.location.href), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'config', key, value }),
        });
    }

    it('rejects mr_stop_atr above 20 with the same error format as api/config.ts', async () => {
        const response = await postConfig('mr_stop_atr', 25);
        const body = (await response.json()) as { error: string };

        expect(response.status).toBe(400);
        expect(body.error).toBe('mr_stop_atr must be between 0 and 20');
    });

    it('rejects a non-integer mr_max_hold_days', async () => {
        const response = await postConfig('mr_max_hold_days', 5.5);
        const body = (await response.json()) as { error: string };

        expect(response.status).toBe(400);
        expect(body.error).toBe('mr_max_hold_days must be an integer between 1 and 60');
    });

    it('rejects mr_rsi_entry outside 1-50', async () => {
        const response = await postConfig('mr_rsi_entry', 0);
        const body = (await response.json()) as { error: string };

        expect(response.status).toBe(400);
        expect(body.error).toBe('mr_rsi_entry must be between 1 and 50');
    });

    it('rejects dry_run_cost_bps outside 0-100', async () => {
        const response = await postConfig('dry_run_cost_bps', 150);
        const body = (await response.json()) as { error: string };

        expect(response.status).toBe(400);
        expect(body.error).toBe('dry_run_cost_bps must be between 0 and 100');
    });

    it('accepts mr_stop_atr = 0 (disaster stop off is a valid value)', async () => {
        const response = await postConfig('mr_stop_atr', 0);
        expect(response.status).toBe(200);
    });

    it('accepts a value inside bounds and persists it', async () => {
        const response = await postConfig('mr_rsi_entry', 15);
        expect(response.status).toBe(200);

        const getResponse = await fetch(new URL('/api/config', window.location.href));
        const body = (await getResponse.json()) as {
            config: { key: string; value: unknown }[];
        };
        expect(body.config.find((c) => c.key === 'mr_rsi_entry')?.value).toBe(15);
    });
});
