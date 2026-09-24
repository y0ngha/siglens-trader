import { describe, it, expect, vi, afterEach } from 'vitest';

const q = vi.hoisted(() => ({
    getNewsCards: vi.fn(),
    upsertNewsCards: vi.fn(),
    getRecentAnalysisResults: vi.fn(),
}));
vi.mock('../../../lib/db/queries', () => ({
    getNewsCards: (...a: unknown[]) => q.getNewsCards(...a),
    upsertNewsCards: (...a: unknown[]) => q.upsertNewsCards(...a),
    getRecentAnalysisResults: (...a: unknown[]) => q.getRecentAnalysisResults(...a),
}));

import { resolveApiKey, withDeadline, newsCardStore, priorAnalysisStore } from '../_analysis-io';
import type { Db } from '../../../lib/db/index';

const db = {} as Db;

describe('resolveApiKey', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('maps the provider prefix to its env key and warns when it is empty', () => {
        vi.stubEnv('DEEPSEEK_API_KEY', 'ds');
        vi.stubEnv('ANTHROPIC_API_KEY', 'an');
        vi.stubEnv('OPENAI_API_KEY', 'oa');
        vi.stubEnv('GEMINI_API_KEY', '');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(resolveApiKey('deepseek-v4.1-pro')).toBe('ds');
        expect(resolveApiKey('claude-x')).toBe('an');
        expect(resolveApiKey('gpt-x')).toBe('oa');
        expect(resolveApiKey('gemini-x')).toBe('');
        expect(warn).toHaveBeenCalledOnce();
        expect(resolveApiKey('llama')).toBeUndefined();
    });
});

describe('withDeadline', () => {
    it('passes a result through and rejects after the deadline', async () => {
        expect(await withDeadline(Promise.resolve(1), 1000)).toBe(1);
        await expect(withDeadline(new Promise(() => {}), 5)).rejects.toThrow('run_deadline');
    });

    it('rejects immediately on a spent budget without leaking the input rejection', async () => {
        const failing = Promise.reject(new Error('late'));
        await expect(withDeadline(failing, 0)).rejects.toThrow('run_deadline');
    });
});

describe('stores', () => {
    it('newsCardStore delegates to the news card queries', async () => {
        const store = newsCardStore(db);
        await store.getCards(['a']);
        await store.upsertCards([]);
        expect(q.getNewsCards).toHaveBeenCalledWith(db, ['a']);
        expect(q.upsertNewsCards).toHaveBeenCalledWith(db, []);
    });

    it('priorAnalysisStore reads technical history only', async () => {
        const since = new Date('2026-01-01');
        await priorAnalysisStore(db).getRecent({
            symbol: 'NVDA',
            timeframe: '1Day',
            limit: 5,
            since,
        });
        expect(q.getRecentAnalysisResults).toHaveBeenCalledWith(db, {
            symbol: 'NVDA',
            type: 'technical',
            timeframe: '1Day',
            limit: 5,
            since,
        });
    });
});
