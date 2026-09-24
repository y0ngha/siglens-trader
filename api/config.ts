import { getDb } from './_lib/db.js';
import { isAuthenticated } from './_lib/auth.js';
import {
    getAllConfig,
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
import { EXECUTE_INTERVALS, isExecuteInterval } from '../lib/strategy/execute-interval.js';

/**
 * 관심종목 상한. 종전 5는 종목마다 매시간 LLM 분석 5축이 돌던 시절의 비용 상한이었다. 지금은 규칙이
 * 가격만 보고 AI는 신호가 난 종목에만 불리므로(docs/specs/2026-09-24-daily-mean-reversion-design.md §5)
 * 종목 수의 비용은 FMP 호출뿐이다. 30은 판단 틱 한 번의 일봉·시세 조회(종목당 2회)가 실행 마감
 * 안에 여유 있게 끝나는 수다.
 */
export const MAX_WATCHLIST_SIZE = 30;

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
            'max_trades_per_day',
            'max_daily_loss_usd',
            'execute_interval_min',
            'dry_run_cash_usd',
            'mr_rsi_entry',
            'mr_max_hold_days',
            'mr_stop_atr',
            'mr_regime_filter',
            'dry_run_cost_bps',
        ]);

        const NUMERIC_CONFIG_KEYS = new Set([
            'max_position_size',
            'max_total_exposure',
            'max_trades_per_day',
            'max_daily_loss_usd',
            'dry_run_cash_usd',
            'mr_rsi_entry',
            'mr_max_hold_days',
            'mr_stop_atr',
            'dry_run_cost_bps',
        ]);

        const BOOLEAN_CONFIG_KEYS = new Set(['trading_enabled', 'mr_regime_filter']);

        /**
         * 전략 파라미터의 키별 범위(스펙 §6). 양 끝은 "그 값을 넘으면 규칙이 다른 전략이 되는" 지점이다 —
         * RSI(2) 기준 50은 과매도가 아니라 중립이고, 보유 60거래일은 단기 반전이 아니라 추세 보유다.
         * 손절 배수 0은 "손절 없음"이라 허용한다. 범위가 없는 숫자 키는 아래 공통 범위(0~1,000,000)를 쓴다.
         */
        const NUMERIC_BOUNDS: Record<string, { min: number; max: number; integer?: boolean }> = {
            mr_rsi_entry: { min: 1, max: 50 },
            mr_max_hold_days: { min: 1, max: 60, integer: true },
            mr_stop_atr: { min: 0, max: 20 },
            dry_run_cost_bps: { min: 0, max: 100 },
        };

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
                // 실행 간격은 열거값이다(5·10분) — 이유는 `EXECUTE_INTERVALS` 주석. `parseExecuteInterval`
                // (손상된 행을 조용히 기본값으로 되돌리는 런타임 방어)을 여기 쓰지 않는 이유는, API가
                // 거부해야 운영자가 오타를 알기 때문이다.
                if (key === 'execute_interval_min' && !isExecuteInterval(value)) {
                    return Response.json(
                        {
                            error: `execute_interval_min must be one of: ${EXECUTE_INTERVALS.join(', ')}`,
                        },
                        { status: 400 },
                    );
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
                    const bounds = NUMERIC_BOUNDS[key];
                    if (
                        bounds &&
                        (value < bounds.min ||
                            value > bounds.max ||
                            (bounds.integer === true && !Number.isInteger(value)))
                    ) {
                        return Response.json(
                            {
                                error: `${key} must be ${bounds.integer ? 'an integer ' : ''}between ${bounds.min} and ${bounds.max}`,
                            },
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
                    if (currentWatchlist.length >= MAX_WATCHLIST_SIZE) {
                        return Response.json(
                            {
                                error: `감시 종목은 최대 ${MAX_WATCHLIST_SIZE}개까지 설정 가능합니다`,
                            },
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
                // AI 리뷰(`entry_review`)가 쓰는 분석 3종과 리뷰 모델 자체(스펙 §5).
                const ALLOWED_ANALYSIS_TYPES = new Set([
                    'technical',
                    'news',
                    'fundamental',
                    'entry_review',
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
