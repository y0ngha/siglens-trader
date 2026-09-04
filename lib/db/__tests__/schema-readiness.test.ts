import { describe, it, expect, vi } from 'vitest';
import type { Db } from '../index';
import { checkSchemaReadiness } from '../schema-readiness';

/**
 * Minimal mock covering only the `.select({...}).from(...).limit(1)` chain
 * `checkSchemaReadiness` uses — narrower than `queries.test.ts`'s `createMockDb`
 * because this probe is the only caller in this file.
 */
function createMockDb(limit: ReturnType<typeof vi.fn>) {
    const chain = { from: vi.fn().mockReturnThis(), limit };
    return { select: vi.fn().mockReturnValue(chain) } as unknown as Db;
}

describe('checkSchemaReadiness', () => {
    it('reports ready when the column query resolves', async () => {
        const db = createMockDb(vi.fn().mockResolvedValue([{ timeframe: '1Hour' }]));

        const result = await checkSchemaReadiness(db);

        expect(result).toEqual({ ready: true });
    });

    it('reports ready on an empty table (no rows is not a schema mismatch)', async () => {
        const db = createMockDb(vi.fn().mockResolvedValue([]));

        const result = await checkSchemaReadiness(db);

        expect(result).toEqual({ ready: true });
    });

    it.each([
        ['42703', 'undefined_column'],
        ['42P01', 'undefined_table'],
    ])('reports not-ready on Postgres %s (%s)', async (code) => {
        const err = Object.assign(new Error('column "timeframe" does not exist'), { code });
        const db = createMockDb(vi.fn().mockRejectedValue(err));

        const result = await checkSchemaReadiness(db);

        expect(result.ready).toBe(false);
        expect(result.error).toContain(code);
    });

    it('does NOT report not-ready on an unrelated SQLSTATE — narrow allow-list only', async () => {
        // 57P03 = cannot_connect_now (Neon cold-start / restart blip)
        const err = Object.assign(new Error('the database system is starting up'), {
            code: '57P03',
        });
        const db = createMockDb(vi.fn().mockRejectedValue(err));

        const result = await checkSchemaReadiness(db);

        expect(result).toEqual({ ready: true });
    });

    it('does NOT report not-ready on a plain connection error with no .code', async () => {
        const db = createMockDb(vi.fn().mockRejectedValue(new Error('fetch failed')));

        const result = await checkSchemaReadiness(db);

        expect(result).toEqual({ ready: true });
    });

    it('bounds a hung query — reports ready rather than blocking the health endpoint', async () => {
        // Never resolves/rejects: simulates a wedged connection. A short timeoutMs
        // must still make the probe return promptly instead of hanging the caller.
        const db = createMockDb(vi.fn().mockReturnValue(new Promise(() => {})));

        const result = await checkSchemaReadiness(db, 15);

        expect(result).toEqual({ ready: true });
    });
});
