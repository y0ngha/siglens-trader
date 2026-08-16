import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useOptimisticMutation } from '@/lib/useOptimisticMutation';
import { ErrorMessage } from '@/components/ErrorMessage';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { TickerSearch } from '@/components/TickerSearch';

// 서버의 analysis_timeframe 계약(15Min/30Min/1Hour, 기본 1Hour)을 프런트에서 미러링.
// src/는 lib/(서버 코드)를 import하지 않으므로 클라이언트용 최소 정규화를 둔다.
const ANALYSIS_TIMEFRAMES = ['15Min', '30Min', '1Hour'] as const;
type AnalysisTimeframe = (typeof ANALYSIS_TIMEFRAMES)[number];
const DEFAULT_ANALYSIS_TIMEFRAME: AnalysisTimeframe = '1Hour';
function normalizeAnalysisTimeframe(value: unknown): AnalysisTimeframe {
    return ANALYSIS_TIMEFRAMES.includes(value as AnalysisTimeframe)
        ? (value as AnalysisTimeframe)
        : DEFAULT_ANALYSIS_TIMEFRAME;
}

// lib/strategy/entry-window.ts의 기본 창과 off-switch를 문자열로 다시 적는다.
// src/는 lib/(서버 코드)를 import하지 않는다는 레이어 규칙 때문 — analysis_timeframe과 같은 방식.
const DEFAULT_ENTRY_WINDOW = { start: '11:00', end: '15:00' } as const;
const ENTRY_WINDOW_OFF = { start: '00:00', end: '24:00' } as const;

interface EntryWindowForm {
    start: string;
    end: string;
    enabled: boolean;
}

/**
 * 저장된 entry_window를 폼 상태로 정규화한다.
 *
 * off-switch 값(00:00~24:00)이면 토글을 끈 것으로 보이되 시간 입력에는 기본 창을 채운다 —
 * 다시 켰을 때 빈 칸이 아니라 합리적인 값이 보여야 하기 때문. `<input type="time">`은
 * '24:00'을 표현할 수도 없다.
 */
function readEntryWindow(raw: unknown): EntryWindowForm {
    const v = raw as { start?: unknown; end?: unknown } | null | undefined;
    const start = typeof v?.start === 'string' ? v.start : DEFAULT_ENTRY_WINDOW.start;
    const end = typeof v?.end === 'string' ? v.end : DEFAULT_ENTRY_WINDOW.end;
    if (start === ENTRY_WINDOW_OFF.start && end === ENTRY_WINDOW_OFF.end) {
        return { ...DEFAULT_ENTRY_WINDOW, enabled: false };
    }
    return { start, end, enabled: true };
}

// ET → KST 오프셋. 여름은 EDT(UTC-4), 겨울은 EST(UTC-5), KST는 UTC+9.
// 특정 날짜 없이 Intl/Date로 오프셋을 뽑으려 하면 오히려 틀린 답이 나오므로 순수 산술로 둔다.
const KST_OFFSET_SUMMER = 13;
const KST_OFFSET_WINTER = 14;

/**
 * 'HH:MM'(ET) → KST 시각 + 날짜 넘김 여부. 파싱 불가면 null.
 *
 * 빈 입력('')은 `Number('')`이 0이라 유한 검사를 통과하고 분이 undefined가 되어 '13:undefined'를
 * 렌더했다. 그래서 숫자 변환이 아니라 형식 자체를 검사한다.
 */
function toKst(hhmm: string, offsetHours: number): { time: string; nextDay: boolean } | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
    if (!match) return null;
    const hour = Number(match[1]) + offsetHours;
    return { time: `${String(hour % 24).padStart(2, '0')}:${match[2]}`, nextDay: hour >= 24 };
}

/**
 * ET 창 하나를 KST 문구로. ET 오후는 KST 익일이 되므로 넘어가는 쪽에 '익일'을 붙인다 —
 * 표기가 없으면 운영자가 24시간을 통째로 오해할 수 있다.
 */
function toKstRange(start: string, end: string, offsetHours: number): string | null {
    const s = toKst(start, offsetHours);
    const e = toKst(end, offsetHours);
    if (!s || !e) return null;
    // 둘 다 넘어가면 앞에 한 번만 붙이는 편이 읽기 쉽다.
    if (s.nextDay && e.nextDay) return `익일 ${s.time}–${e.time}`;
    return `${s.time}–${e.nextDay ? `익일 ${e.time}` : e.time}`;
}

// MODELS[0]가 신규/미설정 분석 설정의 기본 모델이다. lib/db/queries.ts DEFAULT_ANALYSIS_MODEL과 동기화 유지.
const MODELS = [
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'claude-sonnet-4-6',
    'claude-opus-4-7',
    'gpt-5-mini',
    'gpt-5.4',
] as const;

const ANALYSIS_TYPES = [
    'technical',
    'news',
    'options',
    'fundamental',
    'congress',
    'trade_gate',
] as const;

const NOTIFICATION_EVENTS = [
    { key: 'trade_executed', label: '거래 체결' },
    { key: 'order_pending', label: '주문 승인 대기' },
    { key: 'stop_loss', label: '손절 발동' },
    { key: 'error', label: '시스템 오류' },
    { key: 'cron_health', label: '시스템 이상 감지' },
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
        case 'congress':
            return '의회 거래';
        case 'trade_gate':
            return '매매 게이트';
        default:
            return type;
    }
}

function getConfigValue(config: ConfigEntry[], key: string, fallback: unknown): unknown {
    const entry = config.find((c) => c.key === key);
    return entry ? entry.value : fallback;
}

/**
 * Optimistically apply a config POST body to the cached ConfigData so the UI
 * reflects the change instantly (before the server round-trip + refetch).
 * Mirrors the server-side handling in api/config.ts; the subsequent refetch
 * reconciles any divergence (e.g. real watchlist ids).
 */
function applyConfigOptimistic(old: ConfigData | undefined, body: unknown): ConfigData | undefined {
    if (!old) return old;
    const p = body as Record<string, unknown>;
    switch (p.type) {
        case 'config': {
            const key = p.key as string;
            const exists = old.config.some((c) => c.key === key);
            const config = exists
                ? old.config.map((c) => (c.key === key ? { ...c, value: p.value } : c))
                : [...old.config, { key, value: p.value, updatedAt: new Date().toISOString() }];
            return { ...old, config };
        }
        case 'watchlist': {
            if (p.action === 'add') {
                // Negative temp id avoids colliding with real ids until refetch.
                return {
                    ...old,
                    watchlist: [
                        ...old.watchlist,
                        {
                            id: -Date.now(),
                            symbol: p.symbol as string,
                            companyName: p.companyName as string,
                            enabled: true,
                            createdAt: new Date().toISOString(),
                        },
                    ],
                };
            }
            if (p.action === 'remove') {
                return { ...old, watchlist: old.watchlist.filter((w) => w.id !== p.id) };
            }
            if (p.action === 'toggle') {
                return {
                    ...old,
                    watchlist: old.watchlist.map((w) =>
                        w.id === p.id ? { ...w, enabled: p.enabled as boolean } : w,
                    ),
                };
            }
            return old;
        }
        case 'analysis': {
            const updates = p.updates as Partial<AnalysisConfig>;
            return {
                ...old,
                analysis: old.analysis.map((a) =>
                    a.analysisType === p.analysisType ? { ...a, ...updates } : a,
                ),
            };
        }
        case 'notification': {
            const updates = p.updates as Partial<NotificationConfig>;
            const channel = p.channel as string;
            const exists = old.notification.some((n) => n.channel === channel);
            const notification = exists
                ? old.notification.map((n) => (n.channel === channel ? { ...n, ...updates } : n))
                : [
                      ...old.notification,
                      { id: -1, channel, enabled: false, target: '', events: [], ...updates },
                  ];
            return { ...old, notification };
        }
        default:
            return old;
    }
}

export function SettingsPage() {
    const { data, isLoading, error } = useQuery({
        queryKey: ['config'],
        queryFn: ({ signal }) => api.getConfig(signal) as Promise<ConfigData>,
    });

    const updateMutation = useOptimisticMutation<unknown, ConfigData>({
        mutationFn: (body) => api.updateConfig(body),
        queryKey: ['config'],
        updater: applyConfigOptimistic,
    });

    const [saveMessage, setSaveMessage] = useState<string | null>(null);

    // Local state for trading mode (explicit save pattern)
    const [pendingMode, setPendingMode] = useState<string | null>(null);

    // Confirmation step before enabling auto mode
    const [confirmAutoMode, setConfirmAutoMode] = useState(false);

    // Local state for risk inputs (to allow typing without immediate API calls)
    const [riskOverrides, setRiskOverrides] = useState<Record<string, string>>({});

    // 진입 시간 창 초안. null이면 편집 전 = 서버 값 그대로 표시.
    const [entryWindowDraft, setEntryWindowDraft] = useState<EntryWindowForm | null>(null);

    if (isLoading) return <LoadingSkeleton />;
    if (error) return <ErrorMessage error={error as Error} />;
    if (!data) return null;

    const configData = data;
    const tradingMode = getConfigValue(configData.config, 'trading_mode', 'dry_run') as string;
    const currentMode = pendingMode ?? tradingMode;
    const modeChanged = pendingMode !== null && pendingMode !== tradingMode;

    const tradingEnabled = getConfigValue(configData.config, 'trading_enabled', true) === true;

    const analysisTimeframe = normalizeAnalysisTimeframe(
        getConfigValue(configData.config, 'analysis_timeframe', undefined),
    );

    const fixedExitEnabled =
        getConfigValue(configData.config, 'fixed_exit_enabled', false) === true;

    const averageDownEnabled =
        getConfigValue(configData.config, 'average_down_enabled', false) === true;

    const entryWindow =
        entryWindowDraft ??
        readEntryWindow(getConfigValue(configData.config, 'entry_window', undefined));
    // 서버도 start >= end를 400으로 거부한다. 왕복하기 전에 여기서 먼저 막는다.
    const entryWindowValid = entryWindow.start !== '' && entryWindow.start < entryWindow.end;
    // 입력이 비어 있는 등 파싱 불가면 환산 문구 자체를 내지 않는다(깨진 값을 보여주느니 침묵).
    const summerKst = toKstRange(entryWindow.start, entryWindow.end, KST_OFFSET_SUMMER);
    const winterKst = toKstRange(entryWindow.start, entryWindow.end, KST_OFFSET_WINTER);
    // `entryWindowValid`를 함께 보는 이유: start > end인 편집 중간 상태에서는 시작만 익일로
    // 넘어가고 끝은 당일에 남아, `04:00–22:00`처럼 익일 표기가 하나도 없는 멀쩡한 범위로
    // 읽힌다. 저장은 어차피 막혀 있으니, 잘못된 범위를 그럴듯하게 보여주느니 침묵한다.
    const entryWindowKst =
        entryWindowValid && summerKst && winterKst
            ? `한국시간 여름 ${summerKst} / 겨울 ${winterKst}`
            : null;

    const executeIntervalMin = getConfigValue(
        configData.config,
        'execute_interval_min',
        10,
    ) as number;

    const riskDefaults: Record<string, number> = {
        max_position_size: 5000,
        max_total_exposure: 25000,
        stop_loss_percent: 5,
        take_profit_percent: 10,
        buy_threshold: 70,
        sell_threshold: 30,
        max_trades_per_day: 20,
        max_daily_loss_usd: 500,
        entry_cooldown_min: 60,
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

    const hasRiskChanges = Object.keys(riskOverrides).length > 0;

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

            {/* System Control — Kill Switch */}
            <section className="rounded-lg border border-[#262626] bg-[#141414] p-4">
                <h2 className="text-sm font-semibold">시스템 제어</h2>
                <div className="mt-3 flex items-center justify-between">
                    <div>
                        <span className="text-xs text-neutral-400">자동매매 활성화</span>
                        <p className="text-[10px] text-neutral-600">
                            OFF 시 모든 자동 매매가 중지됩니다
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => {
                            mutate({
                                type: 'config',
                                key: 'trading_enabled',
                                value: !tradingEnabled,
                            });
                        }}
                        className={`min-h-[44px] min-w-[44px] rounded border px-2 py-1 text-xs ${
                            tradingEnabled
                                ? 'border-green-500/30 bg-green-500/10 text-green-400'
                                : 'border-red-500/30 bg-red-500/10 text-red-400'
                        }`}
                        aria-label={`자동매매 ${tradingEnabled ? '비활성화' : '활성화'}`}
                    >
                        {tradingEnabled ? 'ON' : 'OFF'}
                    </button>
                </div>
            </section>

            {/* General */}
            <section className="rounded-lg border border-[#262626] bg-[#141414] p-4">
                <h2 className="text-sm font-semibold">일반</h2>
                <div className="mt-3">
                    <label className="text-xs text-neutral-400">트레이딩 모드</label>
                    <select
                        className="mt-1 w-full rounded-lg border border-[#262626] bg-[#0a0a0a] px-3 py-2 text-sm outline-none focus:border-neutral-500"
                        value={currentMode}
                        onChange={(e) => setPendingMode(e.target.value)}
                    >
                        <option value="dry_run">모의투자 (DRY_RUN)</option>
                        <option value="semi_auto">반자동 (SEMI_AUTO)</option>
                        <option value="auto">자동 (AUTO)</option>
                    </select>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-neutral-500">
                        {currentMode === 'dry_run' &&
                            '실제 주문 없이 가상 거래만 기록합니다. 전략 검증에 적합합니다.'}
                        {currentMode === 'semi_auto' &&
                            '매매 신호 발생 시 이메일 알림을 보내고, 대시보드에서 직접 승인해야 주문이 실행됩니다.'}
                        {currentMode === 'auto' && '매매 신호 발생 시 즉시 주문을 실행합니다.'}
                    </p>
                    {modeChanged && !confirmAutoMode && (
                        <div className="mt-2 flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => {
                                    if (pendingMode === 'auto') {
                                        setConfirmAutoMode(true);
                                        return;
                                    }
                                    mutate({
                                        type: 'config',
                                        key: 'trading_mode',
                                        value: pendingMode,
                                    });
                                    setPendingMode(null);
                                }}
                                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
                            >
                                저장
                            </button>
                            <button
                                type="button"
                                onClick={() => setPendingMode(null)}
                                className="rounded-lg border border-[#262626] px-4 py-2 text-sm text-neutral-400 hover:text-neutral-200"
                            >
                                취소
                            </button>
                        </div>
                    )}
                    {confirmAutoMode && (
                        <div className="mt-2 rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                            <p className="text-sm text-red-400">
                                자동 모드에서는 매매 신호 발생 시 즉시 주문이 실행됩니다.
                                계속하시겠습니까?
                            </p>
                            <div className="mt-2 flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => {
                                        mutate({
                                            type: 'config',
                                            key: 'trading_mode',
                                            value: 'auto',
                                        });
                                        setConfirmAutoMode(false);
                                        setPendingMode(null);
                                    }}
                                    className="rounded bg-red-600 px-3 py-1.5 text-sm text-white"
                                >
                                    확인, 자동 모드 활성화
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setConfirmAutoMode(false);
                                        setPendingMode(null);
                                    }}
                                    className="rounded border border-[#262626] px-3 py-1.5 text-sm text-neutral-400"
                                >
                                    취소
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </section>

            {/* 매매 실행 주기 — 가격 조건(진입가·손절가·익절가)을 얼마나 자주 보는가.
                선택지는 lib/strategy/execute-interval.ts의 EXECUTE_INTERVALS와 같아야 한다
                (src/는 lib/를 import하지 않는 것이 이 저장소 규칙이라 값을 복제한다). */}
            <section className="rounded-lg border border-[#262626] bg-[#141414] p-4">
                <h2 className="text-sm font-semibold">매매 실행 주기</h2>
                <p className="mt-0.5 text-[10px] text-neutral-600">
                    가격 조건을 다시 판정하는 간격 — 손절 반응 지연의 상한
                </p>
                <select
                    aria-label="매매 실행 주기"
                    className="mt-3 w-full rounded-lg border border-[#262626] bg-[#0a0a0a] px-3 py-2 text-sm outline-none focus:border-neutral-500"
                    value={String(executeIntervalMin)}
                    onChange={(e) =>
                        mutate({
                            type: 'config',
                            key: 'execute_interval_min',
                            value: Number(e.target.value),
                        })
                    }
                >
                    {[5, 10, 15, 20, 30, 60].map((min) => (
                        <option key={min} value={min}>
                            {min}분
                        </option>
                    ))}
                </select>
                <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
                    짧을수록 진입 기회와 손절선에 빨리 반응하지만, 종목당 시세 조회가 그만큼
                    늘어납니다. 분할 진입이 과도해지면 재진입 최소 간격(투자 관리)을 함께 올리세요.
                </p>
            </section>

            {/* Entry Window — 진입만 막는 시간 게이트. 청산 경로는 건드리지 않는다. */}
            <section className="rounded-lg border border-[#262626] bg-[#141414] p-4">
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-sm font-semibold">진입 시간 창</h2>
                        <p className="mt-0.5 text-[10px] text-neutral-600">
                            신규 진입을 허용할 동부시간(ET) 구간
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() =>
                            setEntryWindowDraft({ ...entryWindow, enabled: !entryWindow.enabled })
                        }
                        className={`min-h-[44px] min-w-[44px] rounded border px-2 py-1 text-xs ${
                            entryWindow.enabled
                                ? 'border-green-500/30 bg-green-500/10 text-green-400'
                                : 'border-[#262626] bg-[#0a0a0a] text-neutral-500'
                        }`}
                        aria-label={`진입 시간 제한 ${entryWindow.enabled ? '비활성화' : '활성화'}`}
                    >
                        {entryWindow.enabled ? 'ON' : 'OFF'}
                    </button>
                </div>
                <div
                    className={`mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 ${!entryWindow.enabled ? 'opacity-40' : ''}`}
                >
                    {(
                        [
                            ['entry-window-start', '진입 시작 (ET)', 'start'],
                            ['entry-window-end', '진입 종료 (ET)', 'end'],
                        ] as const
                    ).map(([id, label, field]) => (
                        <div key={id}>
                            <label htmlFor={id} className="text-xs text-neutral-400">
                                {label}
                            </label>
                            <input
                                id={id}
                                type="time"
                                disabled={!entryWindow.enabled}
                                className="mt-1 w-full rounded-lg border border-[#262626] bg-[#0a0a0a] px-3 py-2 text-sm outline-none focus:border-neutral-500"
                                value={entryWindow[field]}
                                onChange={(e) =>
                                    setEntryWindowDraft({
                                        ...entryWindow,
                                        [field]: e.target.value,
                                    })
                                }
                            />
                        </div>
                    ))}
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
                    ET {entryWindow.start}–{entryWindow.end}
                    {entryWindowKst && ` = ${entryWindowKst}`}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
                    청산·손절은 정규장 내내 그대로 실행됩니다 — 이 창은 신규 진입만 제한합니다.
                </p>
                {entryWindow.enabled && !entryWindowValid && (
                    <p className="mt-2 text-[11px] text-red-400">
                        시작 시각은 종료 시각보다 빨라야 합니다
                    </p>
                )}
                {entryWindowDraft !== null && (
                    <button
                        type="button"
                        disabled={entryWindow.enabled && !entryWindowValid}
                        onClick={() => {
                            mutate({
                                type: 'config',
                                key: 'entry_window',
                                value: entryWindow.enabled
                                    ? { start: entryWindow.start, end: entryWindow.end }
                                    : ENTRY_WINDOW_OFF,
                            });
                            setEntryWindowDraft(null);
                        }}
                        aria-label="진입 시간 창 저장"
                        className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        저장
                    </button>
                )}
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
                <div className="mt-3">
                    <TickerSearch
                        onSelect={(result) => {
                            if (configData.watchlist.length >= 5) {
                                setSaveMessage('감시 종목은 최대 5개까지 설정 가능합니다');
                                return;
                            }
                            if (configData.watchlist.some((w) => w.symbol === result.symbol)) {
                                setSaveMessage('이미 등록된 종목입니다');
                                return;
                            }
                            mutate({
                                type: 'watchlist',
                                action: 'add',
                                symbol: result.symbol,
                                companyName: result.name,
                            });
                        }}
                    />
                </div>
            </section>

            {/* Analysis Config */}
            <section className="rounded-lg border border-[#262626] bg-[#141414] p-4">
                <h2 className="text-sm font-semibold">분석 설정</h2>
                <div className="mt-3">
                    <label htmlFor="analysis-timeframe" className="text-xs text-neutral-400">
                        기술 분석 차트 주기
                    </label>
                    <select
                        id="analysis-timeframe"
                        className="mt-1 w-full rounded-lg border border-[#262626] bg-[#0a0a0a] px-3 py-2 text-sm outline-none focus:border-neutral-500"
                        value={analysisTimeframe}
                        onChange={(event) =>
                            mutate({
                                type: 'config',
                                key: 'analysis_timeframe',
                                value: event.target.value,
                            })
                        }
                    >
                        <option value="15Min">15분</option>
                        <option value="30Min">30분</option>
                        <option value="1Hour">1시간</option>
                    </select>
                </div>
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
                            {ac.analysisType === 'trade_gate' && (
                                <p className="mt-0.5 text-[10px] text-neutral-600">
                                    분석이 아닌 매매 크기 판단에 사용됩니다 (분할 진입/청산 비율
                                    결정)
                                </p>
                            )}
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

            {/* 물타기 허용 여부 — 기본 OFF */}
            <section className="rounded-lg border border-[#262626] bg-[#141414] p-4">
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-sm font-semibold">평단 아래 추가매수</h2>
                        <p className="mt-0.5 text-[10px] text-neutral-600">
                            OFF 시 평단보다 낮은 가격에서는 추가매수하지 않습니다
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => {
                            mutate({
                                type: 'config',
                                key: 'average_down_enabled',
                                value: !averageDownEnabled,
                            });
                        }}
                        className={`min-h-[44px] min-w-[44px] rounded border px-2 py-1 text-xs ${
                            averageDownEnabled
                                ? 'border-green-500/30 bg-green-500/10 text-green-400'
                                : 'border-[#262626] bg-[#0a0a0a] text-neutral-500'
                        }`}
                        aria-label={`평단 아래 추가매수 ${averageDownEnabled ? '비활성화' : '활성화'}`}
                    >
                        {averageDownEnabled ? 'ON' : 'OFF'}
                    </button>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
                    종목당 예산은 <span className="font-medium">현재가 기준</span>이라 가격이
                    내릴수록 추가매수 여력이 커지고, 고정 손절선은 평단 기준이라 물타기를 하면
                    손절선도 함께 내려갑니다. 신규 진입에는 영향이 없습니다.
                </p>
            </section>

            {/* Fixed Stop-Loss / Take-Profit */}
            <section className="rounded-lg border border-[#262626] bg-[#141414] p-4">
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-sm font-semibold">고정 손절/익절</h2>
                        <p className="mt-0.5 text-[10px] text-neutral-600">
                            OFF 시 AI 분석 기반으로만 판단합니다
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => {
                            mutate({
                                type: 'config',
                                key: 'fixed_exit_enabled',
                                value: !fixedExitEnabled,
                            });
                        }}
                        className={`min-h-[44px] min-w-[44px] rounded border px-2 py-1 text-xs ${
                            fixedExitEnabled
                                ? 'border-green-500/30 bg-green-500/10 text-green-400'
                                : 'border-[#262626] bg-[#0a0a0a] text-neutral-500'
                        }`}
                        aria-label={`고정 손절/익절 ${fixedExitEnabled ? '비활성화' : '활성화'}`}
                    >
                        {fixedExitEnabled ? 'ON' : 'OFF'}
                    </button>
                </div>
                <div
                    className={`mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 ${!fixedExitEnabled ? 'pointer-events-none opacity-40' : ''}`}
                >
                    {(
                        [
                            [
                                'stop_loss_percent',
                                '손절선 (%)',
                                '매입가 대비 이 비율 이상 하락 시 매도',
                            ],
                            [
                                'take_profit_percent',
                                '익절선 (%)',
                                '매입가 대비 이 비율 이상 상승 시 매도',
                            ],
                        ] as const
                    ).map(([key, label, helper]) => (
                        <div key={key}>
                            <label className="text-xs text-neutral-400">{label}</label>
                            <p className="text-[10px] text-neutral-600">{helper}</p>
                            <input
                                type="number"
                                inputMode="decimal"
                                className="mt-1 w-full rounded-lg border border-[#262626] bg-[#0a0a0a] px-3 py-2 text-sm outline-none focus:border-neutral-500"
                                value={getRiskValue(key)}
                                onChange={(e) =>
                                    setRiskOverrides((prev) => ({
                                        ...prev,
                                        [key]: e.target.value,
                                    }))
                                }
                            />
                        </div>
                    ))}
                </div>
            </section>

            {/* Investment Limits */}
            <section className="rounded-lg border border-[#262626] bg-[#141414] p-4">
                <h2 className="text-sm font-semibold">투자 관리</h2>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {(
                        [
                            [
                                'max_position_size',
                                '종목당 최대 투자 금액 ($)',
                                '한 종목에 투자할 수 있는 최대 금액',
                            ],
                            [
                                'max_total_exposure',
                                '전체 투자 한도 ($)',
                                '모든 종목 합산 최대 투자 금액',
                            ],
                            [
                                'max_trades_per_day',
                                '일일 최대 거래 횟수',
                                '하루 최대 거래 횟수 (초과 시 자동 매매 중단)',
                            ],
                            [
                                'max_daily_loss_usd',
                                '일일 최대 손실 한도 ($)',
                                '오늘 실현 손실이 이 금액을 초과하면 매매 중지',
                            ],
                            [
                                'entry_cooldown_min',
                                '재진입 최소 간격 (분)',
                                '같은 종목을 다시 매수하기까지 기다릴 시간 (0이면 제한 없음)',
                            ],
                        ] as const
                    ).map(([key, label, helper]) => (
                        <div key={key}>
                            <label className="text-xs text-neutral-400">{label}</label>
                            <p className="text-[10px] text-neutral-600">{helper}</p>
                            <input
                                type="number"
                                inputMode={key === 'max_trades_per_day' ? 'numeric' : 'decimal'}
                                className="mt-1 w-full rounded-lg border border-[#262626] bg-[#0a0a0a] px-3 py-2 text-sm outline-none focus:border-neutral-500"
                                value={getRiskValue(key)}
                                onChange={(e) =>
                                    setRiskOverrides((prev) => ({
                                        ...prev,
                                        [key]: e.target.value,
                                    }))
                                }
                            />
                        </div>
                    ))}
                </div>
            </section>

            {/* AI Signal Thresholds */}
            <section className="rounded-lg border border-[#262626] bg-[#141414] p-4">
                <h2 className="text-sm font-semibold">AI 매매 신호 기준</h2>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {(
                        [
                            [
                                'buy_threshold',
                                '매수 신호 기준 (0~100점)',
                                'AI 분석 점수가 이 값 이상이면 매수 (기본 70)',
                            ],
                            [
                                'sell_threshold',
                                '매도 신호 기준 (0~100점)',
                                'AI 분석 점수가 이 값 이하이면 매도 (기본 30)',
                            ],
                        ] as const
                    ).map(([key, label, helper]) => (
                        <div key={key}>
                            <label className="text-xs text-neutral-400">{label}</label>
                            <p className="text-[10px] text-neutral-600">{helper}</p>
                            <input
                                type="number"
                                inputMode="decimal"
                                min={0}
                                max={100}
                                step={1}
                                className="mt-1 w-full rounded-lg border border-[#262626] bg-[#0a0a0a] px-3 py-2 text-sm outline-none focus:border-neutral-500"
                                value={getRiskValue(key)}
                                onChange={(e) =>
                                    setRiskOverrides((prev) => ({
                                        ...prev,
                                        [key]: e.target.value,
                                    }))
                                }
                            />
                        </div>
                    ))}
                </div>
            </section>

            {/* Save button for all risk/investment/threshold changes */}
            {hasRiskChanges && (
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => {
                            const entries = Object.entries(riskOverrides);
                            let failCount = 0;
                            let doneCount = 0;
                            setSaveMessage(null);
                            for (const [key, val] of entries) {
                                updateMutation.mutate(
                                    { type: 'config', key, value: Number(val) },
                                    {
                                        onSuccess: () => {
                                            doneCount++;
                                            if (doneCount + failCount === entries.length) {
                                                setSaveMessage(
                                                    failCount > 0
                                                        ? `오류: ${failCount}개 항목 저장에 실패했습니다`
                                                        : '설정이 저장되었습니다',
                                                );
                                            }
                                        },
                                        onError: () => {
                                            failCount++;
                                            if (doneCount + failCount === entries.length) {
                                                setSaveMessage(
                                                    `오류: ${failCount}개 항목 저장에 실패했습니다`,
                                                );
                                            }
                                        },
                                    },
                                );
                            }
                            setRiskOverrides({});
                        }}
                        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
                    >
                        저장
                    </button>
                    <button
                        type="button"
                        onClick={() => setRiskOverrides({})}
                        className="rounded-lg border border-[#262626] px-4 py-2 text-sm text-neutral-400 hover:text-neutral-200"
                    >
                        취소
                    </button>
                </div>
            )}

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
                            <label key={event.key} className="flex min-h-[44px] items-center gap-3">
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

                    {/* Quiet hours has no toggle — it is always on. Surfacing it here
                        because the behaviour is otherwise invisible: mail simply
                        doesn't arrive overnight and there is nothing in the UI saying why. */}
                    <p className="mt-4 border-t border-[#262626] pt-3 text-xs leading-5 text-neutral-500">
                        수면 모드: <span className="text-neutral-400">00:00~09:59</span>에 발생한
                        알림은 발송하지 않고 모아뒀다가{' '}
                        <span className="text-neutral-400">매일 오전 10시</span>에 한 통으로
                        보냅니다.
                        <br />
                        조용한 밤에는 메일이 오지 않습니다. 단
                        <span className="text-neutral-400"> 시스템 이상 감지</span>가 켜져 있으면,
                        보낼 이벤트가 없더라도 크론이 실패했거나 72시간 이상 멈춘 경우에는
                        알려줍니다.
                    </p>
                </div>
            </section>
        </div>
    );
}
