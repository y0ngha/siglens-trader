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

const ANALYSIS_CRON_TYPES = ['technical', 'news', 'options', 'fundamental'] as const;

function isAnalysisCronType(cronType: string): boolean {
    return ANALYSIS_CRON_TYPES.includes(cronType as (typeof ANALYSIS_CRON_TYPES)[number]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}

type ScoreComponents = {
    /** 컨플루언스·의회는 이 축이 생기기 전 레코드에 없다 → 없으면 그 항목만 빠진다. */
    confluence: number | null;
    technical: number;
    news: number;
    options: number;
    fundamental: number;
    congress: number | null;
};

const COMPONENT_KEYS = ['technical', 'news', 'options', 'fundamental'] as const;

/** Safely read `detail.components` from an untyped decision detail blob. */
function readScoreComponents(detail: unknown): ScoreComponents | null {
    if (!isRecord(detail) || !isRecord(detail.components)) return null;
    const c = detail.components;
    if (!COMPONENT_KEYS.every((k) => typeof c[k] === 'number')) return null;
    return {
        // 구 레코드에는 이 두 키가 없다. 필수로 올리면 과거 결정이 전부 raw JSON 폴백으로
        // 떨어지므로, 있을 때만 렌더한다.
        confluence: typeof c.confluence === 'number' ? c.confluence : null,
        technical: c.technical as number,
        news: c.news as number,
        options: c.options as number,
        fundamental: c.fundamental as number,
        congress: typeof c.congress === 'number' ? c.congress : null,
    };
}

type GateInfo = {
    source: string;
    fraction: number;
    limitedBy: string | null;
    reason: string | null;
};

/** Safely read `detail.gate` (AI trade-gate audit block) from an untyped decision detail blob. */
function readGateDetail(detail: unknown): GateInfo | null {
    if (!isRecord(detail) || !isRecord(detail.gate)) return null;
    const g = detail.gate;
    if (typeof g.source !== 'string' || typeof g.fraction !== 'number') return null;
    return {
        source: g.source,
        fraction: g.fraction,
        limitedBy: typeof g.limitedBy === 'string' ? g.limitedBy : null,
        reason: typeof g.reason === 'string' ? g.reason : null,
    };
}

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

// `execute` outcomes where a **risk** circuit breaker tripped but the run still finished normally
// (exit-only mode — see api/cron/execute.ts risk-breaker docs). `cron_runs.status` for these
// is 'completed', same as a routine run, so color must be decided from `outcome`, not `status`
// alone, or a breaker trip reads as a normal green completion.
//
// `outside_entry_window`도 'completed'와 짝을 이룬다(창 밖이어도 보유 포지션이 있으면 실행이
// 완주한다). 그래도 이 Set에는 **넣지 않는다** — 진입 시간 창은 리스크 사건이 아니라 정상
// 운영 상태이고, 기본 창 기준으로 포지션을 들고 있으면 매 거래일 반복해서 발생한다. 그걸
// 주황 warning으로 칠하면 진짜 손실 한도 트립이 같은 색에 묻힌다.
// 나머지 outcome(market_status_unavailable, us_market_holiday, trading_disabled,
// empty_watchlist, disabled, queue_empty, …)은 status 'skipped'하고만 짝을 이루고, 그건 이미
// 초록이 아니라 중립으로 렌더된다.
const RISK_OUTCOMES = new Set(['daily_loss_limit', 'daily_trade_limit']);

/** Effective visual state for a run — 'warning' overrides a misleadingly-green 'completed'. */
function runVisualState(run: CronRun): string {
    if (run.status === 'completed' && run.outcome != null && RISK_OUTCOMES.has(run.outcome)) {
        return 'warning';
    }
    return run.status;
}

function statusBorderClass(state: string): string {
    switch (state) {
        case 'completed':
            return 'border-l-green-500';
        case 'error':
            return 'border-l-red-500';
        case 'warning':
            return 'border-l-orange-500';
        case 'running':
            return 'border-l-amber-500';
        default:
            return 'border-l-neutral-600';
    }
}

function statusDotClass(state: string): string {
    switch (state) {
        case 'completed':
            return 'bg-green-500';
        case 'error':
            return 'bg-red-500';
        case 'warning':
            return 'bg-orange-500';
        case 'running':
            return 'bg-amber-500 animate-pulse';
        default:
            return 'bg-neutral-600';
    }
}

function outcomeTextClass(state: string): string {
    switch (state) {
        case 'completed':
            return 'text-green-400';
        case 'error':
            return 'text-red-400';
        case 'warning':
            return 'text-orange-400';
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
        case 'gate_error':
            return 'bg-red-500/10 text-red-400';
        case 'gate_skipped_deadline':
        case 'entry_blocked':
            return 'bg-orange-500/10 text-orange-400';
        case 'entry_deferred':
        case 'exit_deferred':
            return 'bg-yellow-500/10 text-yellow-400';
        default:
            return 'bg-neutral-700 text-neutral-400';
    }
}

// ─── summary parsing ──────────────────────────────────────────────────────────

/** 진입이 리스크 차단기가 아니라 시간 창 때문에 막혔는가. */
function isWindowBlock(entriesBlockedBy: unknown): boolean {
    return entriesBlockedBy === 'outside_entry_window';
}

function breakerLabel(outcome: unknown): string {
    if (outcome === 'daily_loss_limit') return '일일 손실 한도';
    if (outcome === 'daily_trade_limit') return '일일 체결 한도';
    // 한글 UI에 영문 snake_case가 그대로 노출되면 운영자가 원인을 읽지 못한다. 창은 리스크
    // 차단기가 아니라 정상 운영 상태이므로 '한도'가 아닌 중립적인 문구를 쓴다.
    if (outcome === 'outside_entry_window') return '진입 시간 창 밖';
    return typeof outcome === 'string' ? outcome : '알 수 없음';
}

function parseSummary(cronType: string, summary: unknown): string {
    try {
        if (!isRecord(summary)) return '';
        const s = summary;

        if (cronType === 'execute') {
            const parts: string[] = [];
            if (s.exitOnly === true) {
                const forced = s.exitsForcedFull === true ? ' · 전량청산' : '';
                // ⚠는 회로차단기 발동 전용이다. 창 밖 진입 차단은 정상 상태라 붙이지 않는다.
                const mark = isWindowBlock(s.entriesBlockedBy) ? '' : '⚠ ';
                parts.push(`${mark}청산전용 (${breakerLabel(s.entriesBlockedBy)})${forced}`);
            }
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

        if (isAnalysisCronType(cronType)) {
            if (isRecord(s.byStatus)) {
                const status = s.byStatus as Record<string, unknown>;
                const done = typeof status.done === 'number' ? status.done : 0;
                const cached = typeof status.cached === 'number' ? status.cached : 0;
                const skipped = typeof status.skipped === 'number' ? status.skipped : 0;
                const error = typeof status.error === 'number' ? status.error : 0;
                return `done ${done} · cached ${cached} · skipped ${skipped} · error ${error}`;
            }
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
        if (!isRecord(summary)) return false;
        const s = summary;
        if (isAnalysisCronType(cronType) && isRecord(s.byStatus)) {
            return typeof s.byStatus.error === 'number' && s.byStatus.error > 0;
        }
        if (cronType === 'execute') {
            // 청산전용 자체가 경보는 아니다. 리스크 차단기(일일 손실/체결 한도)로 막힌 실행만
            // 빨간 요약으로 남긴다 — 진입 시간 창은 정상 운영 상태이고 기본 창 기준 매 거래일
            // 반복 발생하므로, 그것까지 경보 색으로 칠하면 진짜 한도 트립이 묻힌다.
            return s.exitOnly === true && !isWindowBlock(s.entriesBlockedBy);
        }
        if (cronType !== 'reconcile') return false;
        const alerts =
            (typeof s.consistencyAlerts === 'number' ? s.consistencyAlerts : 0) +
            (typeof s.holdingsMismatches === 'number' ? s.holdingsMismatches : 0) +
            (typeof s.brokerPollFailures === 'number' ? s.brokerPollFailures : 0) +
            (typeof s.holdingsCheckFailed === 'number' ? s.holdingsCheckFailed : 0);
        return alerts > 0;
    } catch {
        return false;
    }
}

function analysisResults(summary: unknown) {
    if (!isRecord(summary) || !Array.isArray(summary.results)) return [];
    return summary.results.filter(isRecord).map((item) => ({
        symbol: typeof item.symbol === 'string' ? item.symbol : '—',
        status: typeof item.status === 'string' ? item.status : 'unknown',
        error: typeof item.error === 'string' ? item.error : undefined,
    }));
}

function AnalysisSummaryDetails({ summary }: { summary: unknown }) {
    const results = analysisResults(summary);
    if (results.length === 0) return null;

    return (
        <div className="border-b border-[#262626] px-4 py-2.5">
            <ul className="space-y-1.5">
                {results.map((result) => (
                    <li key={`${result.symbol}-${result.status}`} className="text-[11px]">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs text-[#fafafa]">
                                {result.symbol}
                            </span>
                            <span
                                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${actionChipClass(result.status)}`}
                            >
                                {result.status}
                            </span>
                        </div>
                        {result.error && (
                            <p className="mt-0.5 line-clamp-2 text-neutral-500">{result.error}</p>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
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
                    {(() => {
                        const components = readScoreComponents(decision.detail);
                        const gate = readGateDetail(decision.detail);
                        if (components || gate) {
                            return (
                                <>
                                    {components && (
                                        <span className="font-mono text-[10px] leading-relaxed text-neutral-500">
                                            {/* 가중치 순 — 컨플루언스(12)가 가장 큰 축이다. */}
                                            {components.confluence !== null &&
                                                `컨플루언스 ${components.confluence} · `}
                                            기술 {components.technical} · 뉴스 {components.news} ·
                                            옵션 {components.options} · 펀더멘털{' '}
                                            {components.fundamental}
                                            {components.congress !== null &&
                                                ` · 의회 ${components.congress}`}
                                        </span>
                                    )}
                                    {gate && (
                                        <div className="space-y-0.5">
                                            <span className="font-mono text-[10px] leading-relaxed text-neutral-500">
                                                게이트 {gate.source} · fraction{' '}
                                                {gate.fraction.toFixed(2)}
                                                {gate.limitedBy && ` · 한도 ${gate.limitedBy}`}
                                            </span>
                                            {gate.reason && (
                                                <p className="line-clamp-2 text-[10px] leading-relaxed text-neutral-500">
                                                    {gate.reason}
                                                </p>
                                            )}
                                        </div>
                                    )}
                                </>
                            );
                        }
                        if (decision.detail != null) {
                            return (
                                <pre className="max-h-28 overflow-auto rounded border border-[#262626] bg-[#0a0a0a] p-2 text-[10px] leading-relaxed text-neutral-500">
                                    {JSON.stringify(decision.detail, null, 2)}
                                </pre>
                            );
                        }
                        return null;
                    })()}
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
    const visualState = runVisualState(run);

    return (
        <li
            className={`rounded-lg border border-l-2 border-[#262626] ${statusBorderClass(visualState)} bg-[#141414]`}
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
                        className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${statusDotClass(visualState)}`}
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
                        className={`font-mono text-[10px] tracking-wide uppercase ${outcomeTextClass(visualState)}`}
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
                    {isAnalysisCronType(run.cronType) && (
                        <AnalysisSummaryDetails summary={run.summary} />
                    )}
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
