import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ErrorMessage } from '@/components/ErrorMessage';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';

function modeLabel(mode: string): string {
    switch (mode) {
        case 'paper':
            return '모의투자';
        case 'semi-auto':
            return '반자동';
        case 'auto':
            return '자동';
        case 'dry_run':
            return '모의투자';
        default:
            return mode;
    }
}

/**
 * Overall health is determined by system running state + recent activity.
 * Green = running + traded today, Yellow = running but no trades, Red = stopped.
 */
function getHealthStatus(running: boolean, todayTrades: number) {
    if (!running) return { label: '시스템 정지', color: 'bg-red-500', textColor: 'text-red-400' };
    if (todayTrades === 0)
        return { label: '대기 중', color: 'bg-yellow-500', textColor: 'text-yellow-400' };
    return { label: '정상 운영', color: 'bg-green-500', textColor: 'text-green-400' };
}

export function StatusPage() {
    const { data, isLoading, error } = useQuery({
        queryKey: ['status'],
        queryFn: ({ signal }) => api.getStatus(signal),
        refetchInterval: 30_000,
    });

    const { data: trades } = useQuery({
        queryKey: ['trades'],
        queryFn: ({ signal }) => api.getTrades(signal),
    });

    if (isLoading) return <LoadingSkeleton />;
    if (error) return <ErrorMessage error={error as Error} />;
    if (!data) return null;

    const lastTrade = trades?.[0] ?? null;
    const health = getHealthStatus(data.running, data.todayTrades);

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <h1 className="text-lg font-semibold">시스템 상태</h1>
                <div className="flex items-center gap-2" aria-label="전체 건강 상태">
                    <span className={`inline-block h-2.5 w-2.5 rounded-full ${health.color}`} />
                    <span className={`text-sm font-medium ${health.textColor}`}>
                        {health.label}
                    </span>
                </div>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {/* Left column: status indicators */}
                <div className="space-y-2">
                    <h2 className="text-xs font-medium text-neutral-500">상태 지표</h2>
                    <div className="divide-y divide-[#262626] rounded-lg border border-[#262626] bg-[#141414]">
                        <div className="flex items-center justify-between px-4 py-2.5">
                            <span className="text-xs text-neutral-400">시스템</span>
                            <div className="flex items-center gap-2">
                                <span
                                    className={`inline-block h-2 w-2 rounded-full ${data.running ? 'bg-green-500' : 'bg-red-500'}`}
                                />
                                <span className="text-sm font-medium">
                                    {data.running ? '실행 중' : '정지'}
                                </span>
                            </div>
                        </div>
                        <div className="flex items-center justify-between px-4 py-2.5">
                            <span className="text-xs text-neutral-400">모드</span>
                            <span className="text-sm font-medium">
                                {modeLabel(data.tradingMode)}
                            </span>
                        </div>
                        <div className="flex items-center justify-between px-4 py-2.5">
                            <span className="text-xs text-neutral-400">활성 포지션</span>
                            <span className="font-mono text-sm font-medium">
                                {data.activePositions}
                            </span>
                        </div>
                        <div className="flex items-center justify-between px-4 py-2.5">
                            <span className="text-xs text-neutral-400">오늘 거래</span>
                            <span className="font-mono text-sm font-medium">
                                {data.todayTrades}
                            </span>
                        </div>
                    </div>
                </div>

                {/* Right column: latest activity */}
                <div className="space-y-2">
                    <h2 className="text-xs font-medium text-neutral-500">최근 활동</h2>
                    <div className="divide-y divide-[#262626] rounded-lg border border-[#262626] bg-[#141414]">
                        <div className="px-4 py-2.5">
                            <span className="text-xs text-neutral-400">최근 거래</span>
                            {lastTrade ? (
                                <div className="mt-1 flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-semibold">
                                            {lastTrade.symbol}
                                        </span>
                                        <span
                                            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                                lastTrade.side === 'buy'
                                                    ? 'bg-green-500/10 text-green-400'
                                                    : 'bg-red-500/10 text-red-400'
                                            }`}
                                        >
                                            {lastTrade.side === 'buy' ? '매수' : '매도'}
                                        </span>
                                    </div>
                                    <span className="font-mono text-sm text-[#fafafa]">
                                        ${lastTrade.price}
                                    </span>
                                </div>
                            ) : (
                                <p className="mt-1 text-xs text-neutral-500">거래 내역 없음</p>
                            )}
                        </div>
                        <div className="px-4 py-2.5">
                            <span className="text-xs text-neutral-400">최근 거래 시각</span>
                            <p className="mt-1 text-sm text-[#fafafa]">
                                {lastTrade
                                    ? new Date(lastTrade.executedAt).toLocaleString('ko-KR')
                                    : '-'}
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
