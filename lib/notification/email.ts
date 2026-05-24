import { Resend } from 'resend';

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function getResend() {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY is required');
    return new Resend(apiKey);
}

const FROM = () => process.env.NOTIFICATION_EMAIL_FROM ?? 'noreply@siglens.io';
const DEFAULT_TO = 'dev.y0ngha@gmail.com';

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

export async function sendTradeExecutedEmail(trade: TradeNotification, to?: string): Promise<void> {
    const recipient = to ?? DEFAULT_TO;
    const resend = getResend();
    await resend.emails.send({
        from: FROM(),
        to: recipient,
        subject: `[Trader] ${trade.side.toUpperCase()} ${trade.symbol} — ${trade.quantity}주`,
        html: `
            <h2>${trade.side === 'buy' ? '매수' : '매도'} 체결</h2>
            <p><strong>${escapeHtml(trade.symbol)}</strong> ${trade.quantity}주 @ $${trade.price}</p>
            <p>사유: ${escapeHtml(trade.reason)}</p>
            <p>모드: ${escapeHtml(trade.mode)}</p>
        `,
    });
}

export async function sendApprovalRequestEmail(
    order: ApprovalNotification,
    to?: string,
): Promise<void> {
    const recipient = to ?? DEFAULT_TO;
    const resend = getResend();
    await resend.emails.send({
        from: FROM(),
        to: recipient,
        subject: `[Trader] 승인 요청: ${order.side.toUpperCase()} ${order.symbol}`,
        html: `
            <h2>매매 승인 요청</h2>
            <p><strong>${escapeHtml(order.symbol)}</strong> ${order.side === 'buy' ? '매수' : '매도'} ${order.quantity}주</p>
            <p>신호 점수: ${order.score}/100</p>
            <p>사유: ${escapeHtml(order.reason)}</p>
            <p><a href="${escapeHtml(order.approveUrl)}">대시보드에서 확인</a></p>
        `,
    });
}

export async function sendErrorEmail(subject: string, error: string, to?: string): Promise<void> {
    const recipient = to ?? DEFAULT_TO;
    const resend = getResend();
    await resend.emails.send({
        from: FROM(),
        to: recipient,
        subject: `[Trader] 오류: ${subject}`,
        html: `<pre>${escapeHtml(error)}</pre>`,
    });
}
