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

/**
 * drizzle-orm이 실제로 던지는 모양을 재현한다.
 *
 * 드라이버 에러는 `DrizzleQueryError`로 감싸이고 원본이 `cause`에 들어간다
 * (`postgres-js`·`pg`·프로덕션의 `neon-serverless` 모두 동일). 즉 실제
 * 던져지는 객체의 `.code`는 `undefined`이고 SQLSTATE는 `.cause.code`에 있다.
 *
 * 이전 버전의 이 테스트는 `Object.assign(new Error(), { code })`라는 **납작한**
 * 가짜를 던졌다. 그 모양은 프로덕션에서 절대 나오지 않으므로, 구현이
 * `err.code`만 읽어 스키마 불일치를 전혀 감지하지 못하는 상태였는데도 모든
 * SQLSTATE 테스트가 통과했다 — 배포 게이트가 장식이 된 것을 로컬 Postgres에
 * 실제로 붙여 보고 나서야 알았다. 가짜 에러는 실물과 같은 모양이어야 한다.
 */
function drizzleWrapped(message: string, code: string): Error {
    const driverError = Object.assign(new Error(message), { code });
    // `DrizzleQueryError`는 원본을 `cause`로 보존하고 자신은 `code`를 갖지 않는다.
    return Object.assign(new Error(`Failed query: ${message}`), {
        cause: driverError,
    });
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
        const err = drizzleWrapped('column "timeframe" does not exist', code);
        const db = createMockDb(vi.fn().mockRejectedValue(err));

        const result = await checkSchemaReadiness(db);

        expect(result.ready).toBe(false);
        expect(result.error).toContain(code);
    });

    it('does NOT report not-ready on an unrelated SQLSTATE — narrow allow-list only', async () => {
        // 57P03 = cannot_connect_now (Neon cold-start / restart blip)
        const err = drizzleWrapped('the database system is starting up', '57P03');
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
