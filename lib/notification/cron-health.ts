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

/**
 * 매매 판단 단계가 이만큼 없으면 알린다(docs/specs/2026-09-24-daily-mean-reversion-design.md §6).
 *
 * 위의 침묵 검사는 digest 외 **아무** 크론 행이나 센다. `reconcile`은 세션 게이트 없이 10분마다
 * 행을 남기므로 execute가 죽어도 침묵이 되지 않는다 — 판단이 하루 1회로 모인 지금은 그 사각이
 * 치명적이다. 창이 72시간이 아닌 이유: 판단은 하루 1회라 금요일 판단 → (월요일 공휴일) → 화요일
 * 판단이 96시간이다. 72시간이면 공휴일마다 헛경보가 난다.
 */
export const DECISION_SILENCE_MS = 100 * 60 * 60_000;

export type CronHealthIssue =
    | { kind: 'errors'; count: number; types: string[] }
    | { kind: 'silence'; sinceMs: number | null }
    | { kind: 'no_decision' };

/**
 * Assess health from recent runs. Returns an empty array when everything looks
 * normal — callers treat that as "stay silent".
 */
export function assessCronHealth(
    runs: readonly CronRunSummary[],
    now: Date,
    /** 최근 `DECISION_SILENCE_MS` 안에 판단 단계를 끝낸 execute 런이 있었는가. 모르면 생략. */
    decisionPhaseSeen?: boolean,
    /**
     * 킬 스위치(`trading_enabled`) 상태 — 꺼져 있으면 execute가 판단 단계 전에 의도적으로
     * 빠져나가므로 `no_decision`은 헛경보다(스펙 §6). 기본값 `true`는 하위호환용 —
     * 이 인자를 안 넘기던 기존 호출부는 종전과 같이 판단 침묵을 경보한다.
     */
    tradingEnabled = true,
): CronHealthIssue[] {
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
    if (decisionPhaseSeen === false && tradingEnabled) {
        issues.push({ kind: 'no_decision' });
    }

    return issues;
}

/** Render issues as plain lines for the alert email body. */
export function describeCronHealth(issues: readonly CronHealthIssue[]): string[] {
    return issues.map((issue) => {
        if (issue.kind === 'errors') {
            return `최근 24시간 동안 크론 ${issue.count}건이 실패했습니다 (${issue.types.join(', ')}).`;
        }
        if (issue.kind === 'no_decision') {
            return `매매 판단 단계가 ${DECISION_SILENCE_MS / 3_600_000}시간 동안 한 번도 끝나지 않았습니다 — execute 크론이나 판단 창(마감 20분 전)을 확인하세요.`;
        }
        if (issue.sinceMs === null) {
            return '기록된 크론 실행이 없습니다. 스케줄러가 아예 동작하지 않는 상태일 수 있습니다.';
        }
        const hours = Math.floor(issue.sinceMs / 3_600_000);
        return `매매 크론이 ${hours}시간째 실행되지 않았습니다 (임계값 ${SILENCE_THRESHOLD_MS / 3_600_000}시간).`;
    });
}
