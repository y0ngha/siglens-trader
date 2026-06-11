// 주문 방향/유형 (요청)
export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT';

// 토스 주문 상태 (응답) — unknown code 허용 위해 string 유니온 + (string & {})
export type TossOrderStatus =
    | 'PENDING'
    | 'PENDING_CANCEL'
    | 'PENDING_REPLACE'
    | 'PARTIAL_FILLED'
    | 'FILLED'
    | 'CANCELED'
    | 'REJECTED'
    | 'CANCEL_REJECTED'
    | 'REPLACE_REJECTED'
    | 'REPLACED'
    | (string & {}); // 토스가 신규/미지정 상태코드를 반환해도 허용 (mapStatus 기본분기 → pending)

// issueOrder 입력 (저수준)
export interface IssueOrderRequest {
    symbol: string;
    side: OrderSide;
    orderType: 'MARKET'; // 본 시스템은 시장가 정수 수량만 사용
    quantity: number;
    clientOrderId: string;
}

// 파사드 반환 — 인라인 폴링까지 끝낸 정규화 결과
export interface OrderOutcome {
    orderId: string;
    clientOrderId: string;
    status: 'filled' | 'partial' | 'pending' | 'rejected' | 'canceled';
    filledQuantity?: number;
    avgFilledPrice?: number;
    rejectReason?: string;
}

// 저수준 — reconcile/폴링용 (API Order 정규화)
export interface OrderDetail {
    orderId: string;
    status: TossOrderStatus;
    filledQuantity: number;
    avgFilledPrice: number | null;
    canceledAt: string | null;
}

// HoldingsItem 정규화 (string → number)
export interface TossHolding {
    symbol: string;
    quantity: number;
    avgPrice: number;
    currentPrice: number;
    pnl: number;
    marketCountry: string;
    currency: string;
}

// OAuth2 토큰 응답 (표준 형식)
export interface OAuth2TokenResponse {
    access_token: string;
    token_type: 'Bearer';
    expires_in: number;
}
