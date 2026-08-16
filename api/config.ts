import { getDb } from './_lib/db.js';
import { isAuthenticated } from './_lib/auth.js';
import {
    getAllConfig,
    getConfigValue,
    setConfigValue,
    getAllWatchlist,
    addToWatchlist,
    removeFromWatchlist,
    toggleWatchlistItem,
    getAllAnalysisConfigs,
    updateAnalysisConfig,
    getNotificationConfig,
    updateNotificationConfig,
} from '../lib/db/queries.js';
import { isAnalysisTimeframe } from '../lib/analysis/timeframe.js';
import {
    formatEntryWindow,
    parseEntryWindow,
    parseTimeOfDay,
} from '../lib/strategy/entry-window.js';
import {
    DEFAULT_EXECUTE_INTERVAL_MIN,
    EXECUTE_INTERVALS,
    isExecuteInterval,
    hasTickInWindow,
} from '../lib/strategy/execute-interval.js';

async function handler(req: Request): Promise<Response> {
    if (!(await isAuthenticated(req))) return new Response('Forbidden', { status: 403 });

    const db = getDb();

    if (req.method === 'GET') {
        const [configs, watchlistItems, analysisConfigs, notificationConfigs] = await Promise.all([
            getAllConfig(db),
            getAllWatchlist(db),
            getAllAnalysisConfigs(db),
            getNotificationConfig(db),
        ]);

        return Response.json({
            config: configs,
            watchlist: watchlistItems,
            analysis: analysisConfigs,
            notification: notificationConfigs,
        });
    }

    if (req.method === 'POST') {
        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
        }

        if (!body || typeof body !== 'object' || !('type' in body)) {
            return Response.json({ error: 'Missing "type" field' }, { status: 400 });
        }

        const payload = body as Record<string, unknown>;

        const ALLOWED_CONFIG_KEYS = new Set([
            'trading_mode',
            'trading_enabled',
            'max_position_size',
            'max_total_exposure',
            'stop_loss_percent',
            'take_profit_percent',
            'buy_threshold',
            'sell_threshold',
            'analysis_timeframe',
            'score_weights',
            'fixed_exit_enabled',
            'max_trades_per_day',
            'max_daily_loss_usd',
            'entry_window',
            'execute_interval_min',
            'entry_cooldown_min',
            'average_down_enabled',
        ]);

        const NUMERIC_CONFIG_KEYS = new Set([
            'max_position_size',
            'max_total_exposure',
            'stop_loss_percent',
            'take_profit_percent',
            'buy_threshold',
            'sell_threshold',
            'max_trades_per_day',
            'max_daily_loss_usd',
            'entry_cooldown_min',
        ]);

        const BOOLEAN_CONFIG_KEYS = new Set([
            'trading_enabled',
            'fixed_exit_enabled',
            'average_down_enabled',
        ]);

        switch (payload.type) {
            case 'config': {
                const { key, value } = payload;
                if (typeof key !== 'string') {
                    return Response.json({ error: 'Missing "key" field' }, { status: 400 });
                }
                if (!ALLOWED_CONFIG_KEYS.has(key)) {
                    return Response.json(
                        { error: `Unknown config key: "${key}"` },
                        { status: 400 },
                    );
                }
                if (key === 'trading_mode') {
                    const ALLOWED_MODES = new Set(['dry_run', 'semi_auto', 'auto']);
                    if (!ALLOWED_MODES.has(value as string)) {
                        return Response.json(
                            { error: 'trading_mode must be one of: dry_run, semi_auto, auto' },
                            { status: 400 },
                        );
                    }
                }
                if (BOOLEAN_CONFIG_KEYS.has(key) && typeof value !== 'boolean') {
                    return Response.json({ error: `${key} must be a boolean` }, { status: 400 });
                }
                if (key === 'analysis_timeframe') {
                    if (!isAnalysisTimeframe(value)) {
                        return Response.json(
                            {
                                error: 'analysis_timeframe must be one of: 15Min, 30Min, 1Hour',
                            },
                            { status: 400 },
                        );
                    }
                }
                if (key === 'score_weights') {
                    if (!value || typeof value !== 'object' || Array.isArray(value)) {
                        return Response.json(
                            { error: 'score_weights must be an object' },
                            { status: 400 },
                        );
                    }
                    const w = value as Record<string, unknown>;
                    const requiredKeys = ['technical', 'news', 'options', 'fundamental'];
                    // `congress` is accepted but not required: it was added after this endpoint
                    // shipped, so a caller still posting the original four keys must keep
                    // working (the runtime fills the missing weight from the timeframe profile).
                    // Without listing it here the unknown-key check below rejects any object
                    // that does include it — which would make the weight unsettable.
                    // `confluence`도 같은 이유로 선택 키다.
                    const optionalKeys = ['congress', 'confluence'];
                    const knownKeySet = new Set([...requiredKeys, ...optionalKeys]);
                    const extraKeys = Object.keys(w).filter((k) => !knownKeySet.has(k));
                    if (extraKeys.length > 0) {
                        return Response.json(
                            {
                                error: `score_weights contains unknown key(s): ${extraKeys.join(', ')}`,
                            },
                            { status: 400 },
                        );
                    }
                    const presentKeys = [
                        ...requiredKeys,
                        ...optionalKeys.filter((k) => w[k] !== undefined),
                    ];
                    for (const k of presentKeys) {
                        if (
                            typeof w[k] !== 'number' ||
                            !Number.isFinite(w[k] as number) ||
                            (w[k] as number) < 0
                        ) {
                            return Response.json(
                                {
                                    error: `score_weights.${k} must be a non-negative number`,
                                },
                                { status: 400 },
                            );
                        }
                    }
                    const weightSum = presentKeys.reduce((sum, k) => sum + (w[k] as number), 0);
                    if (weightSum <= 0) {
                        return Response.json(
                            { error: 'score_weights sum must be greater than 0' },
                            { status: 400 },
                        );
                    }
                }
                // `parseEntryWindow`를 여기 쓰지 않는 이유: 그건 잘못된 값을 조용히 기본 창으로
                // 되돌리는 런타임 방어다. API는 거부해야 운영자가 오타를 안다. 'HH:MM' 파싱만
                // 공유해서 대시보드가 받아준 값을 런타임이 다르게 읽는 일이 없게 한다.
                if (key === 'entry_window') {
                    if (!value || typeof value !== 'object' || Array.isArray(value)) {
                        return Response.json(
                            { error: 'entry_window must be an object' },
                            { status: 400 },
                        );
                    }
                    const w = value as Record<string, unknown>;
                    const extraKeys = Object.keys(w).filter((k) => k !== 'start' && k !== 'end');
                    if (extraKeys.length > 0) {
                        return Response.json(
                            {
                                error: `entry_window contains unknown key(s): ${extraKeys.join(', ')}`,
                            },
                            { status: 400 },
                        );
                    }
                    const startMinute = parseTimeOfDay(w.start);
                    const endMinute = parseTimeOfDay(w.end);
                    for (const [k, m] of [
                        ['start', startMinute],
                        ['end', endMinute],
                    ] as const) {
                        if (m === null) {
                            return Response.json(
                                {
                                    error: `entry_window.${k} must be a "HH:MM" string between 00:00 and 24:00`,
                                },
                                { status: 400 },
                            );
                        }
                    }
                    if ((startMinute as number) >= (endMinute as number)) {
                        return Response.json(
                            { error: 'entry_window.start must be earlier than entry_window.end' },
                            { status: 400 },
                        );
                    }
                }
                // 실행 간격은 열거값이다 — 60의 약수만 허용한다. 임의의 분을 받으면
                // `isExecuteTick`의 모듈로가 시(hour) 경계에서 어긋나 실행이 불규칙해진다.
                // `parseExecuteInterval`(손상된 행을 조용히 기본값으로 되돌리는 런타임 방어)을
                // 여기 쓰지 않는 이유는 entry_window와 같다 — API는 거부해야 오타가 드러난다.
                if (key === 'execute_interval_min' && !isExecuteInterval(value)) {
                    return Response.json(
                        {
                            error: `execute_interval_min must be one of: ${EXECUTE_INTERVALS.join(', ')}`,
                        },
                        { status: 400 },
                    );
                }
                // 실행 틱과 진입 창의 교집합이 비면 매수가 영구히 0이 된다.
                //
                // 실행 틱은 UTC 분에 고정(`(분 − 7) mod interval === 0`)인데 진입 창은 ET 시:분으로
                // 임의 지정이라, 예컨대 간격 60분(매시 :07 하나)에 창을 11:10–14:50으로 잡으면
                // 창 안에 틱이 하나도 없다. 로그에는 `outside_entry_window`만 남아 설정 오류와
                // 정상 상태가 구분되지 않으므로, 저장 시점에 거부한다.
                if (key === 'execute_interval_min' || key === 'entry_window') {
                    const interval =
                        key === 'execute_interval_min'
                            ? (value as number)
                            : ((await getConfigValue<number>(db, 'execute_interval_min')) ??
                              DEFAULT_EXECUTE_INTERVAL_MIN);
                    const windowValue =
                        key === 'entry_window'
                            ? value
                            : await getConfigValue<unknown>(db, 'entry_window');
                    const window = parseEntryWindow(windowValue);
                    if (!hasTickInWindow(interval, window)) {
                        return Response.json(
                            {
                                error: `실행 주기 ${interval}분과 진입 창 ${formatEntryWindow(window)} (ET)의 교집합이 비어 있어 신규 진입이 영구히 발생하지 않습니다`,
                            },
                            { status: 400 },
                        );
                    }
                }
                if (NUMERIC_CONFIG_KEYS.has(key)) {
                    const MAX_VALUE = 1_000_000;
                    if (
                        typeof value !== 'number' ||
                        !Number.isFinite(value) ||
                        value < 0 ||
                        value > MAX_VALUE
                    ) {
                        return Response.json(
                            {
                                error: `"${key}" must be a number between 0 and ${MAX_VALUE.toLocaleString()}`,
                            },
                            { status: 400 },
                        );
                    }
                }
                // Logical validation: minimum thresholds for risk parameters
                // 재진입 쿨다운 상한은 하루(1440분) — 그보다 길면 "오늘은 이 종목 재진입
                // 없음"이고, 그건 워치리스트에서 빼는 게 맞다.
                if (key === 'entry_cooldown_min' && (value as number) > 1440) {
                    return Response.json(
                        { error: 'entry_cooldown_min must be between 0 and 1440' },
                        { status: 400 },
                    );
                }
                if (key === 'stop_loss_percent' && (value as number) < 1) {
                    return Response.json(
                        { error: 'stop_loss_percent must be at least 1' },
                        { status: 400 },
                    );
                }
                if (key === 'take_profit_percent' && (value as number) < 1) {
                    return Response.json(
                        { error: 'take_profit_percent must be at least 1' },
                        { status: 400 },
                    );
                }
                // Range + logical validation for buy_threshold / sell_threshold
                // Lower bound (>= 0) is enforced by the generic NUMERIC_CONFIG_KEYS guard above.
                if (key === 'buy_threshold' || key === 'sell_threshold') {
                    const numVal = value as number;
                    if (numVal > 100) {
                        return Response.json(
                            { error: `${key} must be between 0 and 100` },
                            { status: 400 },
                        );
                    }
                    const otherKey = key === 'buy_threshold' ? 'sell_threshold' : 'buy_threshold';
                    const otherValue = await getConfigValue<number>(db, otherKey);
                    const buyT = key === 'buy_threshold' ? numVal : (otherValue ?? 70);
                    const sellT = key === 'sell_threshold' ? numVal : (otherValue ?? 30);
                    if (buyT <= sellT) {
                        return Response.json(
                            { error: 'buy_threshold must be greater than sell_threshold' },
                            { status: 400 },
                        );
                    }
                }
                await setConfigValue(db, key, value);
                return Response.json({ success: true });
            }

            case 'watchlist': {
                const { action } = payload;
                if (action === 'add') {
                    const { symbol, companyName } = payload;
                    if (typeof symbol !== 'string' || typeof companyName !== 'string') {
                        return Response.json(
                            { error: 'Missing "symbol" or "companyName"' },
                            { status: 400 },
                        );
                    }
                    const currentWatchlist = await getAllWatchlist(db);
                    if (currentWatchlist.length >= 5) {
                        return Response.json(
                            { error: '감시 종목은 최대 5개까지 설정 가능합니다' },
                            { status: 400 },
                        );
                    }
                    const result = await addToWatchlist(db, symbol, companyName);
                    return Response.json({ success: true, data: result });
                }
                if (action === 'remove') {
                    const { id } = payload;
                    if (typeof id !== 'number') {
                        return Response.json({ error: 'Missing "id"' }, { status: 400 });
                    }
                    await removeFromWatchlist(db, id);
                    return Response.json({ success: true });
                }
                if (action === 'toggle') {
                    const { id, enabled } = payload;
                    if (typeof id !== 'number' || typeof enabled !== 'boolean') {
                        return Response.json(
                            { error: 'Missing "id" or "enabled"' },
                            { status: 400 },
                        );
                    }
                    await toggleWatchlistItem(db, id, enabled);
                    return Response.json({ success: true });
                }
                return Response.json({ error: 'Invalid watchlist action' }, { status: 400 });
            }

            case 'analysis': {
                const { analysisType, updates } = payload;
                if (typeof analysisType !== 'string' || !updates || typeof updates !== 'object') {
                    return Response.json(
                        { error: 'Missing "analysisType" or "updates"' },
                        { status: 400 },
                    );
                }
                const ALLOWED_ANALYSIS_TYPES = new Set([
                    'technical',
                    'news',
                    'options',
                    'fundamental',
                    'trade_gate',
                ]);
                if (!ALLOWED_ANALYSIS_TYPES.has(analysisType)) {
                    return Response.json({ error: 'Unknown analysis type' }, { status: 400 });
                }
                await updateAnalysisConfig(
                    db,
                    analysisType,
                    updates as { modelId?: string; enabled?: boolean; useByok?: boolean },
                );
                return Response.json({ success: true });
            }

            case 'notification': {
                const { channel, updates } = payload;
                if (typeof channel !== 'string' || !updates || typeof updates !== 'object') {
                    return Response.json(
                        { error: 'Missing "channel" or "updates"' },
                        { status: 400 },
                    );
                }
                const ALLOWED_CHANNELS = new Set(['email']);
                if (!ALLOWED_CHANNELS.has(channel)) {
                    return Response.json(
                        { error: 'Unknown notification channel' },
                        { status: 400 },
                    );
                }
                await updateNotificationConfig(
                    db,
                    channel,
                    updates as { enabled?: boolean; target?: string; events?: string[] },
                );
                return Response.json({ success: true });
            }

            default:
                return Response.json({ error: `Unknown type: "${payload.type}"` }, { status: 400 });
        }
    }

    return new Response(null, { status: 405 });
}

// Vercel Node runtime: expose Web `Request`/`Response` handlers via named HTTP-method
// exports. A bare `export default` would be treated as the legacy `(req, res)` handler.
export const GET = handler;
export const POST = handler;
