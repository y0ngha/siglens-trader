export interface TossOrderRequest {
    symbol: string;
    side: 'buy' | 'sell';
    orderType: 'market' | 'limit';
    quantity: number;
    price?: number;
}

export interface TossOrderResponse {
    orderId: string;
    status: 'submitted' | 'filled' | 'rejected';
    filledPrice?: number;
    filledQuantity?: number;
    message?: string;
}

export interface TossBalance {
    symbol: string;
    quantity: number;
    avgPrice: number;
    currentPrice: number;
    pnl: number;
}
