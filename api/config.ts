import { getDb } from './_lib/db';
import { isAuthenticated } from './_lib/auth';
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
} from '../lib/db/queries';

export default async function handler(req: Request): Promise<Response> {
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
            'max_position_size',
            'max_total_exposure',
            'stop_loss_percent',
            'take_profit_percent',
            'buy_threshold',
            'sell_threshold',
            'analysis_timeframe',
            'score_weights',
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
