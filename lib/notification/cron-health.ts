/**
 * Cron health assessment for the daily digest.
 *
 * The digest is deliberately silent when nothing happened, which leaves one blind
 * spot: "no mail" reads the same whether the night was quiet or the system was dead.
 * This closes it without reintroducing daily noise — the operator hears from us only
 * when something is actually wrong.
 *
 * Pure logic: callers pass the recent `cron_runs` rows and the current time.
 */

/** How far back to look for failed runs. */
export const ERROR_LOOKBACK_MS = 24 * 60 * 60_000;

/**
 * How long the trading crons may be silent before it counts as a problem.
 *
 * Every trading cron is weekday-only (`13-21 * * 1-5`), so a normal weekend is
 * already ~64 hours of silence: last run Friday ~21:00 UTC, next Monday ~13:00 UTC.
 * 72 hours clears that with margin while still catching a genuinely stalled system
 * within one weekday.
 */
export const SILENCE_THRESHOLD_MS = 72 * 60 * 60_000;

/**
 * `digest` is excluded from the silence check: it is the job performing this check,
 * so its own row always exists and would mask a total outage of everything else.
 */
export const SILENCE_EXCLUDED_TYPES: ReadonlySet<string> = new Set(['digest']);

/** Minimal shape this module needs from a `cron_runs` row. */
export interface CronRunSummary {
    cronType: string;
    status: string;
    startedAt: Date;
    error?: string | null;
}

export type CronHealthIssue =
    | { kind: 'errors'; count: number; types: string[] }
    | { kind: 'silence'; sinceMs: number | null };

/**
 * Assess health from recent runs. Returns an empty array when everything looks
 * normal — callers treat that as "stay silent".
 */
export function assessCronHealth(runs: readonly CronRunSummary[], now: Date): CronHealthIssue[] {
    const issues: CronHealthIssue[] = [];
    const nowMs = now.getTime();

    const failed = runs.filter(
        (r) => r.status === 'error' && nowMs - r.startedAt.getTime() <= ERROR_LOOKBACK_MS,
    );
    if (failed.length > 0) {
        issues.push({
            kind: 'errors',
            count: failed.length,
            types: [...new Set(failed.map((r) => r.cronType))].sort(),
        });
    }

    const tradingRuns = runs.filter((r) => !SILENCE_EXCLUDED_TYPES.has(r.cronType));
    const latest = tradingRuns.reduce<number | null>(
        (max, r) => (max === null || r.startedAt.getTime() > max ? r.startedAt.getTime() : max),
        null,
    );
    const sinceMs = latest === null ? null : nowMs - latest;
    if (sinceMs === null || sinceMs > SILENCE_THRESHOLD_MS) {
        issues.push({ kind: 'silence', sinceMs });
    }

    return issues;
}

/** Render issues as plain lines for the alert email body. */
export function describeCronHealth(issues: readonly CronHealthIssue[]): string[] {
    return issues.map((issue) => {
        if (issue.kind === 'errors') {
            return `최근 24시간 동안 크론 ${issue.count}건이 실패했습니다 (${issue.types.join(', ')}).`;
        }
        if (issue.sinceMs === null) {
            return '기록된 크론 실행이 없습니다. 스케줄러가 아예 동작하지 않는 상태일 수 있습니다.';
        }
        const hours = Math.floor(issue.sinceMs / 3_600_000);
        return `매매 크론이 ${hours}시간째 실행되지 않았습니다 (임계값 ${SILENCE_THRESHOLD_MS / 3_600_000}시간).`;
    });
}
