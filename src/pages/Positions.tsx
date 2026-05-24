import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Badge } from '@/components/Badge';
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
            <ul className="space-y-3">
                {data.map((position) => (
                    <li
                        key={position.id}
                        className="rounded-lg border border-[#262626] bg-[#141414] p-4"
                    >
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold">{position.symbol}</span>
                                <Badge
                                    label={position.side === 'long' ? '롱' : '숏'}
                                    variant={position.side === 'long' ? 'green' : 'red'}
                                />
                            </div>
                            <Badge label={position.status} variant="neutral" />
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-neutral-400 sm:grid-cols-3">
                            <div>
                                <span className="block">수량</span>
                                <span className="text-sm text-[#fafafa]">{position.quantity}</span>
                            </div>
                            <div>
                                <span className="block">평균 단가</span>
                                <span className="text-sm text-[#fafafa]">${position.avgPrice}</span>
                            </div>
                            <div>
                                <span className="block">진입 시각</span>
                                <span className="text-sm text-[#fafafa]">
                                    {new Date(position.openedAt).toLocaleString('ko-KR')}
                                </span>
                            </div>
                        </div>
                    </li>
                ))}
            </ul>
        </div>
    );
}
