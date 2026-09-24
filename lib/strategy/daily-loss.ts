/**
 * 일일 손실 차단기의 미실현 항 — **오늘 변동분**(스펙 §4.5).
 *
 * 종전에는 진입가 대비 누적 손익이었다. 장중 전략에서는 포지션이 당일 청산돼 둘이 같았지만,
 * 평균 4거래일을 들고 가는 일봉 눌림매수에서는 −10% 눌린 포지션 하나가 기본 한도를 채우고
 * 그 포지션이 회복할 때까지 **며칠 동안 모든 진입을 막는다** — 이 전략이 사는 날이 정확히 그런
 * 날이다. 백테스트(5슬롯)에서 누적 기준 한도 2%는 2023-26 신호 366건을 막고 연수익을 19.6%에서
 * 12.7%로 깎았으며 MDD는 30%에서 28%로 거의 줄이지 못했다.
 *
 * 기준가는 오늘 진입한 포지션이면 진입가, 아니면 전일 종가다. 전일 종가를 모르면 진입가로
 * **대체**한다 — 포지션을 합계에서 빼면 손실을 과소 집계해 차단이 늦어진다(종전 원칙 "빼지 말고
 * 대체한다"와 같다).
 */

/**
 * 현재가가 기준가에서 이 비율보다 넘게 벗어나면 시세 손상(소수점 이동, 다른 종목의 가격)으로 보고
 * 그 포지션의 변동을 0으로 둔다. 실제 25% 넘는 급락도 여기서 무시되지만, 그 포지션의 재난 손절은
 * 실시간 가격으로 따로 작동하므로 청산이 늦어지지는 않는다 — 무뎌지는 쪽은 파괴적이지 않은 쪽이다.
 */
export const MAX_QUOTE_DIVERGENCE = 0.25;

export interface HeldPosition {
    symbol: string;
    quantity: number;
    avgPrice: number;
    /** 진입한 ET 거래일 `YYYY-MM-DD`. */
    openedDate: string;
}

export interface QuoteLite {
    price: number | null;
    previousClose: number | null;
}

export interface TodayChange {
    total: number;
    /** 현재가를 몰라 합계에 넣지 못한 종목(변동 0 취급). */
    missingPrice: string[];
    /** 현재가가 기준가에서 `MAX_QUOTE_DIVERGENCE`를 넘게 벗어나 변동 0으로 둔 종목. */
    divergent: string[];
}

const positive = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;

export function todayUnrealizedChange(
    positions: readonly HeldPosition[],
    quotes: ReadonlyMap<string, QuoteLite>,
    todayEt: string,
): TodayChange {
    let total = 0;
    const missingPrice: string[] = [];
    const divergent: string[] = [];
    for (const p of positions) {
        const q = quotes.get(p.symbol);
        const reference =
            p.openedDate !== todayEt && positive(q?.previousClose) ? q.previousClose : p.avgPrice;
        const price = q?.price;
        if (!positive(price) || !positive(reference)) {
            missingPrice.push(p.symbol);
            continue;
        }
        if (Math.abs(price - reference) / reference > MAX_QUOTE_DIVERGENCE) {
            divergent.push(p.symbol);
            continue;
        }
        total += (price - reference) * p.quantity;
    }
    return { total, missingPrice, divergent };
}
