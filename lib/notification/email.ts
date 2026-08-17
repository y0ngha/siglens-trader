import { Resend } from 'resend';

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getResend() {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error('RESEND_API_KEY is required');
    return new Resend(apiKey);
}

/**
 * 전송 대기 상한. resend SDK는 `fetch`에 타임아웃도 signal도 걸지 않는다.
 *
 * 이 함수들은 매매 루프 안에서 `await`된다(체결 알림, 주문 실패 경보). Resend가 응답을
 * 안 주면 실행이 마감(900초)도 락 TTL(1800초)도 넘겨 살아 있고, 그 프로세스에서
 * execute는 다시 돌지 않는다 — 손절 평가가 통째로 멈춘다. 알림 하나가 매매를 멈추게
 * 두지 않는다.
 */
const SEND_TIMEOUT_MS = 10_000;

async function withSendTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(new Error(`email send timed out after ${SEND_TIMEOUT_MS}ms`)),
                SEND_TIMEOUT_MS,
            );
        }),
    ]).finally(() => clearTimeout(timer)) as Promise<T>;
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
    approveUrl: string | null | undefined;
}

// ---------------------------------------------------------------------------
// Builder functions — pure, no I/O.
// Used by both the direct-send path and the quiet-hours queue so the HTML
// is identical whether a notification fires immediately or via the digest.
// ---------------------------------------------------------------------------

export function buildTradeExecutedEmail(trade: TradeNotification): {
    subject: string;
    html: string;
} {
    return {
        subject: `[Trader] ${trade.side.toUpperCase()} ${trade.symbol} — ${trade.quantity}주`,
        html: `
            <h2>${trade.side === 'buy' ? '매수' : '매도'} 체결</h2>
            <p><strong>${escapeHtml(trade.symbol)}</strong> ${trade.quantity}주 @ $${trade.price}</p>
            <p>사유: ${escapeHtml(trade.reason)}</p>
            <p>모드: ${escapeHtml(trade.mode)}</p>
        `,
    };
}

export function buildApprovalRequestEmail(order: ApprovalNotification): {
    subject: string;
    html: string;
} {
    return {
        subject: `[Trader] 승인 요청: ${order.side.toUpperCase()} ${order.symbol}`,
        html: `
            <h2>매매 승인 요청</h2>
            <p><strong>${escapeHtml(order.symbol)}</strong> ${order.side === 'buy' ? '매수' : '매도'} ${order.quantity}주</p>
            <p>신호 점수: ${order.score}/100</p>
            <p>사유: ${escapeHtml(order.reason)}</p>
            ${order.approveUrl && order.approveUrl.startsWith('https://') ? `<p><a href="${escapeHtml(order.approveUrl)}">대시보드에서 확인</a></p>` : '<p>대시보드에서 확인하세요.</p>'}
        `,
    };
}

export function buildErrorEmail(subject: string, error: string): { subject: string; html: string } {
    return {
        subject: `[Trader] 오류: ${subject}`,
        html: `<pre>${escapeHtml(error)}</pre>`,
    };
}

/**
 * Cron health alert — sent by the digest when the night was quiet but something
 * about the system is not. Deliberately plain: it exists to be noticed, not read.
 */
export function buildCronHealthEmail(lines: readonly string[]): {
    subject: string;
    html: string;
} {
    const items = lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('');
    return {
        subject: '[Trader] 시스템 이상 감지',
        html:
            `<p>알림으로 보낼 거래 이벤트는 없었지만, 크론 상태에서 이상이 발견됐습니다.</p>` +
            `<ul>${items}</ul>` +
            `<p>대시보드의 감사(Audit) 탭에서 크론 실행 이력을 확인하세요.</p>`,
    };
}

// ---------------------------------------------------------------------------
// Send functions — call the corresponding builder then deliver via Resend.
// ---------------------------------------------------------------------------

export async function sendTradeExecutedEmail(trade: TradeNotification, to?: string): Promise<void> {
    const recipient = to ?? DEFAULT_TO;
    const resend = getResend();
    const { subject, html } = buildTradeExecutedEmail(trade);
    await withSendTimeout(resend.emails.send({ from: FROM(), to: recipient, subject, html }));
}

export async function sendApprovalRequestEmail(
    order: ApprovalNotification,
    to?: string,
): Promise<void> {
    const recipient = to ?? DEFAULT_TO;
    const resend = getResend();
    const { subject, html } = buildApprovalRequestEmail(order);
    await withSendTimeout(resend.emails.send({ from: FROM(), to: recipient, subject, html }));
}

export async function sendErrorEmail(subject: string, error: string, to?: string): Promise<void> {
    const recipient = to ?? DEFAULT_TO;
    const resend = getResend();
    const { subject: emailSubject, html } = buildErrorEmail(subject, error);
    await withSendTimeout(
        resend.emails.send({ from: FROM(), to: recipient, subject: emailSubject, html }),
    );
}

export async function sendCronHealthEmail(lines: readonly string[], to?: string): Promise<void> {
    const recipient = to ?? DEFAULT_TO;
    const resend = getResend();
    const { subject, html } = buildCronHealthEmail(lines);
    await withSendTimeout(resend.emails.send({ from: FROM(), to: recipient, subject, html }));
}

// ---------------------------------------------------------------------------
// Digest email — composes a single summary from queued notification rows.
// ---------------------------------------------------------------------------

export interface DigestRow {
    subject: string;
    html: string;
    kind: string;
    createdAt: Date;
}

export function buildDigestEmail(rows: DigestRow[]): { subject: string; html: string } {
    const subject = `[Trader] 야간 알림 요약 (${rows.length}건)`;
    const sections = rows
        .map(
            (r) => `
        <section style="border-top:1px solid #eee;padding:12px 0">
          <p style="margin:0 0 4px;font-weight:bold;font-size:13px;color:#666">${escapeHtml(r.kind)} · ${escapeHtml(r.createdAt.toISOString())}</p>
          <p style="margin:0 0 8px;font-weight:bold">${escapeHtml(r.subject)}</p>
          <div>${r.html}</div>
        </section>`,
        )
        .join('');
    const html = `
        <h2>야간 알림 요약 — ${rows.length}건</h2>
        <p>조용한 시간(00:00–09:59 KST) 동안 수신된 알림입니다.</p>
        ${sections}
    `;
    return { subject, html };
}

export async function sendDigestEmail(rows: DigestRow[], to?: string): Promise<void> {
    const recipient = to ?? DEFAULT_TO;
    const resend = getResend();
    const { subject, html } = buildDigestEmail(rows);
    await withSendTimeout(resend.emails.send({ from: FROM(), to: recipient, subject, html }));
}
