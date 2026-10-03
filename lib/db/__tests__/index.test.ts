import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Regression guard for the driver wiring (neon-serverless → node-postgres).
 *
 * `queries.ts` decides whether an atomic trade update succeeded from `result.rowCount`,
 * and `db.transaction()` must be interactive (trade + position booked atomically).
 * `drizzle-orm/node-postgres` over a `pg` Pool provides both; `neon-http` throws on
 * transactions and `postgres-js` has no `rowCount`. This test pins the wiring so a
 * swap to either is caught here rather than in production.
 */
describe('lib/db/index driver wiring', () => {
    // vitest runs from the project root; resolve the source relative to cwd.
    const src = readFileSync(resolve(process.cwd(), 'lib/db/index.ts'), 'utf8');

    it('uses the node-postgres driver (interactive transactions + rowCount)', () => {
        expect(src).toContain('drizzle-orm/node-postgres');
        expect(src).toContain("from 'pg'");
    });

    it('does NOT use neon drivers (cannot connect to RDS) or neon-http (throws on db.transaction)', () => {
        expect(src).not.toContain('@neondatabase/serverless');
        expect(src).not.toContain('drizzle-orm/neon-');
        expect(src).not.toContain('drizzle-orm/postgres-js');
    });

    it('routes the URL through the TLS helper', () => {
        expect(src).toContain('buildPoolConfig(url)');
    });

    it('sizes the pool for the long-lived EC2 server (max 10)', () => {
        expect(src).toMatch(/max:\s*10\b/);
    });
});

const pools = vi.hoisted(() => [] as (EventEmitter & { config: unknown })[]);
vi.mock('pg', async () => {
    const { EventEmitter: Emitter } = await import('node:events');
    class FakePool extends Emitter {
        constructor(public config: unknown) {
            super();
            pools.push(this);
        }
    }
    return { Pool: FakePool };
});
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle: (pool: unknown) => ({ pool }) }));

describe('createDb pool error handling', () => {
    // A dropped connection makes the client emit 'error'; an EventEmitter with no listener rethrows it and
    // kills the process (2026-09-24 production crash). Both the idle path (re-emitted on the pool) and the
    // checked-out path (the pool detaches its listener while a transaction holds the client) must be covered.
    async function setup(url = 'postgres://user:pw@localhost/db') {
        vi.stubEnv('DATABASE_URL', url);
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

    it('passes a verified-TLS config for a remote host and max 10', async () => {
        const { pool, log } = await setup('postgres://user:pw@db.example.com/db?sslmode=require');
        expect(pool.config).toEqual({
            connectionString: 'postgres://user:pw@db.example.com/db',
            ssl: { rejectUnauthorized: true },
            connectionTimeoutMillis: 10_000,
            keepAlive: true,
            keepAliveInitialDelayMillis: 30_000,
            max: 10,
        });
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
