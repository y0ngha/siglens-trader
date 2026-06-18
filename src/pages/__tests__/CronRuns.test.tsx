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

    it('renders reason and structured score components when decision detail is present', async () => {
        const user = userEvent.setup();
        mockedApi.getCronRuns.mockResolvedValue({ runs: [mockRuns[0]] });
        mockedApi.getCronDecisions.mockResolvedValue({
            decisions: [
                {
                    id: 201,
                    runId: 'run-abc-1',
                    cronType: 'execute',
                    symbol: 'NVDA',
                    action: 'hold',
                    executed: false,
                    score: '50.0',
                    reason: '신호 50/100 — 대기',
                    detail: {
                        components: {
                            technical: 51,
                            news: 52,
                            options: 53,
                            fundamental: 54,
                        },
                        signal: 'hold',
                        thresholds: { buy: 70, sell: 30 },
                        sourceAnalyzedAt: '2026-05-24T14:25:00.000Z',
                    },
                    createdAt: new Date().toISOString(),
                },
            ],
        });

        renderWithQuery(<CronRunsPage />);

        await waitFor(() => {
            expect(screen.getByText('COMPLETED')).toBeInTheDocument();
        });

        const rowBtn = screen.getByRole('button', { expanded: false });
        await user.click(rowBtn);

        await waitFor(() => {
            expect(screen.getByText('NVDA')).toBeInTheDocument();
        });

        // reason shown
        expect(screen.getByText(/대기/)).toBeInTheDocument();
        // structured component scores rendered (not raw JSON)
        const componentsLine = screen.getByText(/기술 51/);
        expect(componentsLine).toBeInTheDocument();
        expect(componentsLine).toHaveTextContent('뉴스 52');
        expect(componentsLine).toHaveTextContent('옵션 53');
        expect(componentsLine).toHaveTextContent('펀더멘털 54');
    });

    it('renders a decision with null detail without crashing and shows no component line', async () => {
        const user = userEvent.setup();
        mockedApi.getCronRuns.mockResolvedValue({ runs: [mockRuns[0]] });
        mockedApi.getCronDecisions.mockResolvedValue({
            decisions: [
                {
                    id: 202,
                    runId: 'run-abc-1',
                    cronType: 'execute',
                    symbol: 'NVDA',
                    action: 'hold',
                    executed: false,
                    score: '0.0',
                    reason: '유지 (조건 미충족)',
                    detail: null,
                    createdAt: new Date().toISOString(),
                },
            ],
        });

        renderWithQuery(<CronRunsPage />);

        await waitFor(() => {
            expect(screen.getByText('COMPLETED')).toBeInTheDocument();
        });

        const rowBtn = screen.getByRole('button', { expanded: false });
        await user.click(rowBtn);

        await waitFor(() => {
            expect(screen.getByText('NVDA')).toBeInTheDocument();
        });

        // reason still shown
        expect(screen.getByText(/유지/)).toBeInTheDocument();
        // no component-scores line, and no raw JSON <pre> fallback
        expect(screen.queryByText(/기술 /)).not.toBeInTheDocument();
        expect(document.querySelector('pre')).toBeNull();
    });

    it('falls back to raw JSON for a partial components object (missing keys)', async () => {
        const user = userEvent.setup();
        mockedApi.getCronRuns.mockResolvedValue({ runs: [mockRuns[0]] });
        mockedApi.getCronDecisions.mockResolvedValue({
            decisions: [
                {
                    id: 203,
                    runId: 'run-abc-1',
                    cronType: 'execute',
                    symbol: 'NVDA',
                    action: 'hold',
                    executed: false,
                    score: '50.0',
                    reason: '부분 점수',
                    // Missing options/fundamental → readScoreComponents returns null
                    detail: { components: { technical: 50, news: 50 } },
                    createdAt: new Date().toISOString(),
                },
            ],
        });

        renderWithQuery(<CronRunsPage />);

        await waitFor(() => {
            expect(screen.getByText('COMPLETED')).toBeInTheDocument();
        });

        const rowBtn = screen.getByRole('button', { expanded: false });
        await user.click(rowBtn);

        await waitFor(() => {
            expect(screen.getByText('NVDA')).toBeInTheDocument();
        });

        // No structured component line (requires all five numeric keys)
        expect(screen.queryByText(/기술 50/)).not.toBeInTheDocument();
        // Falls back to raw JSON <pre> path
        const pre = document.querySelector('pre');
        expect(pre).not.toBeNull();
        expect(pre).toHaveTextContent('"technical": 50');
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
