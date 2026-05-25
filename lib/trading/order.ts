import { submitOrder } from './toss-client';
import type { TossOrderResponse } from './types';

function validateOrderInputs(symbol: string, quantity: number): void {
    if (!symbol || typeof symbol !== 'string') {
        throw new Error('Invalid symbol');
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error('Quantity must be a positive integer');
    }
}

export async function executeBuyOrder(
    symbol: string,
    quantity: number,
    idempotencyKey?: string,
): Promise<TossOrderResponse> {
    validateOrderInputs(symbol, quantity);
    return submitOrder({ symbol, side: 'buy', orderType: 'market', quantity }, idempotencyKey);
}

export async function executeSellOrder(
    symbol: string,
    quantity: number,
    idempotencyKey?: string,
): Promise<TossOrderResponse> {
    validateOrderInputs(symbol, quantity);
    return submitOrder({ symbol, side: 'sell', orderType: 'market', quantity }, idempotencyKey);
}
