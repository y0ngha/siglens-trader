import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { EmptyState } from '@/components/EmptyState';
import { ErrorMessage } from '@/components/ErrorMessage';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';

const PAGE_SIZE = 20;

type ModeFilter = 'all' | 'paper' | 'semi-auto' | 'auto';

function modeBadgeLabel(mode: string): string {
    switch (mode) {
        case 'paper':
            return '모의';
        case 'semi-auto':
            return '반자동';
        case 'auto':
            return '자동';
        case 'dry_run':
            return '모의';
        default:
            return mode;
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

export function TradesPage() {
    const [modeFilter, setModeFilter] = useState<ModeFilter>('all');
    const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

    const { data, isLoading, error } = useQuery({
        queryKey: ['trades'],
        queryFn: ({ signal }) => api.getTrades(signal),
    });

    const filteredTrades = useMemo(() => {
        if (!data) return [];
        if (modeFilter === 'all') return data;
        return data.filter((trade) => {
            if (modeFilter === 'paper') return trade.mode === 'paper' || trade.mode === 'dry_run';
            return trade.mode === modeFilter;
        });
    }, [data, modeFilter]);

    const visibleTrades = filteredTrades.slice(0, visibleCount);
    const hasMore = visibleCount < filteredTrades.length;

    if (isLoading) return <LoadingSkeleton />;
    if (error) return <ErrorMessage error={error as Error} />;
    if (!data || data.length === 0) return <EmptyState message="거래 내역이 없습니다" />;

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <h1 className="text-lg font-semibold">거래 내역</h1>
                <span className="text-xs text-neutral-500">{filteredTrades.length}건</span>
            </div>

            {/* Mode filter */}
            <div className="flex gap-1.5" role="group" aria-label="모드 필터">
                {(
                    [
                        ['all', '전체'],
                        ['paper', '모의'],
                        ['semi-auto', '반자동'],
                        ['auto', '자동'],
                    ] as const
                ).map(([value, label]) => (
                    <button
                        key={value}
                        type="button"
                        onClick={() => {
                            setModeFilter(value);
                            setVisibleCount(PAGE_SIZE);
                        }}
                        className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                            modeFilter === value
                                ? 'bg-[#262626] text-white'
                                : 'text-neutral-500 hover:text-neutral-300'
                        }`}
                        aria-pressed={modeFilter === value}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {filteredTrades.length === 0 ? (
                <EmptyState message="해당 모드의 거래가 없습니다" />
            ) : (
                <>
                    <ul className="space-y-2">
                        {visibleTrades.map((trade) => {
                            const borderColor =
                                trade.side === 'buy' ? 'border-l-green-500' : 'border-l-red-500';

                            return (
                                <li
                                    key={trade.id}
                                    className={`rounded-lg border border-l-2 border-[#262626] ${borderColor} bg-[#141414] px-4 py-3`}
                                >
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-semibold">
                                                {trade.symbol}
                                            </span>
                                            <span
                                                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                                    trade.side === 'buy'
                                                        ? 'bg-green-500/10 text-green-400'
                                                        : 'bg-red-500/10 text-red-400'
                                                }`}
                                            >
                                                {trade.side === 'buy' ? '매수' : '매도'}
                                            </span>
                                            <span className="rounded bg-neutral-700 px-1.5 py-0.5 text-[10px] font-medium text-neutral-300">
                                                {modeBadgeLabel(trade.mode)}
                                            </span>
                                        </div>
                                        <span className="text-xs text-neutral-500">
                                            {timeAgo(trade.executedAt)}
                                        </span>
                                    </div>
                                    <div className="mt-2 flex items-center gap-4 text-xs text-neutral-400">
                                        <span>
                                            수량{' '}
                                            <span className="font-mono text-[#fafafa]">
                                                {trade.quantity}
                                            </span>
                                        </span>
                                        <span>
                                            가격{' '}
                                            <span className="font-mono text-[#fafafa]">
                                                ${trade.price}
                                            </span>
                                        </span>
                                        <span>
                                            유형{' '}
                                            <span className="text-[#fafafa]">
                                                {trade.orderType === 'market'
                                                    ? '시장가'
                                                    : trade.orderType === 'limit'
                                                      ? '지정가'
                                                      : trade.orderType}
                                            </span>
                                        </span>
                                    </div>
                                    {trade.reason && (
                                        <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-500">
                                            {trade.reason}
                                        </p>
                                    )}
                                </li>
                            );
                        })}
                    </ul>

                    {hasMore && (
                        <button
                            type="button"
                            onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}
                            className="w-full rounded-lg border border-[#262626] bg-[#141414] py-3 text-sm text-neutral-400 transition-colors hover:text-neutral-200"
                        >
                            더 보기 ({filteredTrades.length - visibleCount}건 남음)
                        </button>
                    )}
                </>
            )}
        </div>
    );
}
