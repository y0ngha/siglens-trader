import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Badge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { ErrorMessage } from '@/components/ErrorMessage';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';

interface AnalysisEntry {
    id: number;
    symbol: string;
    type: string;
    result: string;
    createdAt: string;
}

function typeLabel(type: string): string {
    switch (type) {
        case 'technical':
            return '기술적';
        case 'news':
            return '뉴스';
        case 'options':
            return '옵션';
        case 'fundamental':
            return '펀더멘털';
        default:
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
            return 'Bullish';
        case 'bearish':
            return 'Bearish';
        case 'neutral':
            return 'Neutral';
        default:
            return signal;
    }
}

function extractSignal(result: string): string {
    try {
        const parsed = JSON.parse(result);
        return parsed.signal ?? parsed.direction ?? 'neutral';
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

export function AnalysisPage() {
    const { data, isLoading, error } = useQuery({
        queryKey: ['analysis'],
        queryFn: () => api.getAnalysis() as Promise<AnalysisEntry[]>,
    });

    if (isLoading) return <LoadingSkeleton />;
    if (error) return <ErrorMessage error={error as Error} />;
    if (!data || data.length === 0) return <EmptyState message="분석 결과가 없습니다" />;

    const grouped = data.reduce<Record<string, AnalysisEntry[]>>((acc, entry) => {
        if (!acc[entry.symbol]) acc[entry.symbol] = [];
        acc[entry.symbol].push(entry);
        return acc;
    }, {});

    return (
        <div className="space-y-4">
            <h1 className="text-lg font-semibold">분석 결과</h1>
            <ul className="space-y-3">
                {Object.entries(grouped).map(([symbol, entries]) => (
                    <li
                        key={symbol}
                        className="rounded-lg border border-[#262626] bg-[#141414] p-4"
                    >
                        <h2 className="text-sm font-semibold">{symbol}</h2>
                        <ul className="mt-2 space-y-1.5">
                            {entries.map((entry) => {
                                const signal = extractSignal(entry.result);
                                return (
                                    <li
                                        key={entry.id}
                                        className="flex items-center justify-between text-xs"
                                    >
                                        <div className="flex items-center gap-2">
                                            <span className="text-neutral-400">
                                                {typeLabel(entry.type)}
                                            </span>
                                            <Badge
                                                label={signalLabel(signal)}
                                                variant={signalVariant(signal)}
                                            />
                                        </div>
                                        <span className="text-neutral-500">
                                            {timeAgo(entry.createdAt)}
                                        </span>
                                    </li>
                                );
                            })}
                        </ul>
                    </li>
                ))}
            </ul>
        </div>
    );
}
