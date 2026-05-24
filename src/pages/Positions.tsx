import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { EmptyState } from '@/components/EmptyState';
import { ErrorMessage } from '@/components/ErrorMessage';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';

export function PositionsPage() {
    const { data, isLoading, error } = useQuery({
        queryKey: ['positions'],
        queryFn: ({ signal }) => api.getPositions(signal),
    });

    if (isLoading) return <LoadingSkeleton />;
    if (error) return <ErrorMessage error={error as Error} />;
    if (!data || data.length === 0) return <EmptyState message="활성 포지션이 없습니다" />;

    return (
        <div className="space-y-4">
            <h1 className="text-lg font-semibold">포지션</h1>
            <ul className="space-y-2">
                {data.map((position) => {
                    const borderColor =
                        position.side === 'long' ? 'border-l-green-500' : 'border-l-red-500';

                    return (
                        <li
                            key={position.id}
                            className={`rounded-lg border border-l-2 border-[#262626] ${borderColor} bg-[#141414] px-4 py-3`}
                        >
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <span className="text-sm font-semibold">{position.symbol}</span>
                                    <span
                                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                            position.side === 'long'
                                                ? 'bg-green-500/10 text-green-400'
                                                : 'bg-red-500/10 text-red-400'
                                        }`}
                                    >
                                        {position.side === 'long' ? '롱' : '숏'}
                                    </span>
                                </div>
                                <div className="text-right">
                                    <span className="text-xs text-neutral-400">평가손익</span>
                                    <p className="font-mono text-sm font-medium text-green-400">
                                        +0.00%
                                    </p>
                                </div>
                            </div>
                            <div className="mt-2 flex items-center gap-4 text-xs text-neutral-400">
                                <span>
                                    수량{' '}
                                    <span className="font-mono text-[#fafafa]">
                                        {position.quantity}
                                    </span>
                                </span>
                                <span>
                                    평균가{' '}
                                    <span className="font-mono text-[#fafafa]">
                                        ${position.avgPrice}
                                    </span>
                                </span>
                                <span>
                                    진입{' '}
                                    <span className="text-[#fafafa]">
                                        {timeAgo(position.openedAt)}
                                    </span>
                                </span>
                            </div>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
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
