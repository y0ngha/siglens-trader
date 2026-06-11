import { tossFetch, TossApiError } from './client';
import { parseDecimal } from '../validation';
import type {
    IssueOrderRequest,
    OrderOutcome,
    OrderDetail,
    OrderSide,
    TossOrderStatus,
} from './types';

const POLL_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 1500;

function validateOrderInputs(symbol: string, quantity: number): void {
    if (!symbol || typeof symbol !== 'string') throw new Error('Invalid symbol');
    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error('Quantity must be a positive integer');
    }
}

export async function issueOrder(req: IssueOrderRequest): Promise<{ orderId: string }> {
    const res = await tossFetch<{ orderId: string }>('POST', '/api/v1/orders', {
        account: true,
        body: {
            clientOrderId: req.clientOrderId,
            symbol: req.symbol,
            side: req.side,
            orderType: req.orderType,
            quantity: String(req.quantity),
        },
    });
    return { orderId: res.orderId };
}

interface OrderRaw {
    orderId: string;
    status: TossOrderStatus;
    canceledAt?: string | null;
    execution?: { filledQuantity?: string; averageFilledPrice?: string | null };
}

export async function getOrder(orderId: string): Promise<OrderDetail> {
    const o = await tossFetch<OrderRaw>('GET', `/api/v1/orders/${orderId}`, { account: true });
    return {
        orderId: o.orderId,
        status: o.status,
        filledQuantity: parseDecimal(o.execution?.filledQuantity, 0),
        avgFilledPrice:
            o.execution?.averageFilledPrice != null
                ? parseDecimal(o.execution.averageFilledPrice, 0)
                : null,
        canceledAt: o.canceledAt ?? null,
    };
}

function mapStatus(s: TossOrderStatus): OrderOutcome['status'] | null {
    switch (s) {
        case 'FILLED':
            return 'filled';
        case 'PARTIAL_FILLED':
            return 'partial';
        case 'REJECTED':
        case 'CANCEL_REJECTED':
        case 'REPLACE_REJECTED':
            return 'rejected';
        case 'CANCELED':
            return 'canceled';
        default:
            return null; // PENDING/PENDING_* → 미확정
    }
}

async function executeOrder(
    side: OrderSide,
    symbol: string,
    quantity: number,
    clientOrderId?: string,
): Promise<OrderOutcome> {
    validateOrderInputs(symbol, quantity);
    const coid = clientOrderId ?? crypto.randomUUID();

    let orderId: string;
    try {
        ({ orderId } = await issueOrder({
            symbol,
            side,
            orderType: 'MARKET',
            quantity,
            clientOrderId: coid,
        }));
    } catch (err) {
        if (err instanceof TossApiError && err.status >= 400 && err.status < 500) {
            return { orderId: '', clientOrderId: coid, status: 'rejected', rejectReason: err.code };
        }
        throw err;
    }

    let last: OrderDetail | null = null;
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
        last = await getOrder(orderId);
        const mapped = mapStatus(last.status);
        if (mapped) {
            return {
                orderId,
                clientOrderId: coid,
                status: mapped,
                filledQuantity: last.filledQuantity,
                avgFilledPrice: last.avgFilledPrice ?? undefined,
            };
        }
        if (i < POLL_ATTEMPTS - 1) await delay(POLL_INTERVAL_MS);
    }

    return {
        orderId,
        clientOrderId: coid,
        status: 'pending',
        filledQuantity: last?.filledQuantity,
        avgFilledPrice: last?.avgFilledPrice ?? undefined,
    };
}

export function executeBuyOrder(symbol: string, quantity: number, clientOrderId?: string) {
    return executeOrder('BUY', symbol, quantity, clientOrderId);
}

export function executeSellOrder(symbol: string, quantity: number, clientOrderId?: string) {
    return executeOrder('SELL', symbol, quantity, clientOrderId);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
