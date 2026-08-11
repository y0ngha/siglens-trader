import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSendTradeExecutedEmail = vi.fn().mockResolvedValue(undefined);
const mockSendApprovalRequestEmail = vi.fn().mockResolvedValue(undefined);
const mockSendErrorEmail = vi.fn().mockResolvedValue(undefined);
const mockBuildTradeExecutedEmail = vi.fn().mockReturnValue({
    subject: 'trade subject',
    html: '<p>trade</p>',
});
const mockBuildApprovalRequestEmail = vi.fn().mockReturnValue({
    subject: 'approval subject',
    html: '<p>approval</p>',
});
const mockBuildErrorEmail = vi.fn().mockReturnValue({
    subject: 'error subject',
    html: '<pre>error</pre>',
});

vi.mock('../email', () => ({
    sendTradeExecutedEmail: (...args: unknown[]) => mockSendTradeExecutedEmail(...args),
    sendApprovalRequestEmail: (...args: unknown[]) => mockSendApprovalRequestEmail(...args),
    sendErrorEmail: (...args: unknown[]) => mockSendErrorEmail(...args),
    buildTradeExecutedEmail: (...args: unknown[]) => mockBuildTradeExecutedEmail(...args),
    buildApprovalRequestEmail: (...args: unknown[]) => mockBuildApprovalRequestEmail(...args),
    buildErrorEmail: (...args: unknown[]) => mockBuildErrorEmail(...args),
}));

const mockIsQuietHours = vi.fn<(d: Date) => boolean>();
vi.mock('../quiet-hours', () => ({
    isQuietHours: (d: Date) => mockIsQuietHours(d),
}));

import { createEmailDispatcher } from '../dispatch';
import type { EmailGate } from '../gate';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tradePayload = {
    symbol: 'AAPL',
    side: 'buy',
    quantity: 5,
    price: 150,
    reason: 'buy signal',
    mode: 'auto',
};

const approvalPayload = {
    symbol: 'TSLA',
    side: 'buy',
    quantity: 3,
    score: 80,
    reason: 'signal',
    approveUrl: 'https://example.com/approve',
};

function makeGate(enabled: boolean, events: string[]): EmailGate {
    const set = new Set(events);
    return (...keys) => enabled && keys.some((k) => set.has(k));
}

const mockEnqueue =
    vi.fn<(row: { kind: string; subject: string; html: string }) => Promise<void>>();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createEmailDispatcher', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockEnqueue.mockResolvedValue(undefined);
        mockIsQuietHours.mockReturnValue(false);
    });

    // -------------------------------------------------------------------------
    // Gate off — nothing happens
    // -------------------------------------------------------------------------

    describe('gate off', () => {
        it('notifyTradeExecuted: gate off → neither sends nor enqueues', async () => {
            const gate = makeGate(false, ['trade_executed']);
            const d = createEmailDispatcher({ gate, to: 'a@b.com', enqueue: mockEnqueue });

            await d.notifyTradeExecuted(tradePayload);

            expect(mockSendTradeExecutedEmail).not.toHaveBeenCalled();
            expect(mockEnqueue).not.toHaveBeenCalled();
        });

        it('notifyApprovalRequest: gate off → neither sends nor enqueues', async () => {
            const gate = makeGate(false, ['order_pending']);
            const d = createEmailDispatcher({ gate, to: 'a@b.com', enqueue: mockEnqueue });

            await d.notifyApprovalRequest(approvalPayload);

            expect(mockSendApprovalRequestEmail).not.toHaveBeenCalled();
            expect(mockEnqueue).not.toHaveBeenCalled();
        });

        it('notifyError: gate off → neither sends nor enqueues', async () => {
            const gate = makeGate(false, ['error']);
            const d = createEmailDispatcher({ gate, to: 'a@b.com', enqueue: mockEnqueue });

            await d.notifyError('oops', 'details');

            expect(mockSendErrorEmail).not.toHaveBeenCalled();
            expect(mockEnqueue).not.toHaveBeenCalled();
        });

        it('gate on but wrong event → neither sends nor enqueues', async () => {
            const gate = makeGate(true, ['error']); // trade_executed NOT in events
            const d = createEmailDispatcher({ gate, to: 'a@b.com', enqueue: mockEnqueue });

            await d.notifyTradeExecuted(tradePayload);

            expect(mockSendTradeExecutedEmail).not.toHaveBeenCalled();
            expect(mockEnqueue).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // Gate on + quiet hours → enqueue, no immediate send
    // -------------------------------------------------------------------------

    describe('gate on + quiet hours', () => {
        beforeEach(() => {
            mockIsQuietHours.mockReturnValue(true);
        });

        it('notifyTradeExecuted: enqueues with kind=trade_executed and correct subject', async () => {
            const gate = makeGate(true, ['trade_executed']);
            const d = createEmailDispatcher({ gate, to: 'a@b.com', enqueue: mockEnqueue });

            await d.notifyTradeExecuted(tradePayload);

            expect(mockSendTradeExecutedEmail).not.toHaveBeenCalled();
            expect(mockEnqueue).toHaveBeenCalledOnce();
            expect(mockEnqueue).toHaveBeenCalledWith({
                kind: 'trade_executed',
                subject: 'trade subject',
                html: '<p>trade</p>',
            });
        });

        it('notifyTradeExecuted with stop_loss key: enqueues with kind=stop_loss', async () => {
            const gate = makeGate(true, ['stop_loss']);
            const d = createEmailDispatcher({ gate, to: 'a@b.com', enqueue: mockEnqueue });

            await d.notifyTradeExecuted(tradePayload, 'stop_loss');

            expect(mockEnqueue).toHaveBeenCalledWith(
                expect.objectContaining({ kind: 'stop_loss' }),
            );
            expect(mockSendTradeExecutedEmail).not.toHaveBeenCalled();
        });

        it('notifyApprovalRequest: enqueues with kind=order_pending', async () => {
            const gate = makeGate(true, ['order_pending']);
            const d = createEmailDispatcher({ gate, to: 'a@b.com', enqueue: mockEnqueue });

            await d.notifyApprovalRequest(approvalPayload);

            expect(mockSendApprovalRequestEmail).not.toHaveBeenCalled();
            expect(mockEnqueue).toHaveBeenCalledWith({
                kind: 'order_pending',
                subject: 'approval subject',
                html: '<p>approval</p>',
            });
        });

        it('notifyError: enqueues with kind=error', async () => {
            const gate = makeGate(true, ['error']);
            const d = createEmailDispatcher({ gate, to: 'a@b.com', enqueue: mockEnqueue });

            await d.notifyError('oops', 'details');

            expect(mockSendErrorEmail).not.toHaveBeenCalled();
            expect(mockEnqueue).toHaveBeenCalledWith({
                kind: 'error',
                subject: 'error subject',
                html: '<pre>error</pre>',
            });
        });
    });

    // -------------------------------------------------------------------------
    // Gate on + NOT quiet hours → sends immediately, no enqueue
    // -------------------------------------------------------------------------

    describe('gate on + not quiet hours', () => {
        it('notifyTradeExecuted: sends via sendTradeExecutedEmail, no enqueue', async () => {
            const gate = makeGate(true, ['trade_executed']);
            const d = createEmailDispatcher({ gate, to: 'ops@example.com', enqueue: mockEnqueue });

            await d.notifyTradeExecuted(tradePayload);

            expect(mockSendTradeExecutedEmail).toHaveBeenCalledOnce();
            expect(mockEnqueue).not.toHaveBeenCalled();
        });

        it('notifyApprovalRequest: sends via sendApprovalRequestEmail, no enqueue', async () => {
            const gate = makeGate(true, ['order_pending']);
            const d = createEmailDispatcher({ gate, to: 'ops@example.com', enqueue: mockEnqueue });

            await d.notifyApprovalRequest(approvalPayload);

            expect(mockSendApprovalRequestEmail).toHaveBeenCalledOnce();
            expect(mockEnqueue).not.toHaveBeenCalled();
        });

        it('notifyError: sends via sendErrorEmail, no enqueue', async () => {
            const gate = makeGate(true, ['error']);
            const d = createEmailDispatcher({ gate, to: 'ops@example.com', enqueue: mockEnqueue });

            await d.notifyError('oops', 'details');

            expect(mockSendErrorEmail).toHaveBeenCalledOnce();
            expect(mockEnqueue).not.toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // `to` is forwarded to the send function
    // -------------------------------------------------------------------------

    describe('to forwarding', () => {
        it('notifyTradeExecuted forwards configured to to sendTradeExecutedEmail', async () => {
            const gate = makeGate(true, ['trade_executed']);
            const d = createEmailDispatcher({ gate, to: 'ops@example.com', enqueue: mockEnqueue });

            await d.notifyTradeExecuted(tradePayload);

            expect(mockSendTradeExecutedEmail).toHaveBeenCalledWith(
                tradePayload,
                'ops@example.com',
            );
        });

        it('notifyApprovalRequest forwards configured to to sendApprovalRequestEmail', async () => {
            const gate = makeGate(true, ['order_pending']);
            const d = createEmailDispatcher({ gate, to: 'ops@example.com', enqueue: mockEnqueue });

            await d.notifyApprovalRequest(approvalPayload);

            expect(mockSendApprovalRequestEmail).toHaveBeenCalledWith(
                approvalPayload,
                'ops@example.com',
            );
        });

        it('notifyError forwards configured to to sendErrorEmail', async () => {
            const gate = makeGate(true, ['error']);
            const d = createEmailDispatcher({ gate, to: 'ops@example.com', enqueue: mockEnqueue });

            await d.notifyError('oops', 'details');

            expect(mockSendErrorEmail).toHaveBeenCalledWith('oops', 'details', 'ops@example.com');
        });

        it('passes undefined to when to is undefined (email module falls back to DEFAULT_TO)', async () => {
            const gate = makeGate(true, ['error']);
            const d = createEmailDispatcher({ gate, to: undefined, enqueue: mockEnqueue });

            await d.notifyError('oops', 'details');

            expect(mockSendErrorEmail).toHaveBeenCalledWith('oops', 'details', undefined);
        });
    });

    // -------------------------------------------------------------------------
    // Legacy alias: 'approval_required' also opens the order_pending gate
    // -------------------------------------------------------------------------

    describe('legacy alias support', () => {
        it('notifyApprovalRequest passes when config has approval_required instead of order_pending', async () => {
            const gate = makeGate(true, ['approval_required']);
            const d = createEmailDispatcher({ gate, to: 'a@b.com', enqueue: mockEnqueue });

            await d.notifyApprovalRequest(approvalPayload);

            expect(mockSendApprovalRequestEmail).toHaveBeenCalledOnce();
        });
    });

    // -------------------------------------------------------------------------
    // now() is injectable (for deterministic tests)
    // -------------------------------------------------------------------------

    describe('now() injection', () => {
        it('uses the injected clock for the quiet-hours decision', async () => {
            const fixedNow = new Date('2026-08-11T15:00:00.000Z'); // 00:00 KST → quiet
            // But mockIsQuietHours is already controlling the output, so just verify
            // that the injected now is what gets passed to isQuietHours.
            const gate = makeGate(true, ['trade_executed']);
            const d = createEmailDispatcher({
                gate,
                to: 'a@b.com',
                enqueue: mockEnqueue,
                now: () => fixedNow,
            });

            mockIsQuietHours.mockReturnValue(true);
            await d.notifyTradeExecuted(tradePayload);

            expect(mockIsQuietHours).toHaveBeenCalledWith(fixedNow);
        });
    });
});
