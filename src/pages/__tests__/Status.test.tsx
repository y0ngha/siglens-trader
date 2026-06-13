import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { StatusPage } from '../Status';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
    api: {
        getStatus: vi.fn(),
        getPositions: vi.fn(),
        getTrades: vi.fn(),
        getConfig: vi.fn(),
        dismissAlert: vi.fn(),
    },
}));

const mockedApi = vi.mocked(api);

function renderWithQuery(component: React.ReactElement) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(<QueryClientProvider client={queryClient}>{component}</QueryClientProvider>);
}

const defaultStatus = {
    running: true,
    tradingMode: 'paper',
    activePositions: 3,
    todayTrades: 7,
};

const mockPositions = [
    {
        id: 1,
        symbol: 'AAPL',
        side: 'long',
        quantity: 5,
        avgPrice: '189.50',
        currentPrice: '195.20',
        openedAt: '2026-05-21T10:00:00Z',
        status: 'open',
    },
    {
        id: 2,
        symbol: 'NVDA',
        side: 'long',
        quantity: 3,
        avgPrice: '875.20',
        currentPrice: '892.50',
        openedAt: '2026-05-19T10:00:00Z',
        status: 'open',
    },
];

const mockTrades = [
    {
        id: 1,
        symbol: 'AAPL',
        side: 'buy',
        orderType: 'market',
        quantity: 5,
        price: '189.50',
        executedAt: '2026-05-24T14:30:00Z',
        reason: null,
        mode: 'paper',
        dismissedAt: null,
    },
    {
        id: 2,
        symbol: 'NVDA',
        side: 'buy',
        orderType: 'market',
        quantity: 3,
        price: '875.20',
        executedAt: '2026-05-23T10:00:00Z',
        reason: null,
        mode: 'paper',
        dismissedAt: null,
    },
    {
        id: 3,
        symbol: 'TSLA',
        side: 'sell',
        orderType: 'market',
        quantity: 5,
        price: '255.30',
        executedAt: '2026-05-22T15:00:00Z',
        reason: null,
        mode: 'paper',
        dismissedAt: null,
    },
    {
        id: 4,
        symbol: 'GOOGL',
        side: 'buy',
        orderType: 'market',
        quantity: 4,
        price: '176.30',
        executedAt: '2026-05-21T09:00:00Z',
        reason: null,
        mode: 'paper',
        dismissedAt: null,
    },
    {
        id: 5,
        symbol: 'GOOGL',
        side: 'sell',
        orderType: 'market',
        quantity: 4,
        price: '181.90',
        executedAt: '2026-05-20T12:00:00Z',
        reason: null,
        mode: 'paper',
        dismissedAt: null,
    },
];

describe('StatusPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockedApi.getPositions.mockResolvedValue([]);
        mockedApi.getTrades.mockResolvedValue([]);
        mockedApi.getConfig.mockResolvedValue({
            config: [
                { key: 'take_profit_percent', value: 5, updatedAt: '' },
                { key: 'stop_loss_percent', value: 3, updatedAt: '' },
            ],
            watchlist: [
                { id: 1, symbol: 'AAPL', companyName: 'Apple Inc.', enabled: true, createdAt: '' },
                {
                    id: 2,
                    symbol: 'NVDA',
                    companyName: 'NVIDIA Corp.',
                    enabled: true,
                    createdAt: '',
                },
            ],
            analysis: [],
            notification: [],
        });
    });

    it('shows loading skeleton initially', () => {
        mockedApi.getStatus.mockReturnValue(new Promise(() => {}));
        renderWithQuery(<StatusPage />);
        expect(screen.getByLabelText('로딩 중')).toBeInTheDocument();
    });

    it('displays status data when loaded', async () => {
        mockedApi.getStatus.mockResolvedValue(defaultStatus);

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByText('시스템 상태')).toBeInTheDocument();
        });

        expect(screen.getByText('실행 중')).toBeInTheDocument();
        expect(screen.getByText('모의투자')).toBeInTheDocument();
        expect(screen.getByText('3')).toBeInTheDocument();
        expect(screen.getByText('7')).toBeInTheDocument();
    });

    it('displays stopped state correctly', async () => {
        mockedApi.getStatus.mockResolvedValue({
            running: false,
            tradingMode: 'auto',
            activePositions: 0,
            todayTrades: 0,
        });

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByText('정지')).toBeInTheDocument();
        });

        expect(screen.getByText('자동')).toBeInTheDocument();
    });

    it('displays semi-auto mode label', async () => {
        mockedApi.getStatus.mockResolvedValue({
            running: true,
            tradingMode: 'semi-auto',
            activePositions: 1,
            todayTrades: 2,
        });

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByText('반자동')).toBeInTheDocument();
        });
    });

    it('shows error message on failure', async () => {
        mockedApi.getStatus.mockRejectedValue(new Error('Network error'));

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByRole('alert')).toBeInTheDocument();
        });

        expect(screen.getByText('오류: Network error')).toBeInTheDocument();
    });

    // --- Health status indicator tests ---

    it('shows green "정상 운영" when system is running and has trades today', async () => {
        mockedApi.getStatus.mockResolvedValue({
            running: true,
            tradingMode: 'auto',
            activePositions: 2,
            todayTrades: 5,
        });

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByText('정상 운영')).toBeInTheDocument();
        });
    });

    it('shows yellow "대기 중" when system is running but no trades today', async () => {
        mockedApi.getStatus.mockResolvedValue({
            running: true,
            tradingMode: 'paper',
            activePositions: 1,
            todayTrades: 0,
        });

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByText('대기 중')).toBeInTheDocument();
        });
    });

    it('shows red "시스템 정지" when system is not running', async () => {
        mockedApi.getStatus.mockResolvedValue({
            running: false,
            tradingMode: 'paper',
            activePositions: 0,
            todayTrades: 0,
        });

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByText('시스템 정지')).toBeInTheDocument();
        });
    });

    it('has health status aria-label for accessibility', async () => {
        mockedApi.getStatus.mockResolvedValue({
            running: true,
            tradingMode: 'paper',
            activePositions: 0,
            todayTrades: 3,
        });

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByLabelText('전체 건강 상태')).toBeInTheDocument();
        });
    });

    it('displays dry_run mode as 모의투자', async () => {
        mockedApi.getStatus.mockResolvedValue({
            running: true,
            tradingMode: 'dry_run',
            activePositions: 0,
            todayTrades: 0,
        });

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByText('모의투자')).toBeInTheDocument();
        });
    });

    // --- Portfolio (계좌 상태) tests ---

    it('calculates portfolio values from positions data', async () => {
        mockedApi.getStatus.mockResolvedValue(defaultStatus);
        mockedApi.getPositions.mockResolvedValue(mockPositions);

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByTestId('total-invested')).toBeInTheDocument();
        });

        // totalInvested = (189.50 * 5) + (875.20 * 3) = 947.50 + 2625.60 = 3573.10
        expect(screen.getByTestId('total-invested')).toHaveTextContent('$3,573.10');
        // currentValue = (195.20 * 5) + (892.50 * 3) = 976.00 + 2677.50 = 3653.50
        expect(screen.getByTestId('current-value')).toHaveTextContent('$3,653.50');
        // pnl = (3653.50 - 3573.10) / 3573.10 * 100 = 2.25%
        expect(screen.getByTestId('pnl-percent')).toHaveTextContent('+2.25%');
    });

    it('shows $0.00 and 0% when no positions', async () => {
        mockedApi.getStatus.mockResolvedValue(defaultStatus);
        mockedApi.getPositions.mockResolvedValue([]);

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByTestId('total-invested')).toBeInTheDocument();
        });

        expect(screen.getByTestId('total-invested')).toHaveTextContent('$0.00');
        expect(screen.getByTestId('current-value')).toHaveTextContent('$0.00');
        expect(screen.getByTestId('pnl-percent')).toHaveTextContent('0.00%');
    });

    it('uses avgPrice as fallback when currentPrice is missing', async () => {
        mockedApi.getStatus.mockResolvedValue(defaultStatus);
        mockedApi.getPositions.mockResolvedValue([
            {
                id: 1,
                symbol: 'AAPL',
                side: 'long',
                quantity: 10,
                avgPrice: '150.00',
                openedAt: '2026-05-20T10:00:00Z',
                status: 'open',
            },
        ]);

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByTestId('total-invested')).toBeInTheDocument();
        });

        // Without currentPrice, both invested and current use avgPrice
        expect(screen.getByTestId('total-invested')).toHaveTextContent('$1,500.00');
        expect(screen.getByTestId('current-value')).toHaveTextContent('$1,500.00');
        expect(screen.getByTestId('pnl-percent')).toHaveTextContent('0.00%');
    });

    it('shows position symbols as compact chips', async () => {
        mockedApi.getStatus.mockResolvedValue(defaultStatus);
        mockedApi.getPositions.mockResolvedValue(mockPositions);

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            // "2종목" appears for both holdings count and watchlist count
            expect(screen.getAllByText('2종목').length).toBeGreaterThanOrEqual(1);
        });

        // AAPL and NVDA appear in both holdings chips and watchlist chips
        expect(screen.getAllByText('AAPL').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('NVDA').length).toBeGreaterThanOrEqual(1);
    });

    it('shows green pnl color for profit', async () => {
        mockedApi.getStatus.mockResolvedValue(defaultStatus);
        mockedApi.getPositions.mockResolvedValue(mockPositions);

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByTestId('pnl-percent')).toBeInTheDocument();
        });

        expect(screen.getByTestId('pnl-percent')).toHaveClass('text-green-400');
    });

    it('shows red pnl color for loss', async () => {
        mockedApi.getStatus.mockResolvedValue(defaultStatus);
        mockedApi.getPositions.mockResolvedValue([
            {
                id: 1,
                symbol: 'AAPL',
                side: 'long',
                quantity: 10,
                avgPrice: '200.00',
                currentPrice: '180.00',
                openedAt: '2026-05-20T10:00:00Z',
                status: 'open',
            },
        ]);

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByTestId('pnl-percent')).toBeInTheDocument();
        });

        expect(screen.getByTestId('pnl-percent')).toHaveClass('text-red-400');
        expect(screen.getByTestId('pnl-percent')).toHaveTextContent('-10.00%');
    });

    // --- Recent trades (최근 활동) tests ---

    it('displays multiple recent trades', async () => {
        mockedApi.getStatus.mockResolvedValue(defaultStatus);
        mockedApi.getTrades.mockResolvedValue(mockTrades);

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getAllByText('AAPL').length).toBeGreaterThanOrEqual(1);
        });

        expect(screen.getAllByText('NVDA').length).toBeGreaterThanOrEqual(1);
        // TSLA only appears in trades, not in default watchlist mock
        expect(screen.getByText('TSLA')).toBeInTheDocument();
        // GOOGL appears in trades (2x: buy + sell)
        expect(screen.getAllByText('GOOGL').length).toBeGreaterThanOrEqual(2);
    });

    it('shows buy/sell badges for recent trades', async () => {
        mockedApi.getStatus.mockResolvedValue(defaultStatus);
        mockedApi.getTrades.mockResolvedValue(mockTrades);

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getAllByText('AAPL').length).toBeGreaterThanOrEqual(1);
        });

        const buyBadges = screen.getAllByText('매수');
        const sellBadges = screen.getAllByText('매도');
        expect(buyBadges.length).toBe(3); // AAPL, NVDA, GOOGL
        expect(sellBadges.length).toBe(2); // TSLA, GOOGL
    });

    it('shows prices for recent trades', async () => {
        mockedApi.getStatus.mockResolvedValue(defaultStatus);
        mockedApi.getTrades.mockResolvedValue(mockTrades);

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getAllByText('$189.50').length).toBeGreaterThanOrEqual(1);
        });

        expect(screen.getByText('$875.20')).toBeInTheDocument();
        expect(screen.getByText('$255.30')).toBeInTheDocument();
    });

    it('limits recent trades to max 10', async () => {
        const manyTrades = Array.from({ length: 15 }, (_, i) => ({
            id: i + 1,
            symbol: `SYM${i}`,
            side: 'buy' as const,
            orderType: 'market',
            quantity: 1,
            price: '100.00',
            executedAt: new Date(Date.now() - i * 3600000).toISOString(),
            reason: null,
            mode: 'paper',
            dismissedAt: null,
        }));
        mockedApi.getStatus.mockResolvedValue(defaultStatus);
        mockedApi.getTrades.mockResolvedValue(manyTrades);

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByText('SYM0')).toBeInTheDocument();
        });

        expect(screen.getByText('SYM9')).toBeInTheDocument();
        expect(screen.queryByText('SYM10')).not.toBeInTheDocument();
    });

    it('shows "거래 내역 없음" when no trades', async () => {
        mockedApi.getStatus.mockResolvedValue(defaultStatus);
        mockedApi.getTrades.mockResolvedValue([]);

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByText('거래 내역 없음')).toBeInTheDocument();
        });
    });

    // --- Skipped trades alert tests ---

    it('displays skipped trades alert section when skipped trades exist', async () => {
        mockedApi.getStatus.mockResolvedValue(defaultStatus);
        mockedApi.getTrades.mockResolvedValue([
            {
                id: 10,
                symbol: 'META',
                side: 'buy',
                orderType: 'market',
                quantity: 0,
                price: '520.00',
                executedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour ago (within 24h TTL)
                reason: '잔고 부족 — 신호 75/100 매수 신호 발생했으나 최대 노출 한도 초과로 미실행',
                mode: 'skipped',
                dismissedAt: null,
            },
        ]);

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByText('경고')).toBeInTheDocument();
        });

        // META appears in both alert section and recent trades section
        expect(screen.getAllByText('META')).toHaveLength(2);
        expect(screen.getByText('잔고 부족')).toBeInTheDocument();
        expect(
            screen.getByText(
                '잔고 부족 — 신호 75/100 매수 신호 발생했으나 최대 노출 한도 초과로 미실행',
            ),
        ).toBeInTheDocument();
    });

    it('does not show alert section when no skipped trades', async () => {
        mockedApi.getStatus.mockResolvedValue(defaultStatus);
        mockedApi.getTrades.mockResolvedValue(mockTrades);

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByText('시스템 상태')).toBeInTheDocument();
        });

        expect(screen.queryByText('경고')).not.toBeInTheDocument();
    });

    it('hides skipped trades older than 24 hours', async () => {
        mockedApi.getStatus.mockResolvedValue(defaultStatus);
        mockedApi.getTrades.mockResolvedValue([
            {
                id: 10,
                symbol: 'META',
                side: 'buy',
                orderType: 'market',
                quantity: 0,
                price: '520.00',
                executedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25 hours ago (beyond 24h TTL)
                reason: '잔고 부족 — 미실행',
                mode: 'skipped',
                dismissedAt: null,
            },
        ]);

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByText('시스템 상태')).toBeInTheDocument();
        });

        // The skipped trade is older than 24h, so the alert section should not appear
        expect(screen.queryByText('경고')).not.toBeInTheDocument();
    });

    it('limits skipped trades alert to 5 items', async () => {
        const skippedTrades = Array.from({ length: 7 }, (_, i) => ({
            id: 100 + i,
            symbol: `SYM${i}`,
            side: 'buy',
            orderType: 'market',
            quantity: 0,
            price: '100.00',
            executedAt: new Date(Date.now() - i * 3600000).toISOString(),
            reason: '잔고 부족 — 미실행',
            mode: 'skipped',
            dismissedAt: null,
        }));
        mockedApi.getStatus.mockResolvedValue(defaultStatus);
        mockedApi.getTrades.mockResolvedValue(skippedTrades);

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByText('경고')).toBeInTheDocument();
        });

        // SYM0-SYM4 appear in both alert (max 5) and recent trades (max 10)
        // SYM5, SYM6 only appear in recent trades (not in alert which is limited to 5)
        expect(screen.getAllByText('SYM0')).toHaveLength(2); // alert + recent trades
        expect(screen.getAllByText('SYM4')).toHaveLength(2); // alert + recent trades
        // SYM5 and SYM6 appear only in recent trades, not in the alert
        expect(screen.getAllByText('SYM5')).toHaveLength(1); // recent trades only
        expect(screen.getAllByText('SYM6')).toHaveLength(1); // recent trades only
    });

    // --- Dismiss alert tests ---

    it('shows dismiss button on skipped trade alerts', async () => {
        mockedApi.getStatus.mockResolvedValue(defaultStatus);
        mockedApi.getTrades.mockResolvedValue([
            {
                id: 10,
                symbol: 'META',
                side: 'buy',
                orderType: 'market',
                quantity: 0,
                price: '520.00',
                executedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
                reason: '잔고 부족',
                mode: 'skipped',
                dismissedAt: null,
            },
        ]);

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByText('경고')).toBeInTheDocument();
        });

        expect(screen.getByRole('button', { name: '확인' })).toBeInTheDocument();
    });

    it('calls dismissAlert API when dismiss button is clicked', async () => {
        const user = userEvent.setup();
        mockedApi.getStatus.mockResolvedValue(defaultStatus);
        mockedApi.getTrades.mockResolvedValue([
            {
                id: 10,
                symbol: 'META',
                side: 'buy',
                orderType: 'market',
                quantity: 0,
                price: '520.00',
                executedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
                reason: '잔고 부족',
                mode: 'skipped',
                dismissedAt: null,
            },
        ]);
        mockedApi.dismissAlert.mockResolvedValue({ success: true });

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByRole('button', { name: '확인' })).toBeInTheDocument();
        });

        await user.click(screen.getByRole('button', { name: '확인' }));

        expect(mockedApi.dismissAlert).toHaveBeenCalledWith(10);
    });

    it('hides dismissed alerts from the alert section', async () => {
        mockedApi.getStatus.mockResolvedValue(defaultStatus);
        mockedApi.getTrades.mockResolvedValue([
            {
                id: 10,
                symbol: 'META',
                side: 'buy',
                orderType: 'market',
                quantity: 0,
                price: '520.00',
                executedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
                reason: '잔고 부족',
                mode: 'skipped',
                dismissedAt: '2026-05-25T00:00:00Z',
            },
        ]);

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByText('시스템 상태')).toBeInTheDocument();
        });

        // The alert section should not appear since the only skipped trade is dismissed
        expect(screen.queryByText('경고')).not.toBeInTheDocument();
    });

    it('shows relative time on skipped trade alerts', async () => {
        mockedApi.getStatus.mockResolvedValue(defaultStatus);
        mockedApi.getTrades.mockResolvedValue([
            {
                id: 10,
                symbol: 'META',
                side: 'buy',
                orderType: 'market',
                quantity: 0,
                price: '520.00',
                executedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
                reason: '잔고 부족',
                mode: 'skipped',
                dismissedAt: null,
            },
        ]);

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByText('경고')).toBeInTheDocument();
        });

        // "2시간 전" appears in both the alert section and recent trades section
        expect(screen.getAllByText('2시간 전')).toHaveLength(2);
    });

    // --- Position targets mobile/desktop render tests ---

    it('renders position-targets mobile cards and desktop table for open positions', async () => {
        mockedApi.getStatus.mockResolvedValue(defaultStatus);
        mockedApi.getPositions.mockResolvedValue(mockPositions);

        const { container } = renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByTestId('position-targets-mobile')).toBeInTheDocument();
        });

        expect(screen.getByTestId('position-targets-table')).toBeInTheDocument();

        // Mobile cards: each position has label:value pairs
        const mobileSection = container.querySelector('[data-testid="position-targets-mobile"]')!;
        expect(mobileSection).toHaveTextContent('AAPL');
        expect(mobileSection).toHaveTextContent('NVDA');
        expect(mobileSection).toHaveTextContent('매수가');
        expect(mobileSection).toHaveTextContent('현재가');
        expect(mobileSection).toHaveTextContent('익절');
        expect(mobileSection).toHaveTextContent('손절');
    });

    // --- Responsive layout tests ---

    it('has responsive grid classes', async () => {
        mockedApi.getStatus.mockResolvedValue(defaultStatus);

        const { container } = renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByText('시스템 상태')).toBeInTheDocument();
        });

        const grid = container.querySelector('.grid');
        expect(grid).toHaveClass('grid-cols-1');
        expect(grid).toHaveClass('md:grid-cols-[1fr_1fr]');
    });
});
