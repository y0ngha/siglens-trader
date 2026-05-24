import { submitOrder } from './toss-client';
import type { TossOrderResponse } from './types';

export async function executeBuyOrder(
    symbol: string,
    quantity: number,
): Promise<TossOrderResponse> {
    return submitOrder({ symbol, side: 'buy', orderType: 'market', quantity });
}

export async function executeSellOrder(
    symbol: string,
    quantity: number,
): Promise<TossOrderResponse> {
    return submitOrder({ symbol, side: 'sell', orderType: 'market', quantity });
}
