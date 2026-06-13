import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CronRunsPage } from '../CronRuns';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
    api: {
        getCronRuns: vi.fn(),
        getCronDecisions: vi.fn(),
    },
}));

const mockedApi = vi.mocked(api);

function renderWithQuery(component: React.ReactElement) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(<QueryClientProvider client={queryClient}>{component}</QueryClientProvider>);
}

const mockRuns = [
    {
        id: 1,
        runId: 'run-abc-1',
        cronType: 'execute',
        status: 'completed',
        outcome: 'COMPLETED',
        startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        finishedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
        durationMs: 12345,
        summary: { symbolsEvaluated: 3, decisionsByAction: { buy: 1, hold: 2 } },
        error: null,
        createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    },
    {
        id: 2,
        runId: 'run-abc-2',
        cronType: 'technical',
        status: 'skipped',
        outcome: 'MARKET_CLOSED',
        startedAt: new Date(Date.now() - 65 * 60_000).toISOString(),
        finishedAt: new Date(Date.now() - 64 * 60_000).toISOString(),
        durationMs: 85,
        summary: { saved: 4, processed: 5 },
        error: null,
        createdAt: new Date(Date.now() - 65 * 60_000).toISOString(),
    },
    {
        id: 3,
        runId: 'run-abc-3',
        cronType: 'reconcile',
        status: 'error',
        outcome: null,
        startedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
        finishedAt: null,
        durationMs: null,
        summary: { processed: 10, consistencyAlerts: 2 },
        error: 'DB timeout',
        createdAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    },
];

const mockDecisions = [
    {
        id: 101,
        runId: 'run-abc-1',
        cronType: 'execute',
        symbol: 'AAPL',
        action: 'buy',
        executed: true,
        score: '78.5',
        reason: 'RSI oversold + technical breakout signal detected',
        detail: {},
        createdAt: new Date().toISOString(),
    },
    {
        id: 102,
        runId: 'run-abc-1',
        cronType: 'execute',
        symbol: 'TSLA',
        action: 'hold',
        executed: false,
        score: '52.0',
        reason: null,
        detail: {},
        createdAt: new Date().toISOString(),
    },
];

describe('CronRunsPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // ─── loading state ──────────────────────────────────────────────────────

    it('shows loading skeleton initially', () => {
        mockedApi.getCronRuns.mockReturnValue(new Promise(() => {}));
        renderWithQuery(<CronRunsPage />);
        expect(screen.getByLabelText('로딩 중')).toBeInTheDocument();
    });

    // ─── data display ───────────────────────────────────────────────────────

    it('renders cron runs with type, outcome, duration and summary', async () => {
        mockedApi.getCronRuns.mockResolvedValue({ runs: mockRuns });

        renderWithQuery(<CronRunsPage />);

        // Wait for data to load — the run list renders after loading resolves
        await waitFor(() => {
            expect(screen.getByText('COMPLETED')).toBeInTheDocument();
        });

        // outcome tags
        expect(screen.getByText('MARKET_CLOSED')).toBeInTheDocument();
        // outcome fallback to status
        expect(screen.getByText('error')).toBeInTheDocument();
        // duration
        expect(screen.getByText('12.3s')).toBeInTheDocument();
        expect(screen.getByText('85ms')).toBeInTheDocument();
        // null duration
        expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
        // summary: execute
        expect(screen.getByText(/3종목/)).toBeInTheDocument();
        // summary: technical
        expect(screen.getByText(/4\/5 분석/)).toBeInTheDocument();
        // summary: reconcile
        expect(screen.getByText(/처리 10/)).toBeInTheDocument();
    });

    it('displays run count in header', async () => {
        mockedApi.getCronRuns.mockResolvedValue({ runs: mockRuns });

        renderWithQuery(<CronRunsPage />);

        await waitFor(() => {
            expect(screen.getByText('3건')).toBeInTheDocument();
        });
    });

    // ─── type filter ────────────────────────────────────────────────────────

    it('renders cron type filter group', async () => {
        mockedApi.getCronRuns.mockResolvedValue({ runs: [] });

        renderWithQuery(<CronRunsPage />);

        await waitFor(() => {
            expect(screen.getByRole('group', { name: '크론 유형 필터' })).toBeInTheDocument();
        });

        const typeGroup = screen.getByRole('group', { name: '크론 유형 필터' });
        expect(within(typeGroup).getByRole('button', { name: '전체' })).toBeInTheDocument();
        expect(within(typeGroup).getByRole('button', { name: '기술' })).toBeInTheDocument();
        expect(within(typeGroup).getByRole('button', { name: '뉴스' })).toBeInTheDocument();
        expect(within(typeGroup).getByRole('button', { name: '옵션' })).toBeInTheDocument();
        expect(within(typeGroup).getByRole('button', { name: '펀더멘털' })).toBeInTheDocument();
    });

    it('calls api.getCronRuns with type when type filter is clicked', async () => {
        const user = userEvent.setup();
        mockedApi.getCronRuns.mockResolvedValue({ runs: [] });

        renderWithQuery(<CronRunsPage />);

        await waitFor(() => {
            expect(screen.getByRole('button', { name: '실행' })).toBeInTheDocument();
        });

        await user.click(screen.getByRole('button', { name: '실행' }));

        await waitFor(() => {
            const lastCall = mockedApi.getCronRuns.mock.calls.at(-1);
            expect(lastCall?.[0]).toMatchObject({ type: 'execute' });
        });
    });

    it('calls api.getCronRuns without type when 전체 type filter is selected', async () => {
        const user = userEvent.setup();
        mockedApi.getCronRuns.mockResolvedValue({ runs: [] });

        renderWithQuery(<CronRunsPage />);

        await waitFor(() => {
            expect(screen.getByRole('button', { name: '뉴스' })).toBeInTheDocument();
        });

        const typeGroup = screen.getByRole('group', { name: '크론 유형 필터' });

        // Select news first
        await user.click(screen.getByRole('button', { name: '뉴스' }));

        await waitFor(() => {
            const lastCall = mockedApi.getCronRuns.mock.calls.at(-1);
            expect(lastCall?.[0]).toMatchObject({ type: 'news' });
        });

        // Then back to 전체 within the type group to disambiguate from status 전체
        await user.click(within(typeGroup).getByRole('button', { name: '전체' }));

        await waitFor(() => {
            const lastCall = mockedApi.getCronRuns.mock.calls.at(-1);
            // type should be absent or undefined when all types selected
            expect(lastCall?.[0]?.type).toBeUndefined();
        });
    });

    // ─── status filter ──────────────────────────────────────────────────────

    it('renders status filter group', async () => {
        mockedApi.getCronRuns.mockResolvedValue({ runs: [] });

        renderWithQuery(<CronRunsPage />);

        await waitFor(() => {
            expect(screen.getByRole('group', { name: '상태 필터' })).toBeInTheDocument();
        });

        expect(screen.getByRole('button', { name: '완료' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '스킵' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '에러' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '실행중' })).toBeInTheDocument();
    });

    it('calls api.getCronRuns with status when status filter is clicked', async () => {
        const user = userEvent.setup();
        mockedApi.getCronRuns.mockResolvedValue({ runs: [] });

        renderWithQuery(<CronRunsPage />);

        await waitFor(() => {
            expect(screen.getByRole('button', { name: '에러' })).toBeInTheDocument();
        });

        await user.click(screen.getByRole('button', { name: '에러' }));

        await waitFor(() => {
            const lastCall = mockedApi.getCronRuns.mock.calls.at(-1);
            expect(lastCall?.[0]).toMatchObject({ status: 'error' });
        });
    });

    // ─── date preset ────────────────────────────────────────────────────────

    it('renders date preset filter group with 7일 selected by default', async () => {
        mockedApi.getCronRuns.mockResolvedValue({ runs: [] });

        renderWithQuery(<CronRunsPage />);

        await waitFor(() => {
            expect(screen.getByRole('group', { name: '기간 필터' })).toBeInTheDocument();
        });

        const btn7d = screen.getByRole('button', { name: '7일' });
        expect(btn7d).toHaveAttribute('aria-pressed', 'true');
    });

    // ─── expand row → decisions ─────────────────────────────────────────────

    it('fetches and shows decisions when a row is expanded', async () => {
        const user = userEvent.setup();
        mockedApi.getCronRuns.mockResolvedValue({ runs: [mockRuns[0]] });
        mockedApi.getCronDecisions.mockResolvedValue({ decisions: mockDecisions });

        renderWithQuery(<CronRunsPage />);

        await waitFor(() => {
            expect(screen.getByText('COMPLETED')).toBeInTheDocument();
        });

        // Row is a button with aria-expanded=false
        const rowBtn = screen.getByRole('button', { expanded: false });
        await user.click(rowBtn);

        await waitFor(() => {
            expect(mockedApi.getCronDecisions).toHaveBeenCalledWith('run-abc-1', expect.anything());
        });

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });

        expect(screen.getByText('TSLA')).toBeInTheDocument();
        expect(screen.getByText('buy')).toBeInTheDocument();
        expect(screen.getByText('hold')).toBeInTheDocument();
        // EXEC badge for executed decision
        expect(screen.getByText('EXEC')).toBeInTheDocument();
        // reason shown
        expect(screen.getByText(/RSI oversold/)).toBeInTheDocument();
    });

    it('shows empty decisions message when decisions array is empty', async () => {
        const user = userEvent.setup();
        mockedApi.getCronRuns.mockResolvedValue({ runs: [mockRuns[1]] });
        mockedApi.getCronDecisions.mockResolvedValue({ decisions: [] });

        renderWithQuery(<CronRunsPage />);

        await waitFor(() => {
            expect(screen.getByText('MARKET_CLOSED')).toBeInTheDocument();
        });

        const rowBtn = screen.getByRole('button', { expanded: false });
        await user.click(rowBtn);

        await waitFor(() => {
            expect(screen.getByText(/의사결정 기록 없음/)).toBeInTheDocument();
        });
    });

    // ─── empty state ────────────────────────────────────────────────────────

    it('shows empty state when no runs', async () => {
        mockedApi.getCronRuns.mockResolvedValue({ runs: [] });

        renderWithQuery(<CronRunsPage />);

        await waitFor(() => {
            expect(screen.getByText('해당 조건의 크론 실행 기록이 없습니다')).toBeInTheDocument();
        });
    });

    // ─── error state ────────────────────────────────────────────────────────

    it('shows error message on api failure', async () => {
        mockedApi.getCronRuns.mockRejectedValue(new Error('Network error'));

        renderWithQuery(<CronRunsPage />);

        await waitFor(() => {
            expect(screen.getByRole('alert')).toBeInTheDocument();
        });

        expect(screen.getByText('오류: Network error')).toBeInTheDocument();
    });
});
