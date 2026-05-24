import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Badge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { ErrorMessage } from '@/components/ErrorMessage';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';

function timeRemaining(expiresAt: string): string {
    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) return '만료됨';
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 60) return `${minutes}분 남음`;
    const hours = Math.floor(minutes / 60);
    return `${hours}시간 ${minutes % 60}분 남음`;
}

export function PendingPage() {
    const queryClient = useQueryClient();
    const {
        data: orders,
        isLoading,
        error,
    } = useQuery({
        queryKey: ['pending'],
        queryFn: api.getPending,
    });

    const approveMutation = useMutation({
        mutationFn: (id: number) => api.approveOrder(id),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['pending'] }),
    });

    const rejectMutation = useMutation({
        mutationFn: (id: number) => api.rejectOrder(id),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['pending'] }),
    });

    if (isLoading) return <LoadingSkeleton />;
    if (error) return <ErrorMessage error={error as Error} />;
    if (!orders || orders.length === 0)
        return <EmptyState message="승인 대기 중인 주문이 없습니다" />;

    return (
        <div className="space-y-4">
            <h1 className="text-lg font-semibold">승인 대기</h1>
            <ul className="space-y-3">
                {orders.map((order) => (
                    <li
                        key={order.id}
                        className="rounded-lg border border-[#262626] bg-[#141414] p-4"
                    >
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold">{order.symbol}</span>
                                <Badge
                                    label={order.side === 'buy' ? '매수' : '매도'}
                                    variant={order.side === 'buy' ? 'green' : 'red'}
                                />
                            </div>
                            <span className="text-xs text-neutral-500">
                                {timeRemaining(order.expiresAt)}
                            </span>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-neutral-400 sm:grid-cols-3">
                            <div>
                                <span className="block">수량</span>
                                <span className="text-sm text-[#fafafa]">{order.quantity}</span>
                            </div>
                            {order.signalScore && (
                                <div>
                                    <span className="block">신호 점수</span>
                                    <span className="text-sm text-[#fafafa]">
                                        {order.signalScore}
                                    </span>
                                </div>
                            )}
                            {order.priceLimit && (
                                <div>
                                    <span className="block">가격 제한</span>
                                    <span className="text-sm text-[#fafafa]">
                                        ${order.priceLimit}
                                    </span>
                                </div>
                            )}
                        </div>
                        {order.analysisSummary && (
                            <p className="mt-2 text-xs text-neutral-400">{order.analysisSummary}</p>
                        )}
                        <div className="mt-3 flex gap-2">
                            <button
                                type="button"
                                onClick={() => approveMutation.mutate(order.id)}
                                disabled={approveMutation.isPending}
                                className="min-h-[44px] flex-1 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-green-500 disabled:opacity-50"
                            >
                                {approveMutation.isPending ? '처리 중...' : '승인'}
                            </button>
                            <button
                                type="button"
                                onClick={() => rejectMutation.mutate(order.id)}
                                disabled={rejectMutation.isPending}
                                className="min-h-[44px] flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
                            >
                                {rejectMutation.isPending ? '처리 중...' : '거부'}
                            </button>
                        </div>
                    </li>
                ))}
            </ul>
        </div>
    );
}
