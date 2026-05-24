import { Resend } from 'resend';

function getResend() {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY is required');
    return new Resend(apiKey);
}

const FROM = () => process.env.NOTIFICATION_EMAIL_FROM ?? 'noreply@siglens.io';
const TO = 'dev.y0ngha@gmail.com';

export interface TradeNotification {
    symbol: string;
    side: string;
    quantity: number;
    price: number;
    reason: string;
    mode: string;
}

export interface ApprovalNotification {
    symbol: string;
    side: string;
    quantity: number;
    score: number;
    reason: string;
    approveUrl: string;
}

export async function sendTradeExecutedEmail(trade: TradeNotification): Promise<void> {
    const resend = getResend();
    await resend.emails.send({
        from: FROM(),
        to: TO,
        subject: `[Trader] ${trade.side.toUpperCase()} ${trade.symbol} — ${trade.quantity}주`,
        html: `
            <h2>${trade.side === 'buy' ? '매수' : '매도'} 체결</h2>
            <p><strong>${trade.symbol}</strong> ${trade.quantity}주 @ $${trade.price}</p>
            <p>사유: ${trade.reason}</p>
            <p>모드: ${trade.mode}</p>
        `,
    });
}

export async function sendApprovalRequestEmail(order: ApprovalNotification): Promise<void> {
    const resend = getResend();
    await resend.emails.send({
        from: FROM(),
        to: TO,
        subject: `[Trader] 승인 요청: ${order.side.toUpperCase()} ${order.symbol}`,
        html: `
            <h2>매매 승인 요청</h2>
            <p><strong>${order.symbol}</strong> ${order.side === 'buy' ? '매수' : '매도'} ${order.quantity}주</p>
            <p>신호 점수: ${order.score}/100</p>
            <p>사유: ${order.reason}</p>
            <p><a href="${order.approveUrl}">대시보드에서 확인</a></p>
        `,
    });
}

export async function sendErrorEmail(subject: string, error: string): Promise<void> {
    const resend = getResend();
    await resend.emails.send({
        from: FROM(),
        to: TO,
        subject: `[Trader] 오류: ${subject}`,
        html: `<pre>${error}</pre>`,
    });
}
