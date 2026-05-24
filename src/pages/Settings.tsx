import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ErrorMessage } from '@/components/ErrorMessage';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';

const MODELS = [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'claude-sonnet-4-6',
    'claude-opus-4-7',
    'gpt-5-mini',
    'gpt-5.4',
] as const;

const ANALYSIS_TYPES = ['technical', 'news', 'options', 'fundamental'] as const;

const NOTIFICATION_EVENTS = [
    { key: 'trade_executed', label: '거래 체결' },
    { key: 'order_pending', label: '주문 승인 대기' },
    { key: 'stop_loss', label: '손절 발동' },
    { key: 'error', label: '시스템 오류' },
] as const;

interface WatchlistItem {
    symbol: string;
    name: string;
    enabled: boolean;
}

interface AnalysisConfig {
    type: string;
    enabled: boolean;
    model: string;
    byok: boolean;
}

interface Config {
    tradingMode: string;
    watchlist: WatchlistItem[];
    analysis: AnalysisConfig[];
    risk: {
        maxPositionSize: number;
        maxTotalExposure: number;
        stopLossPercent: number;
        takeProfitPercent: number;
        buyThreshold: number;
        sellThreshold: number;
    };
    notifications: {
        emailEnabled: boolean;
        events: string[];
    };
}

function typeLabel(type: string): string {
    switch (type) {
        case 'technical':
            return '기술적 분석';
        case 'news':
            return '뉴스 분석';
        case 'options':
            return '옵션 분석';
        case 'fundamental':
            return '펀더멘털 분석';
        default:
            return type;
    }
}

export function SettingsPage() {
    const queryClient = useQueryClient();
    const { data, isLoading, error } = useQuery({
        queryKey: ['config'],
        queryFn: () => api.getConfig() as Promise<Config>,
    });

    const updateMutation = useMutation({
        mutationFn: (body: unknown) => api.updateConfig(body),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['config'] }),
    });

    const [config, setConfig] = useState<Config | null>(null);
    const [newSymbol, setNewSymbol] = useState('');
    const [newName, setNewName] = useState('');
    const [saveMessage, setSaveMessage] = useState<string | null>(null);

    useEffect(() => {
        if (data) setConfig(data);
    }, [data]);

    if (isLoading) return <LoadingSkeleton />;
    if (error) return <ErrorMessage error={error as Error} />;
    if (!config) return null;

    function save(type: string, payload: unknown) {
        setSaveMessage(null);
        updateMutation.mutate(
            { type, ...(payload as object) },
            {
                onSuccess: () => setSaveMessage('저장되었습니다'),
                onError: (err) => setSaveMessage(`오류: ${(err as Error).message}`),
            },
        );
    }

    function handleAddSymbol() {
        const symbol = newSymbol.trim().toUpperCase();
        const name = newName.trim();
        if (!symbol) return;
        const updated = [...config!.watchlist, { symbol, name, enabled: true }];
        setConfig({ ...config!, watchlist: updated });
        save('watchlist', { watchlist: updated });
        setNewSymbol('');
        setNewName('');
    }

    function handleRemoveSymbol(symbol: string) {
        const updated = config!.watchlist.filter((w) => w.symbol !== symbol);
        setConfig({ ...config!, watchlist: updated });
        save('watchlist', { watchlist: updated });
    }

    function handleToggleSymbol(symbol: string) {
        const updated = config!.watchlist.map((w) =>
            w.symbol === symbol ? { ...w, enabled: !w.enabled } : w,
        );
        setConfig({ ...config!, watchlist: updated });
        save('watchlist', { watchlist: updated });
    }

    return (
        <div className="space-y-6">
            <h1 className="text-lg font-semibold">설정</h1>

            {saveMessage && (
                <div
                    role="status"
                    className={`rounded-lg p-3 text-sm ${
                        saveMessage.startsWith('오류')
                            ? 'border border-red-500/20 bg-red-500/5 text-red-400'
                            : 'border border-green-500/20 bg-green-500/5 text-green-400'
                    }`}
                >
                    {saveMessage}
                </div>
            )}

            {/* General */}
            <section className="rounded-lg border border-[#262626] bg-[#141414] p-4">
                <h2 className="text-sm font-semibold">일반</h2>
                <div className="mt-3">
                    <label className="text-xs text-neutral-400">트레이딩 모드</label>
                    <select
                        className="mt-1 w-full rounded-lg border border-[#262626] bg-[#0a0a0a] px-3 py-2 text-sm outline-none focus:border-neutral-500"
                        value={config.tradingMode}
                        onChange={(e) => {
                            setConfig({ ...config, tradingMode: e.target.value });
                            save('general', { tradingMode: e.target.value });
                        }}
                    >
                        <option value="DRY_RUN">모의투자 (DRY_RUN)</option>
                        <option value="SEMI_AUTO">반자동 (SEMI_AUTO)</option>
                        <option value="AUTO">자동 (AUTO)</option>
                    </select>
                </div>
            </section>

            {/* Watchlist */}
            <section className="rounded-lg border border-[#262626] bg-[#141414] p-4">
                <h2 className="text-sm font-semibold">감시 종목</h2>
                <ul className="mt-3 space-y-2">
                    {config.watchlist.map((item) => (
                        <li key={item.symbol} className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => handleToggleSymbol(item.symbol)}
                                    className={`min-h-[44px] min-w-[44px] rounded border px-2 py-1 text-xs ${
                                        item.enabled
                                            ? 'border-green-500/30 bg-green-500/10 text-green-400'
                                            : 'border-[#262626] bg-[#0a0a0a] text-neutral-500'
                                    }`}
                                    aria-label={`${item.symbol} ${item.enabled ? '비활성화' : '활성화'}`}
                                >
                                    {item.enabled ? 'ON' : 'OFF'}
                                </button>
                                <span className="text-sm font-medium">{item.symbol}</span>
                                {item.name && (
                                    <span className="text-xs text-neutral-500">{item.name}</span>
                                )}
                            </div>
                            <button
                                type="button"
                                onClick={() => handleRemoveSymbol(item.symbol)}
                                className="min-h-[44px] min-w-[44px] rounded border border-red-500/20 px-2 py-1 text-xs text-red-400 hover:bg-red-500/10"
                                aria-label={`${item.symbol} 삭제`}
                            >
                                삭제
                            </button>
                        </li>
                    ))}
                </ul>
                <div className="mt-3 flex gap-2">
                    <input
                        type="text"
                        placeholder="종목 코드"
                        className="w-24 rounded-lg border border-[#262626] bg-[#0a0a0a] px-3 py-2 text-sm outline-none focus:border-neutral-500"
                        value={newSymbol}
                        onChange={(e) => setNewSymbol(e.target.value)}
                    />
                    <input
                        type="text"
                        placeholder="회사명"
                        className="flex-1 rounded-lg border border-[#262626] bg-[#0a0a0a] px-3 py-2 text-sm outline-none focus:border-neutral-500"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                    />
                    <button
                        type="button"
                        onClick={handleAddSymbol}
                        className="min-h-[44px] rounded-lg bg-neutral-700 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-600"
                    >
                        추가
                    </button>
                </div>
            </section>

            {/* Analysis Config */}
            <section className="rounded-lg border border-[#262626] bg-[#141414] p-4">
                <h2 className="text-sm font-semibold">분석 설정</h2>
                <ul className="mt-3 space-y-3">
                    {(config.analysis.length > 0
                        ? config.analysis
                        : ANALYSIS_TYPES.map((t) => ({
                              type: t,
                              enabled: true,
                              model: MODELS[0],
                              byok: false,
                          }))
                    ).map((ac) => (
                        <li
                            key={ac.type}
                            className="rounded border border-[#262626] bg-[#0a0a0a] p-3"
                        >
                            <div className="flex items-center justify-between">
                                <span className="text-sm">{typeLabel(ac.type)}</span>
                                <button
                                    type="button"
                                    onClick={() => {
                                        const updated = config.analysis.map((a) =>
                                            a.type === ac.type ? { ...a, enabled: !a.enabled } : a,
                                        );
                                        setConfig({ ...config, analysis: updated });
                                        save('analysis', { analysis: updated });
                                    }}
                                    className={`min-h-[44px] min-w-[44px] rounded border px-2 py-1 text-xs ${
                                        ac.enabled
                                            ? 'border-green-500/30 bg-green-500/10 text-green-400'
                                            : 'border-[#262626] text-neutral-500'
                                    }`}
                                    aria-label={`${typeLabel(ac.type)} ${ac.enabled ? '비활성화' : '활성화'}`}
                                >
                                    {ac.enabled ? 'ON' : 'OFF'}
                                </button>
                            </div>
                            <div className="mt-2 flex items-center gap-2">
                                <select
                                    className="flex-1 rounded-lg border border-[#262626] bg-[#141414] px-3 py-2 text-sm outline-none focus:border-neutral-500"
                                    value={ac.model}
                                    onChange={(e) => {
                                        const updated = config.analysis.map((a) =>
                                            a.type === ac.type
                                                ? { ...a, model: e.target.value }
                                                : a,
                                        );
                                        setConfig({ ...config, analysis: updated });
                                        save('analysis', { analysis: updated });
                                    }}
                                >
                                    {MODELS.map((m) => (
                                        <option key={m} value={m}>
                                            {m}
                                        </option>
                                    ))}
                                </select>
                                <button
                                    type="button"
                                    onClick={() => {
                                        const updated = config.analysis.map((a) =>
                                            a.type === ac.type ? { ...a, byok: !a.byok } : a,
                                        );
                                        setConfig({ ...config, analysis: updated });
                                        save('analysis', { analysis: updated });
                                    }}
                                    className={`min-h-[44px] rounded border px-2 py-1 text-xs ${
                                        ac.byok
                                            ? 'border-blue-500/30 bg-blue-500/10 text-blue-400'
                                            : 'border-[#262626] text-neutral-500'
                                    }`}
                                >
                                    BYOK
                                </button>
                            </div>
                        </li>
                    ))}
                </ul>
            </section>

            {/* Risk */}
            <section className="rounded-lg border border-[#262626] bg-[#141414] p-4">
                <h2 className="text-sm font-semibold">리스크 관리</h2>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                        <label className="text-xs text-neutral-400">최대 포지션 크기 ($)</label>
                        <input
                            type="number"
                            className="mt-1 w-full rounded-lg border border-[#262626] bg-[#0a0a0a] px-3 py-2 text-sm outline-none focus:border-neutral-500"
                            value={config.risk.maxPositionSize}
                            onChange={(e) =>
                                setConfig({
                                    ...config,
                                    risk: {
                                        ...config.risk,
                                        maxPositionSize: Number(e.target.value),
                                    },
                                })
                            }
                            onBlur={() => save('risk', { risk: config.risk })}
                        />
                    </div>
                    <div>
                        <label className="text-xs text-neutral-400">최대 총 노출 ($)</label>
                        <input
                            type="number"
                            className="mt-1 w-full rounded-lg border border-[#262626] bg-[#0a0a0a] px-3 py-2 text-sm outline-none focus:border-neutral-500"
                            value={config.risk.maxTotalExposure}
                            onChange={(e) =>
                                setConfig({
                                    ...config,
                                    risk: {
                                        ...config.risk,
                                        maxTotalExposure: Number(e.target.value),
                                    },
                                })
                            }
                            onBlur={() => save('risk', { risk: config.risk })}
                        />
                    </div>
                    <div>
                        <label className="text-xs text-neutral-400">손절 (%)</label>
                        <input
                            type="number"
                            className="mt-1 w-full rounded-lg border border-[#262626] bg-[#0a0a0a] px-3 py-2 text-sm outline-none focus:border-neutral-500"
                            value={config.risk.stopLossPercent}
                            onChange={(e) =>
                                setConfig({
                                    ...config,
                                    risk: {
                                        ...config.risk,
                                        stopLossPercent: Number(e.target.value),
                                    },
                                })
                            }
                            onBlur={() => save('risk', { risk: config.risk })}
                        />
                    </div>
                    <div>
                        <label className="text-xs text-neutral-400">익절 (%)</label>
                        <input
                            type="number"
                            className="mt-1 w-full rounded-lg border border-[#262626] bg-[#0a0a0a] px-3 py-2 text-sm outline-none focus:border-neutral-500"
                            value={config.risk.takeProfitPercent}
                            onChange={(e) =>
                                setConfig({
                                    ...config,
                                    risk: {
                                        ...config.risk,
                                        takeProfitPercent: Number(e.target.value),
                                    },
                                })
                            }
                            onBlur={() => save('risk', { risk: config.risk })}
                        />
                    </div>
                    <div>
                        <label className="text-xs text-neutral-400">매수 임계값</label>
                        <input
                            type="number"
                            className="mt-1 w-full rounded-lg border border-[#262626] bg-[#0a0a0a] px-3 py-2 text-sm outline-none focus:border-neutral-500"
                            value={config.risk.buyThreshold}
                            onChange={(e) =>
                                setConfig({
                                    ...config,
                                    risk: { ...config.risk, buyThreshold: Number(e.target.value) },
                                })
                            }
                            onBlur={() => save('risk', { risk: config.risk })}
                        />
                    </div>
                    <div>
                        <label className="text-xs text-neutral-400">매도 임계값</label>
                        <input
                            type="number"
                            className="mt-1 w-full rounded-lg border border-[#262626] bg-[#0a0a0a] px-3 py-2 text-sm outline-none focus:border-neutral-500"
                            value={config.risk.sellThreshold}
                            onChange={(e) =>
                                setConfig({
                                    ...config,
                                    risk: { ...config.risk, sellThreshold: Number(e.target.value) },
                                })
                            }
                            onBlur={() => save('risk', { risk: config.risk })}
                        />
                    </div>
                </div>
            </section>

            {/* Notifications */}
            <section className="rounded-lg border border-[#262626] bg-[#141414] p-4">
                <h2 className="text-sm font-semibold">알림</h2>
                <div className="mt-3">
                    <div className="flex items-center justify-between">
                        <span className="text-sm">이메일 알림</span>
                        <button
                            type="button"
                            onClick={() => {
                                const updated = {
                                    ...config.notifications,
                                    emailEnabled: !config.notifications.emailEnabled,
                                };
                                setConfig({ ...config, notifications: updated });
                                save('notifications', { notifications: updated });
                            }}
                            className={`min-h-[44px] min-w-[44px] rounded border px-2 py-1 text-xs ${
                                config.notifications.emailEnabled
                                    ? 'border-green-500/30 bg-green-500/10 text-green-400'
                                    : 'border-[#262626] text-neutral-500'
                            }`}
                        >
                            {config.notifications.emailEnabled ? 'ON' : 'OFF'}
                        </button>
                    </div>
                    <div className="mt-3 space-y-2">
                        {NOTIFICATION_EVENTS.map((event) => (
                            <label key={event.key} className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    className="h-4 w-4 rounded border-[#262626] bg-[#0a0a0a]"
                                    checked={config.notifications.events.includes(event.key)}
                                    onChange={(e) => {
                                        const events = e.target.checked
                                            ? [...config.notifications.events, event.key]
                                            : config.notifications.events.filter(
                                                  (ev) => ev !== event.key,
                                              );
                                        const updated = { ...config.notifications, events };
                                        setConfig({ ...config, notifications: updated });
                                        save('notifications', { notifications: updated });
                                    }}
                                />
                                <span className="text-sm">{event.label}</span>
                            </label>
                        ))}
                    </div>
                </div>
            </section>
        </div>
    );
}
