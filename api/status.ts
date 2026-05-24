import { getDb } from './_lib/db';
import { getOpenPositions, getConfigValue, getTodayTradeCount } from '../lib/db/queries';

export default async function handler(req: Request): Promise<Response> {
    if (req.method !== 'GET') return new Response(null, { status: 405 });

    const db = getDb();
    const [openPositions, tradingMode, todayTrades] = await Promise.all([
        getOpenPositions(db),
        getConfigValue<string>(db, 'trading_mode'),
        getTodayTradeCount(db),
    ]);

    return Response.json({
        running: true,
        tradingMode: tradingMode ?? 'dry_run',
        activePositions: openPositions.length,
        todayTrades,
    });
}
