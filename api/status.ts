import { getDb } from './_lib/db.js';
import { isAuthenticated } from './_lib/auth.js';
import { getAvailableCashUsd } from './_lib/cash.js';
import {
    getOpenPositions,
    getConfigValue,
    getTodayTradeCount,
    getLatestSizing,
} from '../lib/db/queries.js';

async function handler(req: Request): Promise<Response> {
    if (!(await isAuthenticated(req))) return new Response('Forbidden', { status: 403 });
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

    const mode = tradingMode ?? 'dry_run';
    // 대시보드의 `보유 현금`. **execute cron과 같은 함수를 쓴다** — 계산을 두 벌 두면
    // 화면의 현금과 실제 사이징이 쓰는 현금이 조용히 갈라진다.
    //
    // 조회 실패는 `null`이고 UI는 그걸 `—`로 그린다. 0으로 떨어뜨리지 않는 이유:
    // "브로커를 못 읽었다"와 "현금이 없다"는 다른 상태이고, 후자로 표시하면 운영자가
    // 있지도 않은 잔고 소진을 믿게 된다.
    const cashBalance = await getAvailableCashUsd(db, mode).catch(() => null);
    // 칸 수·한도는 설정이 아니라 execute가 총자산에서 도출한 값이다 — 마지막 런이 쓴 값을 그대로 보여 준다.
    // 대시보드가 따로 계산하면 감시 종목 시세가 없어 칸 수가 실제와 갈라진다.
    const latestSizing = await getLatestSizing(db).catch(() => null);

    return Response.json({
        running: true,
        tradingMode: mode,
        activePositions: openPositions.length,
        todayTrades,
        tradingEnabled: tradingEnabled ?? true,
        maxTradesPerDay: maxTradesPerDay ?? 20,
        cashBalance,
        sizing: latestSizing ? { ...latestSizing.sizing, at: latestSizing.at.toISOString() } : null,
    });
}

export const GET = handler;
