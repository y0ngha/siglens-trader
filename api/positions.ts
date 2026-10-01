import { getDb } from './_lib/db.js';
import { isAuthenticated } from './_lib/auth.js';
import { getOpenPositions } from '../lib/db/queries.js';
import { fetchLivePrice } from '../lib/data/live-price.js';
import { fetchDailyBars } from '../lib/analysis/daily-bars.js';
import { ma5ExitPrice } from '../lib/strategy/mean-reversion.js';

/**
 * 현재가(FMP quote)와 MA5 회복 목표가를 붙인다. DB에는 현재가 칼럼이 없다 — 붙이지 않으면
 * 대시보드가 매수가로 대체해 평가액·수익률이 영원히 0%로 보인다. 조회 실패는 null(UI가 대체 표시).
 */
async function withMarket<T extends { symbol: string }>(p: T, now: Date) {
    const price = await fetchLivePrice(p.symbol);
    const bars = price == null ? null : await fetchDailyBars(p.symbol, price, now);
    const target = bars ? ma5ExitPrice(bars) : null;
    return {
        ...p,
        currentPrice: price == null ? undefined : String(price),
        targetPrice: target == null ? null : target.toFixed(2),
    };
}

async function handler(req: Request): Promise<Response> {
    if (!(await isAuthenticated(req))) return new Response('Forbidden', { status: 403 });
    if (req.method !== 'GET') return new Response(null, { status: 405 });

    const db = getDb();
    const openPositions = await getOpenPositions(db);
    const now = new Date();

    return Response.json(await Promise.all(openPositions.map((p) => withMarket(p, now))));
}

// Vercel Node runtime: expose Web `Request`/`Response` handlers via named HTTP-method
// exports. A bare `export default` would be treated as the legacy `(req, res)` handler.
export const GET = handler;
