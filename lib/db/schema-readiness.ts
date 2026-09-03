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
        const code = (err as { code?: unknown })?.code;
        if (typeof code === 'string' && SCHEMA_MISMATCH_CODES.has(code)) {
            return { ready: false, error: `schema mismatch (${code}): ${String(err)}` };
        }
        // Timeout, connection blip, or anything else unproven — do not fail the deploy on this.
        return { ready: true };
    }
}
