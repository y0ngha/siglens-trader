import { useState } from 'react';
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
    id: number;
    symbol: string;
    companyName: string;
    enabled: boolean;
    createdAt: string;
}

interface AnalysisConfig {
    id: number;
    analysisType: string;
    enabled: boolean;
    modelId: string;
    useByok: boolean;
    updatedAt: string;
}

interface NotificationConfig {
    id: number;
    channel: string;
    enabled: boolean;
    target: string;
    events: string[];
}

interface ConfigEntry {
    key: string;
    value: unknown;
    updatedAt: string;
}

interface ConfigData {
    config: ConfigEntry[];
    watchlist: WatchlistItem[];
    analysis: AnalysisConfig[];
    notification: NotificationConfig[];
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

function getConfigValue(config: ConfigEntry[], key: string, fallback: unknown): unknown {
    const entry = config.find((c) => c.key === key);
    return entry ? entry.value : fallback;
}

export function SettingsPage() {
    const queryClient = useQueryClient();
    const { data, isLoading, error } = useQuery({
        queryKey: ['config'],
        queryFn: ({ signal }) => api.getConfig(signal) as Promise<ConfigData>,
    });

    const updateMutation = useMutation({
        mutationFn: (body: unknown) => api.updateConfig(body),
        onSettled: () => queryClient.invalidateQueries({ queryKey: ['config'] }),
    });

    const [newSymbol, setNewSymbol] = useState('');
    const [newName, setNewName] = useState('');
    const [saveMessage, setSaveMessage] = useState<string | null>(null);

    // Local state for risk inputs (to allow typing without immediate API calls)
    const [riskOverrides, setRiskOverrides] = useState<Record<string, string>>({});

    if (isLoading) return <LoadingSkeleton />;
    if (error) return <ErrorMessage error={error as Error} />;
    if (!data) return null;

    const configData = data;
    const tradingMode = getConfigValue(configData.config, 'trading_mode', 'DRY_RUN') as string;

    const riskDefaults: Record<string, number> = {
        max_position_size: 5000,
        max_total_exposure: 25000,
        stop_loss_percent: 5,
        take_profit_percent: 10,
        buy_threshold: 0.7,
        sell_threshold: -0.7,
    };

    function getRiskValue(key: string): string {
        if (riskOverrides[key] !== undefined) return riskOverrides[key];
        const val = getConfigValue(configData.config, key, riskDefaults[key]);
        return String(val);
    }

    function mutate(body: unknown, opts?: { showMessage?: boolean }) {
        const showMessage = opts?.showMessage ?? true;
        if (showMessage) setSaveMessage(null);
        updateMutation.mutate(body, {
            onSuccess: () => {
                if (showMessage) setSaveMessage('저장되었습니다');
            },
            onError: (err) => {
                if (showMessage) setSaveMessage(`오류: ${(err as Error).message}`);
            },
        });
    }

    function handleAddSymbol() {
        const symbol = newSymbol.trim().toUpperCase();
        const name = newName.trim();
        if (!symbol) return;
        if (configData.watchlist.some((w) => w.symbol === symbol)) {
            setSaveMessage('이미 등록된 종목입니다');
            return;
        }
        mutate({ type: 'watchlist', action: 'add', symbol, companyName: name || symbol });
        setNewSymbol('');
        setNewName('');
    }

    function handleRemoveSymbol(id: number) {
        mutate({ type: 'watchlist', action: 'remove', id });
    }

    function handleToggleSymbol(id: number, currentEnabled: boolean) {
        mutate({ type: 'watchlist', action: 'toggle', id, enabled: !currentEnabled });
    }

    function handleAnalysisChange(analysisType: string, updates: object) {
        mutate({ type: 'analysis', analysisType, updates });
    }

    function handleNotificationChange(channel: string, updates: object) {
        mutate({ type: 'notification', channel, updates });
    }

    function handleRiskBlur(key: string) {
        const val = riskOverrides[key];
        if (val === undefined) return;
        mutate({ type: 'config', key, value: Number(val) });
        setRiskOverrides((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
        });
    }

    // Find email notification config
    const emailNotification = configData.notification.find((n) => n.channel === 'email');
    const emailEnabled = emailNotification?.enabled ?? false;
    const emailEvents = emailNotification?.events ?? [];

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
                        value={tradingMode}
                        onChange={(e) => {
                            mutate({ type: 'config', key: 'trading_mode', value: e.target.value });
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
                    {configData.watchlist.map((item) => (
                        <li key={item.id} className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() => handleToggleSymbol(item.id, item.enabled)}
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
                                {item.companyName && item.companyName !== item.symbol && (
                                    <span className="text-xs text-neutral-500">
                                        {item.companyName}
                                    </span>
                                )}
                            </div>
                            <button
                                type="button"
                                onClick={() => handleRemoveSymbol(item.id)}
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
                    {(configData.analysis.length > 0
                        ? configData.analysis
                        : ANALYSIS_TYPES.map((t) => ({
                              id: 0,
                              analysisType: t,
                              enabled: true,
                              modelId: MODELS[0],
                              useByok: false,
                              updatedAt: '',
                          }))
                    ).map((ac) => (
                        <li
                            key={ac.analysisType}
                            className="rounded border border-[#262626] bg-[#0a0a0a] p-3"
                        >
                            <div className="flex items-center justify-between">
                                <span className="text-sm">{typeLabel(ac.analysisType)}</span>
                                <button
                                    type="button"
                                    onClick={() =>
                                        handleAnalysisChange(ac.analysisType, {
                                            enabled: !ac.enabled,
                                        })
                                    }
                                    className={`min-h-[44px] min-w-[44px] rounded border px-2 py-1 text-xs ${
                                        ac.enabled
                                            ? 'border-green-500/30 bg-green-500/10 text-green-400'
                                            : 'border-[#262626] text-neutral-500'
                                    }`}
                                    aria-label={`${typeLabel(ac.analysisType)} ${ac.enabled ? '비활성화' : '활성화'}`}
                                >
                                    {ac.enabled ? 'ON' : 'OFF'}
                                </button>
                            </div>
                            <div className="mt-2 flex items-center gap-2">
                                <select
                                    className="flex-1 rounded-lg border border-[#262626] bg-[#141414] px-3 py-2 text-sm outline-none focus:border-neutral-500"
                                    value={ac.modelId}
                                    onChange={(e) =>
                                        handleAnalysisChange(ac.analysisType, {
                                            modelId: e.target.value,
                                        })
                                    }
                                >
                                    {MODELS.map((m) => (
                                        <option key={m} value={m}>
                                            {m}
                                        </option>
                                    ))}
                                </select>
                                <button
                                    type="button"
                                    onClick={() =>
                                        handleAnalysisChange(ac.analysisType, {
                                            useByok: !ac.useByok,
                                        })
                                    }
                                    className={`min-h-[44px] rounded border px-2 py-1 text-xs ${
                                        ac.useByok
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
                    {(
                        [
                            ['max_position_size', '최대 포지션 크기 ($)'],
                            ['max_total_exposure', '최대 총 노출 ($)'],
                            ['stop_loss_percent', '손절 (%)'],
                            ['take_profit_percent', '익절 (%)'],
                            ['buy_threshold', '매수 임계값'],
                            ['sell_threshold', '매도 임계값'],
                        ] as const
                    ).map(([key, label]) => (
                        <div key={key}>
                            <label className="text-xs text-neutral-400">{label}</label>
                            <input
                                type="number"
                                className="mt-1 w-full rounded-lg border border-[#262626] bg-[#0a0a0a] px-3 py-2 text-sm outline-none focus:border-neutral-500"
                                value={getRiskValue(key)}
                                onChange={(e) =>
                                    setRiskOverrides((prev) => ({
                                        ...prev,
                                        [key]: e.target.value,
                                    }))
                                }
                                onBlur={() => handleRiskBlur(key)}
                            />
                        </div>
                    ))}
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
                            onClick={() =>
                                handleNotificationChange('email', { enabled: !emailEnabled })
                            }
                            className={`min-h-[44px] min-w-[44px] rounded border px-2 py-1 text-xs ${
                                emailEnabled
                                    ? 'border-green-500/30 bg-green-500/10 text-green-400'
                                    : 'border-[#262626] text-neutral-500'
                            }`}
                        >
                            {emailEnabled ? 'ON' : 'OFF'}
                        </button>
                    </div>
                    <div className="mt-3 space-y-2">
                        {NOTIFICATION_EVENTS.map((event) => (
                            <label key={event.key} className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    className="h-4 w-4 rounded border-[#262626] bg-[#0a0a0a]"
                                    checked={emailEvents.includes(event.key)}
                                    onChange={(e) => {
                                        const events = e.target.checked
                                            ? [...emailEvents, event.key]
                                            : emailEvents.filter((ev) => ev !== event.key);
                                        handleNotificationChange('email', { events });
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
