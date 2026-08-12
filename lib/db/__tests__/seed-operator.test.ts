import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockHashPassword, mockDestroyUserSessions } = vi.hoisted(() => ({
    mockHashPassword: vi.fn<(password: string) => Promise<string>>(),
    mockDestroyUserSessions: vi.fn(),
}));

vi.mock('../../auth/password.js', () => ({
    hashPassword: (...args: [string]) => mockHashPassword(...args),
}));

vi.mock('../../auth/session.js', () => ({
    destroyUserSessions: (...args: unknown[]) => mockDestroyUserSessions(...args),
    normalizeEmail: (email: string) => email.trim().toLowerCase(),
}));

import type { Db } from '../index.js';
import { claimExistingData, upsertOperator } from '../seed-operator';

const OPERATOR_ID = '8402889a-e644-47b8-98f5-4ab695dff758';

/**
 * Flatten a Drizzle `SQL` into readable text.
 *
 * Both `sql` and `sql.raw` store their literal text in `queryChunks[].value` (an array
 * of string fragments); bind parameters appear as other chunk types and are irrelevant
 * to what these tests assert.
 */
function sqlText(query: unknown): string {
    const chunks = (query as { queryChunks?: { value?: unknown }[] })?.queryChunks;
    if (!Array.isArray(chunks)) return JSON.stringify(query);
    return chunks
        .map((chunk) => (Array.isArray(chunk?.value) ? chunk.value.join('') : ''))
        .join('');
}

/** Chainable + thenable stand-in for a Drizzle builder; results are queued in await order. */
function createFakeDb(results: unknown[][] = []) {
    const ops: string[] = [];
    const statements: string[] = [];
    const queue = [...results];

    const chain = () => {
        const node: Record<string, unknown> = {
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
                Promise.resolve(queue.shift() ?? []).then(resolve, reject),
        };
        for (const method of ['from', 'where', 'limit', 'values', 'returning', 'set']) {
            node[method] = () => node;
        }
        return node;
    };

    const handle = {
        select: () => {
            ops.push('select');
            return chain();
        },
        insert: () => {
            ops.push('insert');
            return chain();
        },
        update: () => {
            ops.push('update');
            return chain();
        },
        execute: (query: unknown) => {
            statements.push(sqlText(query));
            ops.push('execute');
            return Promise.resolve({ rowCount: 1 });
        },
        transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
            ops.push('begin');
            const result = await fn(handle);
            ops.push('commit');
            return result;
        },
    };

    return { db: handle as unknown as Db, ops, statements };
}

describe('upsertOperator', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockHashPassword.mockResolvedValue('$2b$12$hash');
    });

    it('creates the account when the email is unknown', async () => {
        const { db, ops } = createFakeDb([[], [{ id: OPERATOR_ID }]]);

        await expect(upsertOperator(db, 'dev@example.com', 'secret')).resolves.toBe(OPERATOR_ID);
        expect(ops).toEqual(['select', 'insert']);
        expect(mockDestroyUserSessions).not.toHaveBeenCalled();
    });

    it('rotates the password and kills existing sessions when the account exists', async () => {
        const { db, ops } = createFakeDb([[{ id: OPERATOR_ID }], []]);

        await expect(upsertOperator(db, 'dev@example.com', 'new-secret')).resolves.toBe(
            OPERATOR_ID,
        );
        expect(ops).toEqual(['select', 'update']);
        // A rotated password that left old cookies working would not be a rotation.
        expect(mockDestroyUserSessions).toHaveBeenCalledWith(db, OPERATOR_ID);
    });

    it('normalizes the email so re-running cannot create a second casing', async () => {
        const { db } = createFakeDb([[{ id: OPERATOR_ID }], []]);
        await upsertOperator(db, '  Dev@Example.COM ', 'secret');
        expect(mockHashPassword).toHaveBeenCalledWith('secret');
    });

    it('never stores the plaintext password', async () => {
        const { db } = createFakeDb([[], [{ id: OPERATOR_ID }]]);
        await upsertOperator(db, 'dev@example.com', 'secret');
        expect(mockHashPassword).toHaveBeenCalledWith('secret');
        expect(mockHashPassword).toHaveBeenCalledTimes(1);
    });
});

describe('claimExistingData', () => {
    it('rejects anything that is not a uuid before it reaches the DDL', async () => {
        // The id is string-interpolated into ALTER TABLE (DDL takes no bind parameters),
        // so this guard is the only thing between it and SQL injection.
        for (const bad of [
            "'; DROP TABLE trades; --",
            'not-a-uuid',
            '',
            '8402889a-e644-47b8-98f5-4ab695dff75',
        ]) {
            const { db, statements } = createFakeDb();
            await expect(claimExistingData(db, bad)).rejects.toThrow('Not a uuid');
            expect(statements).toHaveLength(0);
        }
    });

    it('backfills and sets the DEFAULT for all eight owned tables in one transaction', async () => {
        const { db, ops, statements } = createFakeDb();

        const claimed = await claimExistingData(db, OPERATOR_ID);

        expect(ops[0]).toBe('begin');
        expect(ops.at(-1)).toBe('commit');

        const owned = [
            'watchlist',
            'analysis_model_config',
            'positions',
            'trades',
            'pending_orders',
            'config',
            'order_tracking',
            'notification_config',
        ];
        expect(Object.keys(claimed)).toEqual(owned);

        // One UPDATE + one ALTER per table.
        expect(statements).toHaveLength(owned.length * 2);
        for (const table of owned) {
            expect(statements).toContain(
                `ALTER TABLE "${table}" ALTER COLUMN user_id SET DEFAULT '${OPERATOR_ID}'::uuid`,
            );
        }
    });

    it('reports the number of rows claimed per table', async () => {
        const { db } = createFakeDb();
        const claimed = await claimExistingData(db, OPERATOR_ID);
        expect(claimed.trades).toBe(1);
    });
});
