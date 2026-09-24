import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Badge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { ErrorMessage } from '@/components/ErrorMessage';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';

interface AnalysisEntry {
    id: number;
    symbol: string;
    analysisType: string;
    result: unknown;
    createdAt: string;
    analyzedAt?: string | null;
    sourceAnalyzedAt?: string | null;
}

// 분석은 이제 신호가 난 날 하루 한 번만 생긴다(§1, §6) — execute 틱마다 갱신되던 시절의
// 타임프레임별 신선도 게이트는 더 이상 의미가 없다. 모든 타입에 24시간 하나로 통일한다.
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

function typeLabel(type: string): string {
    switch (type) {
        case 'technical':
            return '기술적 (일봉)';
        case 'news':
            return '뉴스';
        case 'fundamental':
            return '펀더멘털';
        default:
            // 구 타입(options·congress·trade_gate 등)은 원문 그대로 보여준다.
            return type;
    }
}

function signalVariant(signal: string): 'green' | 'red' | 'neutral' {
    if (signal === 'bullish') return 'green';
    if (signal === 'bearish') return 'red';
    return 'neutral';
}

function signalLabel(signal: string): string {
    switch (signal) {
        case 'bullish':
            return '강세';
        case 'bearish':
            return '약세';
        case 'neutral':
            return '중립';
        default:
            return signal;
    }
}

function extractSignal(result: unknown): string {
    try {
        const parsed = typeof result === 'string' ? JSON.parse(result) : result;
        if (!parsed || typeof parsed !== 'object') return 'neutral';
        const obj = parsed as Record<string, unknown>;
        const signal = obj.trend ?? obj.overallSentiment ?? obj.signal;
        return typeof signal === 'string' ? signal : 'neutral';
    } catch {
        return 'neutral';
    }
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

function getReferenceDate(entry: AnalysisEntry): string {
    return entry.sourceAnalyzedAt ?? entry.analyzedAt ?? entry.createdAt;
}

function isEntryStale(entry: AnalysisEntry): boolean {
    const age = Date.now() - new Date(getReferenceDate(entry)).getTime();
    return age > STALE_THRESHOLD_MS;
}

function getLatestEntry(entries: AnalysisEntry[]): AnalysisEntry {
    return entries.reduce((latest, entry) =>
        new Date(getReferenceDate(entry)).getTime() > new Date(getReferenceDate(latest)).getTime()
            ? entry
            : latest,
    );
}

export function AnalysisPage() {
    const { data, isLoading, error } = useQuery({
        queryKey: ['analysis'],
        queryFn: ({ signal }) => api.getAnalysis(undefined, signal) as Promise<AnalysisEntry[]>,
    });

    if (isLoading) return <LoadingSkeleton />;
    if (error) return <ErrorMessage error={error as Error} />;
    if (!data || !Array.isArray(data) || data.length === 0)
        return <EmptyState message="분석 결과가 없습니다" />;

    const grouped = data.reduce<Record<string, AnalysisEntry[]>>((acc, entry) => {
        if (!acc[entry.symbol]) acc[entry.symbol] = [];
        acc[entry.symbol].push(entry);
        return acc;
    }, {});

    return (
        <div className="space-y-4">
            <h1 className="text-lg font-semibold">분석 결과</h1>
            <ul className="space-y-3">
                {Object.entries(grouped).map(([symbol, entries]) => {
                    const stale = isEntryStale(getLatestEntry(entries));

                    return (
                        <li
                            key={symbol}
                            className={`rounded-lg border bg-[#141414] p-4 ${stale ? 'border-yellow-500/30' : 'border-[#262626]'}`}
                        >
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <h2 className="text-sm font-semibold">{symbol}</h2>
                                    {stale && (
                                        <span className="rounded bg-yellow-500/10 px-1.5 py-0.5 text-[10px] font-medium text-yellow-400">
                                            오래됨
                                        </span>
                                    )}
                                </div>
                            </div>
                            <ul className="mt-2 space-y-1.5">
                                {entries.map((entry) => {
                                    const signal = extractSignal(entry.result);
                                    const referenceDate = getReferenceDate(entry);
                                    return (
                                        <li
                                            key={entry.id}
                                            className="flex items-center justify-between text-xs"
                                        >
                                            <div className="flex items-center gap-2">
                                                <span className="text-neutral-400">
                                                    {typeLabel(entry.analysisType)}
                                                </span>
                                                <Badge
                                                    label={signalLabel(signal)}
                                                    variant={signalVariant(signal)}
                                                />
                                            </div>
                                            <span
                                                className={`${isEntryStale(entry) ? 'text-yellow-500' : 'text-neutral-500'}`}
                                            >
                                                {timeAgo(referenceDate)}
                                            </span>
                                        </li>
                                    );
                                })}
                            </ul>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
