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

async function handler(req: Request): Promise<Response> {
    if (!isAuthenticated(req)) return new Response('Forbidden', { status: 403 });

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
        ]);

        const BOOLEAN_CONFIG_KEYS = new Set(['trading_enabled', 'fixed_exit_enabled']);

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
                    const ALLOWED_TF = new Set([
                        '5Min',
                        '15Min',
                        '30Min',
                        '1Hour',
                        '4Hour',
                        '1Day',
                    ]);
                    if (!ALLOWED_TF.has(value as string)) {
                        return Response.json(
                            {
                                error: 'analysis_timeframe must be one of: 5Min, 15Min, 30Min, 1Hour, 4Hour, 1Day',
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
                    const requiredKeys = ['technical', 'news', 'options', 'fundamental', 'overall'];
                    const requiredKeySet = new Set(requiredKeys);
                    const extraKeys = Object.keys(w).filter((k) => !requiredKeySet.has(k));
                    if (extraKeys.length > 0) {
                        return Response.json(
                            {
                                error: `score_weights contains unknown key(s): ${extraKeys.join(', ')}`,
                            },
                            { status: 400 },
                        );
                    }
                    for (const k of requiredKeys) {
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
                    const weightSum = requiredKeys.reduce((sum, k) => sum + (w[k] as number), 0);
                    if (weightSum <= 0) {
                        return Response.json(
                            { error: 'score_weights sum must be greater than 0' },
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
                // Logical validation: buy_threshold must be greater than sell_threshold
                if (key === 'buy_threshold' || key === 'sell_threshold') {
                    const otherKey = key === 'buy_threshold' ? 'sell_threshold' : 'buy_threshold';
                    const otherValue = await getConfigValue<number>(db, otherKey);
                    const buyT = key === 'buy_threshold' ? (value as number) : (otherValue ?? 70);
                    const sellT = key === 'sell_threshold' ? (value as number) : (otherValue ?? 30);
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
                    'overall',
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
