import { describe, it, expect } from 'vitest';
import {
    ERROR_LOOKBACK_MS,
    SILENCE_THRESHOLD_MS,
    assessCronHealth,
    describeCronHealth,
    type CronRunSummary,
} from '../cron-health';

const NOW = new Date('2026-08-12T01:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 3_600_000;

function run(over: Partial<CronRunSummary> = {}): CronRunSummary {
    return { cronType: 'technical', status: 'completed', startedAt: ago(HOUR), ...over };
}

describe('assessCronHealth', () => {
    it('stays silent when recent runs all succeeded', () => {
        expect(assessCronHealth([run(), run({ cronType: 'execute' })], NOW)).toEqual([]);
    });

    it('reports failed runs from the last 24 hours, deduplicating the types', () => {
        const issues = assessCronHealth(
            [
                run({ status: 'error', cronType: 'execute' }),
                run({ status: 'error', cronType: 'execute' }),
                run({ status: 'error', cronType: 'news' }),
                run(),
            ],
            NOW,
        );

        expect(issues).toContainEqual({ kind: 'errors', count: 3, types: ['execute', 'news'] });
    });

    it('ignores failures older than the lookback window', () => {
        const issues = assessCronHealth(
            [run({ status: 'error', startedAt: ago(ERROR_LOOKBACK_MS + 1) }), run()],
            NOW,
        );
        expect(issues).toEqual([]);
    });

    it('treats a normal weekend gap as healthy', () => {
        // Friday 21:00 UTC → Monday 13:00 UTC is ~64h of legitimate silence for
        // weekday-only crons; alerting on that would cry wolf every Monday morning.
        expect(assessCronHealth([run({ startedAt: ago(64 * HOUR) })], NOW)).toEqual([]);
    });

    it('reports silence once the threshold is passed', () => {
        const issues = assessCronHealth(
            [run({ startedAt: ago(SILENCE_THRESHOLD_MS + HOUR) })],
            NOW,
        );
        expect(issues).toContainEqual({ kind: 'silence', sinceMs: SILENCE_THRESHOLD_MS + HOUR });
    });

    it("does not let the digest's own run mask a total outage", () => {
        // digest is the job running this check, so its row always exists.
        const issues = assessCronHealth(
            [
                run({ cronType: 'digest', startedAt: ago(60_000) }),
                run({ startedAt: ago(SILENCE_THRESHOLD_MS + HOUR) }),
            ],
            NOW,
        );
        expect(issues.some((i) => i.kind === 'silence')).toBe(true);
    });

    it('reports silence when there are no runs at all', () => {
        expect(assessCronHealth([], NOW)).toEqual([{ kind: 'silence', sinceMs: null }]);
    });

    it('reports both problems at once', () => {
        // digest failing while every trading cron is dead: digest is excluded from the
        // silence check, so it can be a recent error without resetting the silence clock.
        const issues = assessCronHealth(
            [
                run({ cronType: 'digest', status: 'error', startedAt: ago(HOUR) }),
                run({ startedAt: ago(SILENCE_THRESHOLD_MS + HOUR) }),
            ],
            NOW,
        );
        expect(issues.map((i) => i.kind).sort()).toEqual(['errors', 'silence']);
    });

    it('counts an errored run as having run — a failure is not silence', () => {
        const issues = assessCronHealth([run({ status: 'error', startedAt: ago(HOUR) })], NOW);
        expect(issues.map((i) => i.kind)).toEqual(['errors']);
    });
});

describe('describeCronHealth', () => {
    it('names the failing cron types', () => {
        const [line] = describeCronHealth([
            { kind: 'errors', count: 3, types: ['execute', 'news'] },
        ]);
        expect(line).toContain('3건');
        expect(line).toContain('execute, news');
    });

    it('reports the silence in hours', () => {
        const [line] = describeCronHealth([{ kind: 'silence', sinceMs: 80 * HOUR }]);
        expect(line).toContain('80시간');
    });

    it('distinguishes "never ran" from "ran long ago"', () => {
        const [line] = describeCronHealth([{ kind: 'silence', sinceMs: null }]);
        expect(line).toContain('기록된 크론 실행이 없습니다');
    });

    it('returns one line per issue', () => {
        expect(
            describeCronHealth([
                { kind: 'errors', count: 1, types: ['execute'] },
                { kind: 'silence', sinceMs: null },
            ]),
        ).toHaveLength(2);
    });
});
