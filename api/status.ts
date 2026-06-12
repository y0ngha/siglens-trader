import { getDb } from './_lib/db.js';
import { isAuthenticated } from './_lib/auth.js';
import { getOpenPositions, getConfigValue, getTodayTradeCount } from '../lib/db/queries.js';

async function handler(req: Request): Promise<Response> {
    if (!isAuthenticated(req)) return new Response('Forbidden', { status: 403 });
    if (req.method !== 'GET') return new Response(null, { status: 405 });

    const db = getDb();
    const [openPositions, tradingMode, todayTrades, tradingEnabled, maxTradesPerDay] =
        await Promise.all([
            getOpenPositions(db),
            getConfigValue<string>(db, 'trading_mode'),
            getTodayTradeCount(db),
            getConfigValue<boolean>(db, 'trading_enabled'),
            getConfigValue<number>(db, 'max_trades_per_day'),
        ]);

    return Response.json({
        running: true,
        tradingMode: tradingMode ?? 'dry_run',
        activePositions: openPositions.length,
        todayTrades,
        tradingEnabled: tradingEnabled ?? true,
        maxTradesPerDay: maxTradesPerDay ?? 20,
    });
}

export const GET = handler;
