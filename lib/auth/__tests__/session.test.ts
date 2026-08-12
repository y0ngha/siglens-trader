import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockVerifyPassword = vi.fn<(password: string, hash: string) => Promise<boolean>>();
vi.mock('../password', () => ({
    verifyPassword: (...args: [string, string]) => mockVerifyPassword(...args),
    hashPassword: () => Promise.resolve('$2a$12$hash'),
}));

import type { Db } from '../../db/index.js';
import { authenticate, createSession, destroySession, resolveSessionUser } from '../session';
import { SESSION_TTL_SECONDS } from '../cookie';

/**
 * Drizzle query builders are chainable and thenable; the fake mirrors that shape
 * and hands back queued results in await order, so the tests exercise the real
 * control flow rather than a stubbed-out repository.
 */
function createFakeDb(results: unknown[][]) {
    const ops: string[] = [];
    const queue = [...results];

    const chain = () => {
        const node: Record<string, unknown> = {
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
                Promise.resolve(queue.shift() ?? []).then(resolve, reject),
        };
        for (const method of [
            'from',
            'innerJoin',
            'where',
            'limit',
            'values',
            'returning',
            'set',
        ]) {
            node[method] = () => node;
        }
        return node;
    };

    const db = {
        select: () => {
            ops.push('select');
            return chain();
        },
        insert: () => {
            ops.push('insert');
            return chain();
        },
        delete: () => {
            ops.push('delete');
            return chain();
        },
        update: () => {
            ops.push('update');
            return chain();
        },
    };

    return { db: db as unknown as Db, ops };
}

const NOW = new Date('2026-08-12T00:00:00.000Z');

describe('createSession', () => {
    it('stores a row expiring one TTL from now and returns its id', async () => {
        const { db } = createFakeDb([[{ id: 'session-1' }]]);
        await expect(createSession(db, 'user-1', NOW)).resolves.toBe('session-1');
    });

    it('uses the 30-day TTL shared with the cookie', () => {
        expect(SESSION_TTL_SECONDS).toBe(60 * 60 * 24 * 30);
    });
});

describe('resolveSessionUser', () => {
    it('returns the joined user for a live session', async () => {
        const { db, ops } = createFakeDb([
            [
                {
                    expiresAt: new Date(NOW.getTime() + 1_000),
                    id: 'user-1',
                    email: 'operator@example.com',
                    name: 'Operator',
                },
            ],
        ]);

        await expect(resolveSessionUser(db, 'session-1', NOW)).resolves.toEqual({
            id: 'user-1',
            email: 'operator@example.com',
            name: 'Operator',
        });
        expect(ops).toEqual(['select']);
    });

    it('returns null for an unknown session id', async () => {
        const { db } = createFakeDb([[]]);
        await expect(resolveSessionUser(db, 'nope', NOW)).resolves.toBeNull();
    });

    it('rejects an expired session and deletes the row', async () => {
        const { db, ops } = createFakeDb([
            [{ expiresAt: NOW, id: 'user-1', email: 'operator@example.com', name: null }],
            [],
        ]);

        // expiresAt exactly equal to now is already expired (<=).
        await expect(resolveSessionUser(db, 'session-1', NOW)).resolves.toBeNull();
        expect(ops).toEqual(['select', 'delete']);
    });
});

describe('destroySession', () => {
    it('issues a delete', async () => {
        const { db, ops } = createFakeDb([[]]);
        await destroySession(db, 'session-1');
        expect(ops).toEqual(['delete']);
    });
});

describe('authenticate', () => {
    beforeEach(() => {
        mockVerifyPassword.mockReset();
    });

    it('opens a session when the password matches', async () => {
        mockVerifyPassword.mockResolvedValue(true);
        const { db, ops } = createFakeDb([
            [
                {
                    id: 'user-1',
                    email: 'operator@example.com',
                    name: null,
                    passwordHash: '$2a$12$hash',
                },
            ],
            [{ id: 'session-1' }],
        ]);

        await expect(authenticate(db, 'operator@example.com', 'secret', NOW)).resolves.toEqual({
            user: { id: 'user-1', email: 'operator@example.com', name: null },
            sessionId: 'session-1',
        });
        expect(ops).toEqual(['select', 'insert']);
    });

    it('normalizes the email before lookup', async () => {
        mockVerifyPassword.mockResolvedValue(true);
        const { db } = createFakeDb([
            [{ id: 'user-1', email: 'operator@example.com', name: null, passwordHash: 'h' }],
            [{ id: 'session-1' }],
        ]);

        await expect(
            authenticate(db, '  Operator@Example.COM ', 'secret', NOW),
        ).resolves.not.toBeNull();
    });

    it('returns null for an unknown email without touching bcrypt', async () => {
        const { db, ops } = createFakeDb([[]]);

        await expect(authenticate(db, 'ghost@example.com', 'secret', NOW)).resolves.toBeNull();
        expect(mockVerifyPassword).not.toHaveBeenCalled();
        expect(ops).toEqual(['select']);
    });

    it('returns null for an account with no password hash (OAuth-only shape)', async () => {
        const { db } = createFakeDb([
            [{ id: 'user-1', email: 'operator@example.com', name: null, passwordHash: null }],
        ]);

        await expect(authenticate(db, 'operator@example.com', 'secret', NOW)).resolves.toBeNull();
        expect(mockVerifyPassword).not.toHaveBeenCalled();
    });

    it('returns null — and creates no session — on a wrong password', async () => {
        mockVerifyPassword.mockResolvedValue(false);
        const { db, ops } = createFakeDb([
            [{ id: 'user-1', email: 'operator@example.com', name: null, passwordHash: 'h' }],
        ]);

        await expect(authenticate(db, 'operator@example.com', 'wrong', NOW)).resolves.toBeNull();
        expect(ops).toEqual(['select']);
    });
});
