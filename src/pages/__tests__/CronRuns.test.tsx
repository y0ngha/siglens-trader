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
    {
        id: 103,
        runId: 'run-abc-1',
        cronType: 'execute',
        symbol: 'MSFT',
        action: 'entry_blocked',
        executed: false,
        score: '75.0',
        reason: '일일 손실 한도로 신규 진입 차단',
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

    // ─── breaker-trip coloring (status='completed' but outcome is a tripped breaker) ──

    it('renders a completed run with a risk-breaker outcome in warning (orange) color, not green', async () => {
        mockedApi.getCronRuns.mockResolvedValue({
            runs: [
                {
                    id: 10,
                    runId: 'run-risk-1',
                    cronType: 'execute',
                    status: 'completed',
                    outcome: 'daily_loss_limit',
                    startedAt: new Date().toISOString(),
                    finishedAt: new Date().toISOString(),
                    durationMs: 5000,
                    summary: {
                        exitOnly: true,
                        entriesBlockedBy: 'daily_loss_limit',
                        exitsForcedFull: true,
                    },
                    error: null,
                    createdAt: new Date().toISOString(),
                },
            ],
        });

        renderWithQuery(<CronRunsPage />);

        await waitFor(() => {
            expect(screen.getByText('daily_loss_limit')).toBeInTheDocument();
        });

        const outcomeEl = screen.getByText('daily_loss_limit');
        expect(outcomeEl).toHaveClass('text-orange-400');
        expect(outcomeEl).not.toHaveClass('text-green-400');

        const row = outcomeEl.closest('li');
        expect(row).not.toBeNull();
        expect(row).toHaveClass('border-l-orange-500');
        expect(row).not.toHaveClass('border-l-green-500');
        expect(row?.querySelector('[aria-hidden="true"]')).toHaveClass('bg-orange-500');
    });

    it('keeps a normal completed run green (regression — no false-positive warning color)', async () => {
        mockedApi.getCronRuns.mockResolvedValue({
            runs: [
                {
                    id: 11,
                    runId: 'run-normal-1',
                    cronType: 'execute',
                    status: 'completed',
                    outcome: 'completed',
                    startedAt: new Date().toISOString(),
                    finishedAt: new Date().toISOString(),
                    durationMs: 5000,
                    summary: { symbolsEvaluated: 2 },
                    error: null,
                    createdAt: new Date().toISOString(),
                },
            ],
        });

        renderWithQuery(<CronRunsPage />);

        await waitFor(() => {
            expect(screen.getByText('completed')).toBeInTheDocument();
        });

        const outcomeEl = screen.getByText('completed');
        expect(outcomeEl).toHaveClass('text-green-400');

        const row = outcomeEl.closest('li');
        expect(row).toHaveClass('border-l-green-500');
        expect(row?.querySelector('[aria-hidden="true"]')).toHaveClass('bg-green-500');
    });

    it('shows exit-only breaker info in the summary line (visible without expanding)', async () => {
        mockedApi.getCronRuns.mockResolvedValue({
            runs: [
                {
                    id: 12,
                    runId: 'run-exitonly-1',
                    cronType: 'execute',
                    status: 'completed',
                    outcome: 'daily_trade_limit',
                    startedAt: new Date().toISOString(),
                    finishedAt: new Date().toISOString(),
                    durationMs: 5000,
                    summary: {
                        exitOnly: true,
                        entriesBlockedBy: 'daily_trade_limit',
                        exitsForcedFull: false,
                        symbolsEvaluated: 4,
                    },
                    error: null,
                    createdAt: new Date().toISOString(),
                },
            ],
        });

        renderWithQuery(<CronRunsPage />);

        await waitFor(() => {
            expect(screen.getByText(/청산전용/)).toBeInTheDocument();
        });

        expect(screen.getByText(/일일 체결 한도/)).toBeInTheDocument();
        expect(screen.getByText(/청산전용/)).toHaveClass('text-red-400');
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
        // entry_blocked (breaker-blocked entry) gets the orange breaker chip, not gray default
        expect(screen.getByText('entry_blocked')).toHaveClass(
            'bg-orange-500/10',
            'text-orange-400',
        );
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

    it('renders the gate block alongside score components (merged detail shape)', async () => {
        const user = userEvent.setup();
        mockedApi.getCronRuns.mockResolvedValue({ runs: [mockRuns[0]] });
        mockedApi.getCronDecisions.mockResolvedValue({
            decisions: [
                {
                    id: 204,
                    runId: 'run-abc-1',
                    cronType: 'execute',
                    symbol: 'MSFT',
                    action: 'gate_error',
                    executed: false,
                    score: '78.0',
                    reason: '신호 78/100 — 매수',
                    // Real shape from execute.ts: { ...scoreDetail, ...gateDetail } — both
                    // components and gate are present together.
                    detail: {
                        components: { technical: 80, news: 75, options: 78, fundamental: 79 },
                        gate: {
                            kind: 'entry',
                            source: 'error',
                            model: 'deepseek-v4-flash',
                            fraction: 0,
                            confidence: null,
                            reason: '게이트 호출 타임아웃',
                            fullBudget: 1000,
                            trancheBudget: null,
                            limitedBy: 'symbol',
                            quantity: 0,
                        },
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
            expect(screen.getByText('MSFT')).toBeInTheDocument();
        });

        // Score components still render
        expect(screen.getByText(/기술 80/)).toBeInTheDocument();
        // Gate block renders alongside — not replaced by it, and no raw JSON fallback
        expect(screen.getByText(/게이트 error/)).toBeInTheDocument();
        expect(screen.getByText(/한도 symbol/)).toBeInTheDocument();
        expect(screen.getByText('게이트 호출 타임아웃')).toBeInTheDocument();
        expect(document.querySelector('pre')).toBeNull();
        // gate_error action chip
        expect(screen.getByText('gate_error')).toBeInTheDocument();
    });

    it('renders the gate block alone when there are no score components (entry_deferred)', async () => {
        const user = userEvent.setup();
        mockedApi.getCronRuns.mockResolvedValue({ runs: [mockRuns[0]] });
        mockedApi.getCronDecisions.mockResolvedValue({
            decisions: [
                {
                    id: 205,
                    runId: 'run-abc-1',
                    cronType: 'execute',
                    symbol: 'AMZN',
                    action: 'entry_deferred',
                    executed: false,
                    score: '71.0',
                    reason: '신호 71/100 — 매수',
                    detail: {
                        gate: {
                            kind: 'entry',
                            source: 'ai',
                            model: 'deepseek-v4-flash',
                            fraction: 0,
                            confidence: 40,
                            reason: '현금 여유 부족으로 이번 틱 진입 보류',
                            fullBudget: 200,
                            trancheBudget: 0,
                            limitedBy: 'cash',
                            quantity: 0,
                        },
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
            expect(screen.getByText('AMZN')).toBeInTheDocument();
        });

        expect(screen.getByText(/게이트 ai/)).toBeInTheDocument();
        expect(screen.getByText(/한도 cash/)).toBeInTheDocument();
        expect(screen.getByText('현금 여유 부족으로 이번 틱 진입 보류')).toBeInTheDocument();
        expect(document.querySelector('pre')).toBeNull();
        expect(screen.getByText('entry_deferred')).toBeInTheDocument();
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
