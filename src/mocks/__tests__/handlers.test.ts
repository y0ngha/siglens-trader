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
    it('returns Flash Lite defaults for all analysis configs', async () => {
        const response = await fetch(new URL('/api/config', window.location.href));
        const body = (await response.json()) as ConfigResponse;

        expect(response.ok).toBe(true);
        expect(body.analysis).toHaveLength(4);
        expect(body.analysis.every(({ modelId }) => modelId === 'gemini-2.5-flash-lite')).toBe(
            true,
        );
    });
});
