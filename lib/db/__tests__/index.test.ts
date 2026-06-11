import { describe, it, expect } from 'vitest';
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

    it('caps the pool at one connection per serverless instance', () => {
        expect(src).toMatch(/max:\s*1/);
    });
});
