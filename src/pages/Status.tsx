import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Position, Trade } from '@/lib/api';
import { useOptimisticMutation } from '@/lib/useOptimisticMutation';
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

    // Optimistically mark the alert dismissed so it disappears immediately.
    const dismissMutation = useOptimisticMutation<number, Trade[]>({
        mutationFn: (id) => api.dismissAlert(id),
        queryKey: ['trades'],
        updater: (old, id) =>
            old?.map((t) => (t.id === id ? { ...t, dismissedAt: new Date().toISOString() } : t)),
    });

    const { data: positions } = useQuery({
        queryKey: ['positions'],
        queryFn: ({ signal }) => api.getPositions(signal),
    });

    const { data: trades } = useQuery({
        queryKey: ['trades'],
        queryFn: ({ signal }) => api.getTrades(signal),
    });

    const { data: configData } = useQuery({
        queryKey: ['config'],
        queryFn: ({ signal }) => api.getConfig(signal),
    });

    if (isLoading) return <LoadingSkeleton />;
    if (error) return <ErrorMessage error={error as Error} />;
    if (!data) return null;

    const health = getHealthStatus(data.running, data.todayTrades);
    const openPositions = positions ?? [];
    const { totalInvested, currentValue, pnlPercent } = computePortfolio(openPositions);
    const recentTrades = (trades ?? []).slice(0, MAX_RECENT_TRADES);
    const ALERT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
    const skippedTrades = (trades ?? []).filter(
        (t) =>
            t.mode === 'skipped' &&
            !t.dismissedAt &&
            Date.now() - new Date(t.executedAt).getTime() < ALERT_TTL_MS,
    );
    const cashBalance = data.cashBalance;
    const totalAssets = currentValue + (cashBalance ?? 0);

    const configEntries = configData as
        | { config?: { key: string; value: unknown }[]; watchlist?: { symbol: string }[] }
        | undefined;
    const watchlistItems =
        (configEntries?.watchlist as { symbol: string; enabled?: boolean }[] | undefined) ?? [];
    const takeProfitPercent = Number(
        configEntries?.config?.find((c) => c.key === 'take_profit_percent')?.value ?? 5,
    );
    const stopLossPercent = Number(
        configEntries?.config?.find((c) => c.key === 'stop_loss_percent')?.value ?? 3,
    );

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

            {data.tradingEnabled === false && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3">
                    <span className="text-sm font-medium text-red-400">
                        자동매매가 비활성화되었습니다. 설정에서 다시 활성화할 수 있습니다.
                    </span>
                </div>
            )}

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
                                <span className="text-xs text-neutral-400">자동매매</span>
                                <span
                                    className={`text-sm font-medium ${
                                        data.tradingEnabled === false
                                            ? 'text-red-400'
                                            : 'text-green-400'
                                    }`}
                                >
                                    {data.tradingEnabled === false ? 'OFF' : 'ON'}
                                </span>
                            </div>
                            <div className="flex items-center justify-between px-4 py-2.5">
                                <span className="text-xs text-neutral-400">오늘 거래</span>
                                <span className="font-mono text-sm font-medium">
                                    {data.todayTrades}
                                    {data.maxTradesPerDay != null && (
                                        <span className="text-neutral-500">
                                            {' '}
                                            / {data.maxTradesPerDay}
                                        </span>
                                    )}
                                </span>
                            </div>
                            <div className="px-4 py-2.5">
                                <div className="flex items-center justify-between">
                                    <span className="text-xs text-neutral-400">감시 종목</span>
                                    <span className="font-mono text-sm font-medium">
                                        {watchlistItems.length}종목
                                    </span>
                                </div>
                                {watchlistItems.length > 0 && (
                                    <div className="mt-1 flex flex-wrap gap-1">
                                        {watchlistItems.slice(0, 5).map((w) => (
                                            <span
                                                key={w.symbol}
                                                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                                    w.enabled !== false
                                                        ? 'bg-green-500/10 text-green-400'
                                                        : 'bg-red-500/10 text-red-400'
                                                }`}
                                            >
                                                {w.symbol}
                                            </span>
                                        ))}
                                        {watchlistItems.length > 5 && (
                                            <span className="text-[10px] text-neutral-500">
                                                +{watchlistItems.length - 5}개
                                            </span>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* 계좌 상태 */}
                    <div className="space-y-2">
                        <h2 className="text-xs font-medium text-neutral-500">계좌 상태</h2>
                        <div className="divide-y divide-[#262626] rounded-lg border border-[#262626] bg-[#141414]">
                            <div className="px-4 py-2.5">
                                <div className="flex items-center justify-between">
                                    <span className="text-xs text-neutral-400">보유 종목</span>
                                    <span className="font-mono text-sm font-medium">
                                        {openPositions.length}종목
                                    </span>
                                </div>
                                {openPositions.length > 0 && (
                                    <div className="mt-1 flex flex-wrap gap-1">
                                        {openPositions.slice(0, 5).map((p) => {
                                            const cur = Number(p.currentPrice ?? p.avgPrice);
                                            const avg = Number(p.avgPrice);
                                            const profitable = cur >= avg;
                                            return (
                                                <span
                                                    key={p.id}
                                                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                                        profitable
                                                            ? 'bg-green-500/10 text-green-400'
                                                            : 'bg-red-500/10 text-red-400'
                                                    }`}
                                                >
                                                    {p.symbol}
                                                </span>
                                            );
                                        })}
                                        {openPositions.length > 5 && (
                                            <span className="text-[10px] text-neutral-500">
                                                +{openPositions.length - 5}개
                                            </span>
                                        )}
                                    </div>
                                )}
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
                                <span
                                    className="font-mono text-sm font-medium"
                                    data-testid="cash-balance"
                                >
                                    {cashBalance != null ? formatUsd(cashBalance) : '—'}
                                </span>
                            </div>
                            <div className="flex items-center justify-between px-4 py-2.5">
                                <span className="text-xs text-neutral-400">총 자산</span>
                                <span
                                    className="font-mono text-sm font-medium"
                                    data-testid="total-assets"
                                >
                                    {formatUsd(totalAssets)}
                                </span>
                            </div>
                        </div>

                        {/* 포지션별 목표 */}
                        {openPositions.length > 0 && (
                            <div className="space-y-2">
                                <h2 className="text-xs font-medium text-neutral-500">
                                    포지션별 목표
                                </h2>
                                <div className="rounded-lg border border-[#262626] bg-[#141414]">
                                    <table className="w-full text-[11px]">
                                        <thead>
                                            <tr className="border-b border-[#262626] text-neutral-500">
                                                <th className="px-3 py-2 text-left font-medium">
                                                    종목
                                                </th>
                                                <th className="px-3 py-2 text-right font-medium">
                                                    매수가
                                                </th>
                                                <th className="px-3 py-2 text-right font-medium">
                                                    현재가
                                                </th>
                                                <th className="px-3 py-2 text-right font-medium">
                                                    익절
                                                </th>
                                                <th className="px-3 py-2 text-right font-medium">
                                                    손절
                                                </th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-[#262626]">
                                            {openPositions.slice(0, 5).map((p) => {
                                                const avg = Number(p.avgPrice);
                                                const cur = Number(p.currentPrice ?? p.avgPrice);
                                                const tp = avg * (1 + takeProfitPercent / 100);
                                                const sl = avg * (1 - stopLossPercent / 100);
                                                const profitable = cur >= avg;
                                                return (
                                                    <tr key={p.id}>
                                                        <td className="px-3 py-2 font-medium">
                                                            {p.symbol}
                                                        </td>
                                                        <td className="px-3 py-2 text-right font-mono text-neutral-300">
                                                            ${avg.toFixed(2)}
                                                        </td>
                                                        <td
                                                            className={`px-3 py-2 text-right font-mono ${profitable ? 'text-green-400' : 'text-red-400'}`}
                                                        >
                                                            ${cur.toFixed(2)}
                                                        </td>
                                                        <td className="px-3 py-2 text-right font-mono text-green-400">
                                                            ${tp.toFixed(2)}
                                                        </td>
                                                        <td className="px-3 py-2 text-right font-mono text-red-400">
                                                            ${sl.toFixed(2)}
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                    {openPositions.length > 5 && (
                                        <div className="border-t border-[#262626] px-3 py-1.5 text-center text-[10px] text-neutral-500">
                                            +{openPositions.length - 5}개 포지션
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
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
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs font-medium text-yellow-400">
                                                    {trade.symbol}
                                                </span>
                                                <span className="text-[10px] text-yellow-500/70">
                                                    잔고 부족
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className="text-[10px] text-yellow-500/50">
                                                    {timeAgo(trade.executedAt)}
                                                </span>
                                                <button
                                                    type="button"
                                                    onClick={() => dismissMutation.mutate(trade.id)}
                                                    className="rounded px-2 py-0.5 text-[10px] text-yellow-400 hover:bg-yellow-500/10"
                                                >
                                                    확인
                                                </button>
                                            </div>
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
