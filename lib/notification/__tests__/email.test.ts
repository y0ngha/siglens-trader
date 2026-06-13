import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSend = vi.fn().mockResolvedValue({ id: 'test-id' });

vi.mock('resend', () => ({
    Resend: vi.fn().mockImplementation(() => ({
        emails: { send: mockSend },
    })),
}));

import {
    sendTradeExecutedEmail,
    sendApprovalRequestEmail,
    sendErrorEmail,
    type TradeNotification,
    type ApprovalNotification,
} from '../email';

describe('email notification module', () => {
    beforeEach(() => {
        process.env.RESEND_API_KEY = 'test-api-key';
        mockSend.mockClear();
    });

    afterEach(() => {
        delete process.env.RESEND_API_KEY;
        delete process.env.NOTIFICATION_EMAIL_FROM;
    });

    describe('sendTradeExecutedEmail', () => {
        const baseTrade: TradeNotification = {
            symbol: 'AAPL',
            side: 'buy',
            quantity: 10,
            price: 150.5,
            reason: 'Golden cross detected',
            mode: 'auto',
        };

        it('calls resend.emails.send with correct from, to, subject, html', async () => {
            await sendTradeExecutedEmail(baseTrade);

            expect(mockSend).toHaveBeenCalledOnce();
            const call = mockSend.mock.calls[0][0];
            expect(call.from).toBe('noreply@siglens.io');
            expect(call.to).toBe('dev.y0ngha@gmail.com');
            expect(call.subject).toContain('[Trader]');
            expect(call.html).toBeDefined();
        });

        it('uses custom NOTIFICATION_EMAIL_FROM when set', async () => {
            process.env.NOTIFICATION_EMAIL_FROM = 'custom@example.com';
            await sendTradeExecutedEmail(baseTrade);

            const call = mockSend.mock.calls[0][0];
            expect(call.from).toBe('custom@example.com');
        });

        it('buy side: subject contains "BUY" and html contains "매수"', async () => {
            await sendTradeExecutedEmail({ ...baseTrade, side: 'buy' });

            const call = mockSend.mock.calls[0][0];
            expect(call.subject).toContain('BUY');
            expect(call.html).toContain('매수');
        });

        it('sell side: subject contains "SELL" and html contains "매도"', async () => {
            await sendTradeExecutedEmail({ ...baseTrade, side: 'sell' });

            const call = mockSend.mock.calls[0][0];
            expect(call.subject).toContain('SELL');
            expect(call.html).toContain('매도');
        });

        it('includes price, quantity, reason, and mode in html', async () => {
            await sendTradeExecutedEmail(baseTrade);

            const call = mockSend.mock.calls[0][0];
            expect(call.html).toContain('150.5');
            expect(call.html).toContain('10');
            expect(call.html).toContain('Golden cross detected');
            expect(call.html).toContain('auto');
        });

        it('includes symbol in subject', async () => {
            await sendTradeExecutedEmail(baseTrade);

            const call = mockSend.mock.calls[0][0];
            expect(call.subject).toContain('AAPL');
        });

        it('throws when RESEND_API_KEY is missing', async () => {
            delete process.env.RESEND_API_KEY;

            await expect(sendTradeExecutedEmail(baseTrade)).rejects.toThrow(
                'RESEND_API_KEY is required',
            );
        });
    });

    describe('escapeHtml security', () => {
        it('escapes single quotes in html body', async () => {
            await sendTradeExecutedEmail({
                symbol: "O'NEIL",
                side: 'buy',
                quantity: 1,
                price: 100,
                reason: "it's a test",
                mode: 'auto',
            });

            const call = mockSend.mock.calls[0][0];
            expect(call.html).not.toContain("O'NEIL");
            expect(call.html).toContain('&#39;');
        });
    });

    describe('sendApprovalRequestEmail', () => {
        const baseOrder: ApprovalNotification = {
            symbol: 'TSLA',
            side: 'buy',
            quantity: 5,
            score: 85,
            reason: 'Strong momentum signal',
            approveUrl: 'https://trader.siglens.io/approve/123',
        };

        it('calls resend.emails.send with correct fields', async () => {
            await sendApprovalRequestEmail(baseOrder);

            expect(mockSend).toHaveBeenCalledOnce();
            const call = mockSend.mock.calls[0][0];
            expect(call.from).toBe('noreply@siglens.io');
            expect(call.to).toBe('dev.y0ngha@gmail.com');
            expect(call.subject).toBeDefined();
            expect(call.html).toBeDefined();
        });

        it('subject includes symbol and side', async () => {
            await sendApprovalRequestEmail(baseOrder);

            const call = mockSend.mock.calls[0][0];
            expect(call.subject).toContain('TSLA');
            expect(call.subject).toContain('BUY');
        });

        it('includes score, reason, and approveUrl in html', async () => {
            await sendApprovalRequestEmail(baseOrder);

            const call = mockSend.mock.calls[0][0];
            expect(call.html).toContain('85');
            expect(call.html).toContain('Strong momentum signal');
            expect(call.html).toContain('https://trader.siglens.io/approve/123');
        });

        it('buy side html contains "매수"', async () => {
            await sendApprovalRequestEmail({ ...baseOrder, side: 'buy' });

            const call = mockSend.mock.calls[0][0];
            expect(call.html).toContain('매수');
        });

        it('sell side html contains "매도"', async () => {
            await sendApprovalRequestEmail({ ...baseOrder, side: 'sell' });

            const call = mockSend.mock.calls[0][0];
            expect(call.html).toContain('매도');
        });

        it('throws when RESEND_API_KEY is missing', async () => {
            delete process.env.RESEND_API_KEY;

            await expect(sendApprovalRequestEmail(baseOrder)).rejects.toThrow(
                'RESEND_API_KEY is required',
            );
        });

        it('omits href link when approveUrl is not https', async () => {
            await sendApprovalRequestEmail({
                ...baseOrder,
                approveUrl: 'javascript:alert(1)',
            });

            const call = mockSend.mock.calls[0][0];
            expect(call.html).not.toContain('href=');
            expect(call.html).not.toContain('javascript:');
            expect(call.html).toContain('대시보드에서 확인하세요.');
        });

        it('renders plain-text fallback and does not throw when approveUrl is null', async () => {
            await expect(
                sendApprovalRequestEmail({ ...baseOrder, approveUrl: null }),
            ).resolves.not.toThrow();

            const call = mockSend.mock.calls[0][0];
            expect(call.html).not.toContain('href=');
            expect(call.html).toContain('대시보드에서 확인하세요.');
        });

        it('renders plain-text fallback and does not throw when approveUrl is undefined', async () => {
            await expect(
                sendApprovalRequestEmail({ ...baseOrder, approveUrl: undefined }),
            ).resolves.not.toThrow();

            const call = mockSend.mock.calls[0][0];
            expect(call.html).not.toContain('href=');
            expect(call.html).toContain('대시보드에서 확인하세요.');
        });

        it('includes href link when approveUrl starts with https://', async () => {
            await sendApprovalRequestEmail(baseOrder);

            const call = mockSend.mock.calls[0][0];
            expect(call.html).toContain('href="https://trader.siglens.io/approve/123"');
        });
    });

    describe('sendErrorEmail', () => {
        it('calls resend with error wrapped in <pre>', async () => {
            await sendErrorEmail('Cron failed', 'TypeError: Cannot read property');

            expect(mockSend).toHaveBeenCalledOnce();
            const call = mockSend.mock.calls[0][0];
            expect(call.html).toBe('<pre>TypeError: Cannot read property</pre>');
        });

        it('subject includes the provided subject string', async () => {
            await sendErrorEmail('Order execution', 'Connection timeout');

            const call = mockSend.mock.calls[0][0];
            expect(call.subject).toContain('Order execution');
            expect(call.subject).toContain('[Trader] 오류:');
        });

        it('sends to correct recipient with default from', async () => {
            await sendErrorEmail('Test', 'error');

            const call = mockSend.mock.calls[0][0];
            expect(call.from).toBe('noreply@siglens.io');
            expect(call.to).toBe('dev.y0ngha@gmail.com');
        });

        it('throws when RESEND_API_KEY is missing', async () => {
            delete process.env.RESEND_API_KEY;

            await expect(sendErrorEmail('Test', 'error')).rejects.toThrow(
                'RESEND_API_KEY is required',
            );
        });
    });
});
