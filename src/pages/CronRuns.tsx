import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { CronRun, CronDecision } from '@/lib/api';
import { EmptyState } from '@/components/EmptyState';
import { ErrorMessage } from '@/components/ErrorMessage';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';

// ─── types ───────────────────────────────────────────────────────────────────

type CronTypeFilter =
    | 'all'
    | 'technical'
    | 'news'
    | 'options'
    | 'fundamental'
    | 'execute'
    | 'reconcile';

type StatusFilter = 'all' | 'completed' | 'skipped' | 'error' | 'running';

type DatePreset = 'today' | '7d' | '30d';

// ─── helpers ──────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return '방금 전';
    if (minutes < 60) return `${minutes}분 전`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}시간 전`;
    const days = Math.floor(hours / 24);
    return `${days}일 전`;
}

function formatAbsTime(dateStr: string): string {
    const d = new Date(dateStr);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${mm}/${dd} ${hh}:${min}:${ss}`;
}

function formatDuration(ms: number | null): string {
    if (ms == null) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

function getDateRange(preset: DatePreset): { from: string; to: string } {
    const now = new Date();
    const to = now.toISOString();
    if (preset === 'today') {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        return { from: start.toISOString(), to };
    }
    if (preset === '7d') {
        const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        return { from: start.toISOString(), to };
    }
    // 30d
    const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { from: start.toISOString(), to };
}

function cronTypeLabel(type: string): string {
    switch (type) {
        case 'technical':
            return '기술';
        case 'news':
            return '뉴스';
        case 'options':
            return '옵션';
        case 'fundamental':
            return '펀더멘털';
        case 'execute':
            return '실행';
        case 'reconcile':
            return '정합';
        default:
            return type;
    }
}

function cronTypeChipClass(type: string): string {
    switch (type) {
        case 'execute':
            return 'bg-blue-500/10 text-blue-400';
        case 'reconcile':
            return 'bg-violet-500/10 text-violet-400';
        case 'technical':
        case 'news':
        case 'options':
        case 'fundamental':
            return 'bg-teal-500/10 text-teal-400';
        default:
            return 'bg-neutral-700 text-neutral-300';
    }
}

function statusBorderClass(status: string): string {
    switch (status) {
        case 'completed':
            return 'border-l-green-500';
        case 'error':
            return 'border-l-red-500';
        case 'running':
            return 'border-l-amber-500';
        default:
            return 'border-l-neutral-600';
    }
}

function statusDotClass(status: string): string {
    switch (status) {
        case 'completed':
            return 'bg-green-500';
        case 'error':
            return 'bg-red-500';
        case 'running':
            return 'bg-amber-500 animate-pulse';
        default:
            return 'bg-neutral-600';
    }
}

function outcomeTextClass(status: string): string {
    switch (status) {
        case 'completed':
            return 'text-green-400';
        case 'error':
            return 'text-red-400';
        case 'running':
            return 'text-amber-400';
        default:
            return 'text-neutral-500';
    }
}

function actionChipClass(action: string): string {
    switch (action) {
        case 'buy':
        case 'average_in':
            return 'bg-green-500/10 text-green-400';
        case 'sell':
        case 'error':
            return 'bg-red-500/10 text-red-400';
        default:
            return 'bg-neutral-700 text-neutral-400';
    }
}

// ─── summary parsing ──────────────────────────────────────────────────────────

function parseSummary(cronType: string, summary: unknown): string {
    try {
        if (summary == null || typeof summary !== 'object') return '';
        const s = summary as Record<string, unknown>;

        if (cronType === 'execute') {
            const parts: string[] = [];
            if (typeof s.symbolsEvaluated === 'number') {
                parts.push(`${s.symbolsEvaluated}종목`);
            }
            if (s.decisionsByAction && typeof s.decisionsByAction === 'object') {
                const dba = s.decisionsByAction as Record<string, number>;
                const entries = Object.entries(dba)
                    .filter(([, v]) => v > 0)
                    .slice(0, 4)
                    .map(([k, v]) => `${k} ${v}`);
                if (entries.length > 0) parts.push(entries.join('·'));
            }
            return parts.join(' / ');
        }

        if (['technical', 'news', 'options', 'fundamental'].includes(cronType)) {
            const saved =
                s.saved ?? s.analysisCount ?? s.savedCount ?? s.count ?? s.resultsCount ?? null;
            const processed = s.processed ?? s.total ?? s.symbolsProcessed ?? null;
            if (saved != null && processed != null) return `${saved}/${processed} 분석`;
            if (processed != null) return `${processed} 처리`;
            if (saved != null) return `${saved} 저장`;
        }

        if (cronType === 'reconcile') {
            const parts: string[] = [];
            const processed = s.processed ?? s.ordersChecked ?? null;
            if (processed != null) parts.push(`처리 ${processed}`);
            const alerts =
                (typeof s.consistencyAlerts === 'number' ? s.consistencyAlerts : 0) +
                (typeof s.holdingsMismatches === 'number' ? s.holdingsMismatches : 0);
            if (alerts > 0) parts.push(`⚠ 이상 ${alerts}`);
            return parts.join(' · ');
        }

        // fallback: up to 3 numeric key:value pairs
        const numericPairs = Object.entries(s)
            .filter(([, v]) => typeof v === 'number')
            .slice(0, 3)
            .map(([k, v]) => `${k}:${v}`);
        return numericPairs.join(' · ');
    } catch {
        return '';
    }
}

function summaryHasAlert(cronType: string, summary: unknown): boolean {
    try {
        if (cronType !== 'reconcile' || summary == null || typeof summary !== 'object')
            return false;
        const s = summary as Record<string, unknown>;
        const alerts =
            (typeof s.consistencyAlerts === 'number' ? s.consistencyAlerts : 0) +
            (typeof s.holdingsMismatches === 'number' ? s.holdingsMismatches : 0);
        return alerts > 0;
    } catch {
        return false;
    }
}

// ─── DecisionsList ────────────────────────────────────────────────────────────

function DecisionsList({ runId }: { runId: string }) {
    const { data, isLoading, error } = useQuery({
        queryKey: ['cron-decisions', runId] as const,
        queryFn: ({ queryKey: [, qRunId], signal }) => api.getCronDecisions(qRunId, signal),
        enabled: Boolean(runId),
    });

    if (isLoading) {
        return (
            <div className="px-4 py-3">
                <div className="flex items-center gap-2 text-xs text-neutral-500">
                    <span className="h-3 w-3 animate-spin rounded-full border border-neutral-600 border-t-neutral-300" />
                    <span>로딩 중...</span>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="px-4 py-2">
                <p className="text-[11px] text-red-400">의사결정 로드 실패</p>
            </div>
        );
    }

    const decisions = data?.decisions ?? [];

    if (decisions.length === 0) {
        return (
            <div className="px-4 py-2.5">
                <p className="text-[11px] text-neutral-600">
                    의사결정 기록 없음 (분석 결과는 분석 탭 참조)
                </p>
            </div>
        );
    }

    return (
        <ul className="divide-y divide-[#262626]">
            {decisions.map((decision: CronDecision) => (
                <li key={decision.id} className="flex flex-col gap-1 px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                        {/* symbol */}
                        <span className="font-mono text-xs font-medium text-[#fafafa]">
                            {decision.symbol ?? '—'}
                        </span>
                        {/* action chip */}
                        <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${actionChipClass(decision.action)}`}
                        >
                            {decision.action}
                        </span>
                        {/* EXEC badge */}
                        {decision.executed ? (
                            <span className="rounded bg-green-500/10 px-1.5 py-0.5 text-[10px] font-medium text-green-400">
                                EXEC
                            </span>
                        ) : (
                            <span className="text-[10px] text-neutral-600">—</span>
                        )}
                        {/* score */}
                        {decision.score != null && (
                            <span className="font-mono text-[10px] text-neutral-400">
                                {decision.score}
                            </span>
                        )}
                    </div>
                    {/* reason */}
                    {decision.reason && (
                        <p className="line-clamp-2 text-[11px] leading-relaxed text-neutral-500">
                            {decision.reason}
                        </p>
                    )}
                </li>
            ))}
        </ul>
    );
}

// ─── RunRow ───────────────────────────────────────────────────────────────────

function RunRow({ run }: { run: CronRun }) {
    const [expanded, setExpanded] = useState(false);
    const summary = parseSummary(run.cronType, run.summary);
    const hasAlert = summaryHasAlert(run.cronType, run.summary);

    return (
        <li
            className={`rounded-lg border border-l-2 border-[#262626] ${statusBorderClass(run.status)} bg-[#141414]`}
        >
            {/* Main row — toggle button */}
            <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="flex min-h-[44px] w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors hover:bg-white/[0.02]"
            >
                <div className="flex flex-wrap items-center gap-2">
                    {/* status dot */}
                    <span
                        className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${statusDotClass(run.status)}`}
                        aria-hidden="true"
                    />
                    {/* time */}
                    <div className="flex flex-col">
                        <span className="font-mono text-xs text-[#fafafa]">
                            {timeAgo(run.startedAt)}
                        </span>
                        <span className="font-mono text-[10px] text-neutral-500">
                            {formatAbsTime(run.startedAt)}
                        </span>
                    </div>
                    {/* type chip */}
                    <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${cronTypeChipClass(run.cronType)}`}
                    >
                        {cronTypeLabel(run.cronType)}
                    </span>
                    {/* outcome */}
                    <span
                        className={`font-mono text-[10px] tracking-wide uppercase ${outcomeTextClass(run.status)}`}
                    >
                        {run.outcome ?? run.status}
                    </span>
                    {/* duration */}
                    <span className="ml-auto font-mono text-xs text-neutral-400">
                        {formatDuration(run.durationMs)}
                    </span>
                </div>
                {/* summary */}
                {summary && (
                    <p
                        className={`text-xs leading-relaxed ${hasAlert ? 'text-red-400' : 'text-neutral-400'}`}
                    >
                        {summary}
                    </p>
                )}
            </button>

            {/* Drill-down */}
            {expanded && (
                <div className="border-t border-[#262626]">
                    <DecisionsList runId={run.runId} />
                </div>
            )}
        </li>
    );
}

// ─── CronRunsPage ─────────────────────────────────────────────────────────────

export function CronRunsPage() {
    const [typeFilter, setTypeFilter] = useState<CronTypeFilter>('all');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [datePreset, setDatePreset] = useState<DatePreset>('7d');

    const { data, isLoading, error } = useQuery({
        queryKey: ['cron-runs', typeFilter, statusFilter, datePreset] as const,
        queryFn: ({ queryKey: [, qType, qStatus, qDatePreset], signal }) => {
            const { from, to } = getDateRange(qDatePreset);
            return api.getCronRuns(
                {
                    type: qType !== 'all' ? qType : undefined,
                    status: qStatus !== 'all' ? qStatus : undefined,
                    from,
                    to,
                },
                signal,
            );
        },
        refetchInterval: 30_000,
    });

    const runs = data?.runs ?? [];

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
                <h1 className="text-lg font-semibold">크론 감사</h1>
                {!isLoading && !error && (
                    <span className="text-xs text-neutral-500">{runs.length}건</span>
                )}
            </div>

            {/* Filter bar */}
            <div className="space-y-2">
                {/* Cron type pills */}
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="크론 유형 필터">
                    {(
                        [
                            ['all', '전체'],
                            ['technical', '기술'],
                            ['news', '뉴스'],
                            ['options', '옵션'],
                            ['fundamental', '펀더멘털'],
                            ['execute', '실행'],
                            ['reconcile', '정합'],
                        ] as const
                    ).map(([value, label]) => (
                        <button
                            key={value}
                            type="button"
                            onClick={() => setTypeFilter(value)}
                            className={`min-h-[44px] rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                                typeFilter === value
                                    ? 'bg-[#262626] text-white active:bg-[#363636]'
                                    : 'text-neutral-400 hover:text-neutral-200 active:bg-[#262626]'
                            }`}
                            aria-pressed={typeFilter === value}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                {/* Status segment + date preset row */}
                <div className="flex flex-wrap items-center gap-3">
                    <div className="flex flex-wrap gap-1.5" role="group" aria-label="상태 필터">
                        {(
                            [
                                ['all', '전체'],
                                ['completed', '완료'],
                                ['skipped', '스킵'],
                                ['error', '에러'],
                                ['running', '실행중'],
                            ] as const
                        ).map(([value, label]) => (
                            <button
                                key={value}
                                type="button"
                                onClick={() => setStatusFilter(value)}
                                className={`min-h-[44px] rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                                    statusFilter === value
                                        ? 'bg-[#262626] text-white active:bg-[#363636]'
                                        : 'text-neutral-400 hover:text-neutral-200 active:bg-[#262626]'
                                }`}
                                aria-pressed={statusFilter === value}
                            >
                                {label}
                            </button>
                        ))}
                    </div>

                    {/* divider */}
                    <span className="h-4 w-px bg-[#262626]" aria-hidden="true" />

                    {/* Date preset */}
                    <div className="flex gap-1.5" role="group" aria-label="기간 필터">
                        {(
                            [
                                ['today', '오늘'],
                                ['7d', '7일'],
                                ['30d', '30일'],
                            ] as const
                        ).map(([value, label]) => (
                            <button
                                key={value}
                                type="button"
                                onClick={() => setDatePreset(value)}
                                className={`min-h-[44px] rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                                    datePreset === value
                                        ? 'bg-[#262626] text-white active:bg-[#363636]'
                                        : 'text-neutral-400 hover:text-neutral-200 active:bg-[#262626]'
                                }`}
                                aria-pressed={datePreset === value}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* Content */}
            {isLoading ? (
                <LoadingSkeleton />
            ) : error ? (
                <ErrorMessage error={error as Error} />
            ) : runs.length === 0 ? (
                <EmptyState message="해당 조건의 크론 실행 기록이 없습니다" />
            ) : (
                <ul className="space-y-2">
                    {runs.map((run) => (
                        <RunRow key={run.id} run={run} />
                    ))}
                </ul>
            )}
        </div>
    );
}
