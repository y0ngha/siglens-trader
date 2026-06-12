import { tossFetch, TossApiError } from './client.js';
import { parseDecimal } from '../validation.js';
import { delay } from './_util.js';
import type {
    IssueOrderRequest,
    OrderOutcome,
    OrderDetail,
    OrderSide,
    TossOrderStatus,
} from './types.js';

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
            // non-terminal: reconcile cron resolves partial → filled when remaining quantity clears
            return 'partial';
        case 'REJECTED':
        case 'CANCEL_REJECTED':
        case 'REPLACE_REJECTED':
            return 'rejected';
        case 'CANCELED':
            return 'canceled';
        case 'REPLACED':
            return null; // 정정으로 원주문 대체됨 — 본 시스템은 주문 정정을 안 하므로 미발생; 발생 시 reconcile가 확정
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
    if (coid.length > 36 || !/^[a-zA-Z0-9\-_]+$/.test(coid)) {
        throw new Error('clientOrderId must be <=36 chars of [a-zA-Z0-9-_]');
    }

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
        // 진짜 비즈니스 거부(잔고부족/장마감/종목제한/잘못된 주문 등)만 terminal 'rejected'.
        // 일시적/모호한 코드(rate-limit, timeout, 멱등성 충돌)는 rethrow → order-tracking 'error' 경로로.
        if (err instanceof TossApiError) {
            const transient =
                err.status === 408 ||
                err.status === 429 ||
                err.code === 'idempotency-key-conflict' ||
                err.code === 'request-in-progress';
            const isAuthError = err.status === 401 || err.status === 403;
            // 진짜 비즈니스 거부만 terminal 'rejected'; 인증/일시 오류는 rethrow → order-tracking 'error'
            if (err.status >= 400 && err.status < 500 && !transient && !isAuthError) {
                return {
                    orderId: '',
                    clientOrderId: coid,
                    status: 'rejected',
                    rejectReason: err.code,
                };
            }
        }
        throw err;
    }

    let last: OrderDetail | null = null;
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
        try {
            last = await getOrder(orderId);
        } catch {
            break; // 폴링 실패는 best-effort — 아래 pending 반환으로 떨어져 reconcile이 확정
        }
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

    // 미확정 (PENDING 지속 또는 폴링 실패) — orderId 보존, reconcile이 추후 확정
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
