import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Regression guard for the neon-http → neon-serverless migration.
 *
 * `drizzle-orm/neon-http` throws "No transactions support in neon-http driver"
 * on any interactive `db.transaction()` call, which silently breaks every
 * atomic trade+position booking (the failure is masked in unit tests because
 * they mock `db.transaction`). This test pins the driver wiring so a revert to
 * neon-http is caught here rather than in production.
 */
describe('lib/db/index driver wiring', () => {
    // vitest runs from the project root; resolve the source relative to cwd.
    const src = readFileSync(resolve(process.cwd(), 'lib/db/index.ts'), 'utf8');

    it('uses the neon-serverless driver (supports interactive transactions)', () => {
        expect(src).toContain('drizzle-orm/neon-serverless');
    });

    it('does NOT use neon-http (which throws on db.transaction)', () => {
        expect(src).not.toContain('drizzle-orm/neon-http');
    });

    it('sizes the pool for the long-lived EC2 server (max 10)', () => {
        expect(src).toMatch(/max:\s*10\b/);
    });
});

const pools = vi.hoisted(() => [] as EventEmitter[]);
vi.mock('@neondatabase/serverless', async () => {
    const { EventEmitter: Emitter } = await import('node:events');
    class FakePool extends Emitter {
        constructor() {
            super();
            pools.push(this);
        }
    }
    return { Pool: FakePool, neonConfig: {} };
});
vi.mock('drizzle-orm/neon-serverless', () => ({ drizzle: (pool: unknown) => ({ pool }) }));

describe('createDb pool error handling', () => {
    // A dropped connection makes the client emit 'error'; an EventEmitter with no listener rethrows it and
    // kills the process (2026-09-24 production crash). Both the idle path (re-emitted on the pool) and the
    // checked-out path (the pool detaches its listener while a transaction holds the client) must be covered.
    async function setup() {
        vi.stubEnv('DATABASE_URL', 'postgres://user:pw@host/db');
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { createDb } = await import('../index');
        createDb();
        const pool = pools.at(-1)!;
        const client = new EventEmitter();
        pool.emit('connect', client);
        return { pool, client, log };
    }

    it('a checked-out client (no pool listener attached) survives a connection error and logs it', async () => {
        const { client, log } = await setup();
        expect(client.listenerCount('error')).toBe(1);
        expect(() =>
            client.emit('error', new Error('Connection terminated unexpectedly')),
        ).not.toThrow();
        expect(log).toHaveBeenCalledWith(
            '[db] pool client connection error:',
            'Connection terminated unexpectedly',
        );
        log.mockRestore();
        vi.unstubAllEnvs();
    });

    it('an idle client error re-emitted on the pool is not rethrown', async () => {
        const { pool, log } = await setup();
        expect(pool.listenerCount('error')).toBe(1);
        expect(() =>
            pool.emit('error', new Error('Connection terminated unexpectedly')),
        ).not.toThrow();
        log.mockRestore();
        vi.unstubAllEnvs();
    });
});
