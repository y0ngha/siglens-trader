import { analysisResults } from './schema.js';
import type { Db } from './index.js';

/** Health-probe query must not itself wedge the health endpoint if Neon hangs. */
const SCHEMA_PROBE_TIMEOUT_MS = 2000;

/**
 * SQLSTATEs that mean "the running image and the database schema disagree" — Postgres
 * raises these only when a query names a column (42703) or table (42P01) that isn't
 * there. Deliberately narrow: any other error (including unrecognized SQLSTATEs) is
 * treated as a transient DB problem, not a schema mismatch, and must not fail the probe.
 * This repo has no shared transient-vs-fatal DB error classifier to reuse (checked
 * lib/trading/client.ts and lib/data/fmp-http.ts — both classify *HTTP* retry-worthiness
 * for external APIs, not Postgres SQLSTATEs), so this allow-list is deliberately kept to
 * the two codes this probe can actually prove.
 */
const SCHEMA_MISMATCH_CODES = new Set(['42703', '42P01']);

export interface SchemaReadinessResult {
    ready: boolean;
    /** Present only when `ready` is false — a confirmed schema mismatch. */
    error?: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    // A rejection here is caught by the caller below and — having no `.code` — falls
    // through to the transient branch, same as any other non-Postgres error.
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('schema_probe_timeout')), ms);
        }),
    ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Postgres SQLSTATE를 에러에서 꺼낸다 — **`err.code`만 봐서는 안 된다.**
 *
 * drizzle-orm은 드라이버 에러를 `DrizzleQueryError`로 감싸고 원본을
 * `cause`에 넣는다. 그래서 실제로 던져지는 모양은
 * `DrizzleQueryError { cause: PostgresError { code: '42703' } }`이고
 * `err.code`는 `undefined`다. 이 래핑은 `postgres-js`·`pg`·프로덕션이 쓰는
 * `neon-serverless` 드라이버에 공통이다.
 *
 * 이 함수가 존재하는 이유: 예전 구현이 `err.code`만 읽어서 컬럼이 없어도
 * 항상 `ready: true`를 돌려줬다 — 배포 게이트가 **어떤 환경에서도** 스키마
 * 불일치를 잡을 수 없는 상태였다. 로컬 Postgres 컨테이너에 실제로 붙여 보고
 * 나서야 드러났다. 단위 테스트는 `Object.assign(new Error(), { code })`라는
 * 납작한 가짜 에러를 던지고 있어서, 버그가 그대로 배포돼도 전부 초록이었다
 * (`isNeonTransientError.ts`가 이미 `cause` 체인을 훑는 것과 같은 이유다).
 */
function extractSqlState(err: unknown): string | undefined {
    let node: unknown = err;
    // 래핑이 중첩될 수 있으므로 cause 체인을 따라가되, 순환 참조로
    // 무한 루프에 빠지지 않도록 깊이를 제한한다.
    for (let depth = 0; node !== null && node !== undefined && depth < 5; depth++) {
        const code = (node as { code?: unknown }).code;
        if (typeof code === 'string') return code;
        node = (node as { cause?: unknown }).cause;
    }
    return undefined;
}

/**
 * Confirms `analysis_results.timeframe` (migration 0018) actually exists in the
 * connected database before `/api/health?ready=true` reports healthy.
 *
 * WHY THIS EXISTS: Drizzle never emits `SELECT *` — `.select()` builds an explicit
 * column list from the schema object. If this image's code ships before
 * `yarn db:migrate` runs, every `analysis_results` query breaks, including
 * `getLatestAnalysisResult` (the execute cron's staleness gate across all five score
 * axes). Each cron's per-symbol/per-position try/catch absorbs that error — no wrong
 * order goes out — but every open position's stop-loss/target evaluation goes dark for
 * the whole window, silently. `infra/aws/deploy.sh` already gates deploy success on
 * `/api/health`; this probe gives that gate something to actually catch (see
 * docs/DEPLOYMENT.md §12).
 *
 * Selects the single column via the schema object (not a hand-written SQL string) so
 * this exercises the exact same "explicit column list" query-building path that broke
 * in production, against a table Postgres will happily report as empty (not error)
 * when it merely has zero rows — the failure only fires when the column itself is
 * missing.
 */
export async function checkSchemaReadiness(
    db: Db,
    timeoutMs = SCHEMA_PROBE_TIMEOUT_MS,
): Promise<SchemaReadinessResult> {
    try {
        await withTimeout(
            db.select({ timeframe: analysisResults.timeframe }).from(analysisResults).limit(1),
            timeoutMs,
        );
        return { ready: true };
    } catch (err) {
        const code = extractSqlState(err);
        if (code !== undefined && SCHEMA_MISMATCH_CODES.has(code)) {
            return { ready: false, error: `schema mismatch (${code}): ${String(err)}` };
        }
        // Timeout, connection blip, or anything else unproven — do not fail the deploy on this.
        return { ready: true };
    }
}
