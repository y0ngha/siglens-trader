import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Badge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { ErrorMessage } from '@/components/ErrorMessage';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';

function modeBadgeLabel(mode: string): string {
    switch (mode) {
        case 'paper':
            return '모의';
        case 'semi-auto':
            return '반자동';
        case 'auto':
            return '자동';
        default:
            return mode;
    }
}

export function TradesPage() {
    const { data, isLoading, error } = useQuery({
        queryKey: ['trades'],
        queryFn: ({ signal }) => api.getTrades(signal),
    });

    if (isLoading) return <LoadingSkeleton />;
    if (error) return <ErrorMessage error={error as Error} />;
    if (!data || data.length === 0) return <EmptyState message="거래 내역이 없습니다" />;

    return (
        <div className="space-y-4">
            <h1 className="text-lg font-semibold">거래 내역</h1>
            <ul className="space-y-3">
                {data.map((trade) => (
                    <li
                        key={trade.id}
                        className="rounded-lg border border-[#262626] bg-[#141414] p-4"
                    >
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold">{trade.symbol}</span>
                                <Badge
                                    label={trade.side === 'buy' ? '매수' : '매도'}
                                    variant={trade.side === 'buy' ? 'green' : 'red'}
                                />
                            </div>
                            <Badge label={modeBadgeLabel(trade.mode)} variant="neutral" />
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-neutral-400 sm:grid-cols-4">
                            <div>
                                <span className="block">수량</span>
                                <span className="text-sm text-[#fafafa]">{trade.quantity}</span>
                            </div>
                            <div>
                                <span className="block">가격</span>
                                <span className="text-sm text-[#fafafa]">${trade.price}</span>
                            </div>
                            <div>
                                <span className="block">시각</span>
                                <span className="text-sm text-[#fafafa]">
                                    {new Date(trade.executedAt).toLocaleString('ko-KR')}
                                </span>
                            </div>
                            <div>
                                <span className="block">유형</span>
                                <span className="text-sm text-[#fafafa]">{trade.orderType}</span>
                            </div>
                        </div>
                        {trade.reason && (
                            <p className="mt-2 text-xs text-neutral-400">{trade.reason}</p>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}
