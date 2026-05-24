import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Position } from '@/lib/api';
import { ErrorMessage } from '@/components/ErrorMessage';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';

const MAX_RECENT_TRADES = 10;

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

function formatUsd(value: number): string {
    return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function computePortfolio(positions: Position[]) {
    const totalInvested = positions.reduce((sum, p) => sum + Number(p.avgPrice) * p.quantity, 0);
    const currentValue = positions.reduce(
        (sum, p) => sum + Number(p.currentPrice ?? p.avgPrice) * p.quantity,
        0,
    );
    const pnlPercent =
        totalInvested > 0 ? ((currentValue - totalInvested) / totalInvested) * 100 : 0;

    return { totalInvested, currentValue, pnlPercent };
}

export function StatusPage() {
    const { data, isLoading, error } = useQuery({
        queryKey: ['status'],
        queryFn: ({ signal }) => api.getStatus(signal),
        refetchInterval: 30_000,
    });

    const { data: positions } = useQuery({
        queryKey: ['positions'],
        queryFn: ({ signal }) => api.getPositions(signal),
    });

    const { data: trades } = useQuery({
        queryKey: ['trades'],
        queryFn: ({ signal }) => api.getTrades(signal),
    });

    if (isLoading) return <LoadingSkeleton />;
    if (error) return <ErrorMessage error={error as Error} />;
    if (!data) return null;

    const health = getHealthStatus(data.running, data.todayTrades);
    const openPositions = positions ?? [];
    const { totalInvested, currentValue, pnlPercent } = computePortfolio(openPositions);
    const recentTrades = (trades ?? []).slice(0, MAX_RECENT_TRADES);
    const skippedTrades = (trades ?? []).filter((t) => t.mode === 'skipped');

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

            <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_1fr]">
                {/* Left column: 상태 지표 + 계좌 상태 + 경고 */}
                <div className="space-y-4">
                    {/* 상태 지표 */}
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

                    {/* 계좌 상태 */}
                    <div className="space-y-2">
                        <h2 className="text-xs font-medium text-neutral-500">계좌 상태</h2>
                        <div className="divide-y divide-[#262626] rounded-lg border border-[#262626] bg-[#141414]">
                            <div className="flex items-center justify-between px-4 py-2.5">
                                <span className="text-xs text-neutral-400">보유 종목</span>
                                <div className="flex flex-wrap justify-end gap-1">
                                    {openPositions.length > 0 ? (
                                        openPositions.map((p) => (
                                            <span
                                                key={p.id}
                                                className="inline-flex items-center gap-1 rounded bg-[#262626] px-1.5 py-0.5 text-xs font-medium"
                                            >
                                                {p.symbol}
                                                <span
                                                    className={`text-[10px] ${p.side === 'long' ? 'text-green-400' : 'text-red-400'}`}
                                                >
                                                    {p.side === 'long' ? 'L' : 'S'}
                                                </span>
                                            </span>
                                        ))
                                    ) : (
                                        <span className="text-xs text-neutral-500">없음</span>
                                    )}
                                </div>
                            </div>
                            <div className="flex items-center justify-between px-4 py-2.5">
                                <span className="text-xs text-neutral-400">총 투자 금액</span>
                                <span
                                    className="font-mono text-sm font-medium"
                                    data-testid="total-invested"
                                >
                                    {formatUsd(totalInvested)}
                                </span>
                            </div>
                            <div className="flex items-center justify-between px-4 py-2.5">
                                <span className="text-xs text-neutral-400">현재 평가 금액</span>
                                <span
                                    className="font-mono text-sm font-medium"
                                    data-testid="current-value"
                                >
                                    {formatUsd(currentValue)}
                                </span>
                            </div>
                            <div className="flex items-center justify-between px-4 py-2.5">
                                <span className="text-xs text-neutral-400">평가 수익률</span>
                                <span
                                    className={`font-mono text-sm font-medium ${pnlPercent > 0 ? 'text-green-400' : pnlPercent < 0 ? 'text-red-400' : ''}`}
                                    data-testid="pnl-percent"
                                >
                                    {pnlPercent > 0 ? '+' : ''}
                                    {pnlPercent.toFixed(2)}%
                                </span>
                            </div>
                            <div className="flex items-center justify-between px-4 py-2.5">
                                <span className="text-xs text-neutral-400">보유 현금</span>
                                <span className="font-mono text-sm text-neutral-500">&mdash;</span>
                            </div>
                            <div className="flex items-center justify-between px-4 py-2.5">
                                <span className="text-xs text-neutral-400">총 자산</span>
                                <span
                                    className="font-mono text-sm font-medium"
                                    data-testid="total-assets"
                                >
                                    {formatUsd(currentValue)}
                                </span>
                            </div>
                        </div>
                    </div>

                    {/* 경고: 잔고 부족으로 미실행된 거래 */}
                    {skippedTrades.length > 0 && (
                        <section>
                            <h2 className="text-xs font-medium text-yellow-500">경고</h2>
                            <div className="mt-2 space-y-1.5">
                                {skippedTrades.slice(0, 5).map((trade) => (
                                    <div
                                        key={trade.id}
                                        className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-3 py-2"
                                    >
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs font-medium text-yellow-400">
                                                {trade.symbol}
                                            </span>
                                            <span className="text-[10px] text-yellow-500/70">
                                                잔고 부족
                                            </span>
                                        </div>
                                        <p className="mt-0.5 text-[11px] text-yellow-500/60">
                                            {trade.reason}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}
                </div>

                {/* Right column: 최근 활동 */}
                <div className="space-y-2">
                    <h2 className="text-xs font-medium text-neutral-500">
                        최근 활동
                        {recentTrades.length > 0 && (
                            <span className="ml-1 text-neutral-600">({recentTrades.length})</span>
                        )}
                    </h2>
                    <div className="divide-y divide-[#262626] rounded-lg border border-[#262626] bg-[#141414] md:max-h-[calc(100vh-12rem)] md:overflow-y-auto">
                        {recentTrades.length > 0 ? (
                            recentTrades.map((trade) => (
                                <div
                                    key={trade.id}
                                    className="flex items-center justify-between px-4 py-2.5"
                                >
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
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <span className="font-mono text-sm text-[#fafafa]">
                                            ${trade.price}
                                        </span>
                                        <span className="text-xs text-neutral-500">
                                            {timeAgo(trade.executedAt)}
                                        </span>
                                    </div>
                                </div>
                            ))
                        ) : (
                            <div className="px-4 py-4">
                                <p className="text-xs text-neutral-500">거래 내역 없음</p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
