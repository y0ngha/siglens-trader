import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET as handler } from '../digest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockVerifyCronSecret = vi.fn<(req: Request) => boolean>();
vi.mock('../../_lib/cron-auth', () => ({
    verifyCronSecret: (...args: [Request]) => mockVerifyCronSecret(...args),
}));

const fakeDb = { __db: true };
vi.mock('../../_lib/db', () => ({
    getDb: () => fakeDb,
}));

const mockAcquireLock = vi.fn<() => Promise<string | null>>();
const mockReleaseLock = vi.fn<() => Promise<void>>();
vi.mock('../../../lib/lock', () => ({
    acquireLock: (...args: unknown[]) => mockAcquireLock(...(args as [])),
    releaseLock: (...args: unknown[]) => mockReleaseLock(...(args as [])),
}));

const mockGetCronRuns = vi.fn();
const mockGetPendingNotifications = vi.fn();
const mockMarkNotificationsSent = vi.fn();
const mockGetNotificationConfig = vi.fn();
const mockStartCronRun = vi.fn();
const mockFinishCronRun = vi.fn();
const mockFinalizeStaleCronRuns = vi.fn();
vi.mock('../../../lib/db/queries', () => ({
    getCronRuns: (...args: unknown[]) => mockGetCronRuns(...args),
    getPendingNotifications: (...args: unknown[]) => mockGetPendingNotifications(...args),
    markNotificationsSent: (...args: unknown[]) => mockMarkNotificationsSent(...args),
    getNotificationConfig: (...args: unknown[]) => mockGetNotificationConfig(...args),
    startCronRun: (...args: unknown[]) => mockStartCronRun(...args),
    finishCronRun: (...args: unknown[]) => mockFinishCronRun(...args),
    finalizeStaleCronRuns: (...args: unknown[]) => mockFinalizeStaleCronRuns(...args),
}));

const mockSendDigestEmail = vi.fn();
const mockSendCronHealthEmail = vi.fn();
vi.mock('../../../lib/notification/email', () => ({
    sendDigestEmail: (...args: unknown[]) => mockSendDigestEmail(...args),
    sendCronHealthEmail: (...args: unknown[]) => mockSendCronHealthEmail(...args),
}));

const makeRequest = () => new Request('https://example.com/api/cron/digest');

const queued = [
    {
        id: 1,
        kind: 'trade_executed',
        subject: '[Trader] BUY NVDA',
        html: '<p>a</p>',
        createdAt: new Date('2026-08-11T16:07:00Z'),
    },
    {
        id: 2,
        kind: 'error',
        subject: '[Trader] 주문 실패',
        html: '<p>b</p>',
        createdAt: new Date('2026-08-11T18:20:00Z'),
    },
];

describe('digest cron', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockVerifyCronSecret.mockReturnValue(true);
        mockAcquireLock.mockResolvedValue('lock-token');
        mockReleaseLock.mockResolvedValue(undefined);
        mockGetPendingNotifications.mockResolvedValue([]);
        mockMarkNotificationsSent.mockResolvedValue(undefined);
        mockGetNotificationConfig.mockResolvedValue([
            {
                channel: 'email',
                enabled: true,
                target: 'ops@example.com',
                events: ['trade_executed', 'error'],
            },
        ]);
        mockSendDigestEmail.mockResolvedValue(undefined);
        mockSendCronHealthEmail.mockResolvedValue(undefined);
        mockGetCronRuns.mockResolvedValue([
            { cronType: 'technical', status: 'completed', startedAt: new Date() },
        ]);
        mockStartCronRun.mockResolvedValue(undefined);
        mockFinishCronRun.mockResolvedValue(undefined);
        mockFinalizeStaleCronRuns.mockResolvedValue(undefined);
    });

    it('rejects a request without the cron secret', async () => {
        mockVerifyCronSecret.mockReturnValue(false);

        const res = await handler(makeRequest());

        expect(res.status).toBe(401);
        expect(mockSendDigestEmail).not.toHaveBeenCalled();
    });

    it('sends nothing when the queue is empty', async () => {
        const res = await handler(makeRequest());
        const body = await res.json();

        expect(body).toEqual({ skipped: true, reason: 'queue_empty' });
        expect(mockSendDigestEmail).not.toHaveBeenCalled();
        expect(mockMarkNotificationsSent).not.toHaveBeenCalled();
    });

    it('sends one digest covering every pending row, then marks exactly those ids', async () => {
        mockGetPendingNotifications.mockResolvedValue(queued);

        const res = await handler(makeRequest());
        const body = await res.json();

        expect(body).toEqual({ sent: 2 });
        expect(mockSendDigestEmail).toHaveBeenCalledTimes(1);

        const [rows, to] = mockSendDigestEmail.mock.calls[0];
        expect(rows).toHaveLength(2);
        expect(rows.map((r: { subject: string }) => r.subject)).toEqual([
            '[Trader] BUY NVDA',
            '[Trader] 주문 실패',
        ]);
        // The configured recipient wins over the hardcoded fallback.
        expect(to).toBe('ops@example.com');

        expect(mockMarkNotificationsSent).toHaveBeenCalledWith(fakeDb, [1, 2]);
    });

    it('leaves rows unsent when the send throws, so the next run retries', async () => {
        mockGetPendingNotifications.mockResolvedValue(queued);
        mockSendDigestEmail.mockRejectedValue(new Error('resend 500'));

        await expect(handler(makeRequest())).rejects.toThrow('resend 500');

        expect(mockMarkNotificationsSent).not.toHaveBeenCalled();
    });

    it('drains the queue without sending when email is disabled', async () => {
        // Otherwise a disabled channel would let the queue grow without bound.
        mockGetPendingNotifications.mockResolvedValue(queued);
        mockGetNotificationConfig.mockResolvedValue([
            { channel: 'email', enabled: false, target: 'ops@example.com', events: [] },
        ]);

        const res = await handler(makeRequest());
        const body = await res.json();

        expect(body).toEqual({ drained: 2, emailEnabled: false });
        expect(mockSendDigestEmail).not.toHaveBeenCalled();
        expect(mockMarkNotificationsSent).toHaveBeenCalledWith(fakeDb, [1, 2]);
    });

    it('does nothing when the lock is held by another invocation', async () => {
        mockGetPendingNotifications.mockResolvedValue(queued);
        mockAcquireLock.mockResolvedValue(null);

        const res = await handler(makeRequest());
        const body = await res.json();

        expect(body).toEqual({ skipped: true, reason: 'locked' });
        expect(mockSendDigestEmail).not.toHaveBeenCalled();
        expect(mockMarkNotificationsSent).not.toHaveBeenCalled();
    });

    it('records a cron-run audit row for the invocation', async () => {
        mockGetPendingNotifications.mockResolvedValue(queued);

        await handler(makeRequest());

        expect(mockStartCronRun).toHaveBeenCalledWith(
            fakeDb,
            expect.objectContaining({ cronType: 'digest' }),
        );
        expect(mockFinishCronRun).toHaveBeenCalledWith(
            fakeDb,
            expect.stringMatching(/^digest-/),
            expect.objectContaining({ status: 'completed' }),
        );
    });

    // -----------------------------------------------------------------------
    // Cron health alert — closes the "silence means nothing happened OR the
    // system is dead" blind spot without sending a mail every quiet morning.
    // -----------------------------------------------------------------------

    describe('cron health alert', () => {
        const withHealthEvent = (events: string[]) =>
            mockGetNotificationConfig.mockResolvedValue([
                { channel: 'email', enabled: true, target: 'ops@example.com', events },
            ]);

        it('stays silent on an empty queue when the crons are healthy', async () => {
            withHealthEvent(['trade_executed', 'cron_health']);

            const res = await handler(makeRequest());

            expect(await res.json()).toEqual({ skipped: true, reason: 'queue_empty' });
            expect(mockSendCronHealthEmail).not.toHaveBeenCalled();
        });

        it('alerts when recent runs failed', async () => {
            withHealthEvent(['cron_health']);
            mockGetCronRuns.mockResolvedValue([
                { cronType: 'execute', status: 'error', startedAt: new Date() },
            ]);

            const res = await handler(makeRequest());

            expect(mockSendCronHealthEmail).toHaveBeenCalledTimes(1);
            const [lines, to] = mockSendCronHealthEmail.mock.calls[0];
            expect(lines[0]).toContain('execute');
            expect(to).toBe('ops@example.com');
            expect((await res.json()).healthAlert).toHaveLength(1);
        });

        it('alerts when the crons have gone silent', async () => {
            withHealthEvent(['cron_health']);
            mockGetCronRuns.mockResolvedValue([]);

            await handler(makeRequest());

            expect(mockSendCronHealthEmail).toHaveBeenCalledTimes(1);
        });

        it('respects the cron_health checkbox being off', async () => {
            withHealthEvent(['trade_executed']);
            mockGetCronRuns.mockResolvedValue([]);

            await handler(makeRequest());

            expect(mockSendCronHealthEmail).not.toHaveBeenCalled();
            expect(mockGetCronRuns).not.toHaveBeenCalled();
        });

        it('respects the master email switch being off', async () => {
            mockGetNotificationConfig.mockResolvedValue([
                {
                    channel: 'email',
                    enabled: false,
                    target: 'ops@example.com',
                    events: ['cron_health'],
                },
            ]);
            mockGetCronRuns.mockResolvedValue([]);

            await handler(makeRequest());

            expect(mockSendCronHealthEmail).not.toHaveBeenCalled();
        });

        it('never lets a failing health check break the digest', async () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            withHealthEvent(['cron_health']);
            mockGetCronRuns.mockRejectedValue(new Error('connection refused'));

            const res = await handler(makeRequest());

            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ skipped: true, reason: 'queue_empty' });
            errorSpy.mockRestore();
        });

        it('does not run the health check when there are notifications to send', async () => {
            withHealthEvent(['cron_health']);
            mockGetPendingNotifications.mockResolvedValue(queued);

            await handler(makeRequest());

            expect(mockSendDigestEmail).toHaveBeenCalledTimes(1);
            expect(mockSendCronHealthEmail).not.toHaveBeenCalled();
        });
    });
});
