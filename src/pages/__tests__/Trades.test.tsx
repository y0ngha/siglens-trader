import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { TradesPage } from '../Trades';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
    api: {
        getTrades: vi.fn(),
    },
}));

const mockedApi = vi.mocked(api);

function renderWithQuery(component: React.ReactElement) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(<QueryClientProvider client={queryClient}>{component}</QueryClientProvider>);
}

const mockTrades = [
    {
        id: 1,
        symbol: 'AAPL',
        side: 'buy',
        orderType: 'market',
        quantity: 10,
        price: '150.00',
        executedAt: '2026-05-24T09:30:00Z',
        reason: 'RSI oversold signal',
        mode: 'dry_run',
    },
    {
        id: 2,
        symbol: 'TSLA',
        side: 'sell',
        orderType: 'limit',
        quantity: 5,
        price: '210.50',
        executedAt: '2026-05-24T10:00:00Z',
        reason: null,
        mode: 'semi_auto',
    },
    {
        id: 3,
        symbol: 'NVDA',
        side: 'buy',
        orderType: 'market',
        quantity: 20,
        price: '900.00',
        executedAt: '2026-05-24T11:00:00Z',
        reason: 'Breakout detected',
        mode: 'auto',
    },
    {
        id: 4,
        symbol: 'META',
        side: 'buy',
        orderType: 'market',
        quantity: 0,
        price: '520.00',
        executedAt: '2026-05-24T12:00:00Z',
        reason: '잔고 부족 — 신호 75/100 매수 신호 발생했으나 최대 노출 한도 초과로 미실행',
        mode: 'skipped',
    },
];

describe('TradesPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('shows loading skeleton initially', () => {
        mockedApi.getTrades.mockReturnValue(new Promise(() => {}));
        renderWithQuery(<TradesPage />);
        expect(screen.getByLabelText('로딩 중')).toBeInTheDocument();
    });

    it('displays trades when loaded', async () => {
        mockedApi.getTrades.mockResolvedValue(mockTrades);

        renderWithQuery(<TradesPage />);

        await waitFor(() => {
            expect(screen.getByText('거래 내역')).toBeInTheDocument();
        });

        expect(screen.getByText('AAPL')).toBeInTheDocument();
        // Multiple "매수" badges exist (AAPL + NVDA + META are buy)
        expect(screen.getAllByText('매수')).toHaveLength(3);
        expect(screen.getByText('10')).toBeInTheDocument();
        expect(screen.getByText('$150.00')).toBeInTheDocument();
        // "시장가" appears three times (AAPL + NVDA + META are market orders)
        expect(screen.getAllByText('시장가')).toHaveLength(3);
        expect(screen.getByText('RSI oversold signal')).toBeInTheDocument();

        expect(screen.getByText('TSLA')).toBeInTheDocument();
        expect(screen.getByText('매도')).toBeInTheDocument();
        expect(screen.getByText('5')).toBeInTheDocument();
        expect(screen.getByText('$210.50')).toBeInTheDocument();
        expect(screen.getByText('지정가')).toBeInTheDocument();

        // All four trades displayed
        expect(screen.getByText('NVDA')).toBeInTheDocument();
        expect(screen.getByText('META')).toBeInTheDocument();
    });

    it('shows auto mode badge', async () => {
        mockedApi.getTrades.mockResolvedValue([mockTrades[2]]);

        renderWithQuery(<TradesPage />);

        await waitFor(() => {
            expect(screen.getByText('NVDA')).toBeInTheDocument();
        });

        // "자동" appears both as filter button and mode badge
        const autoElements = screen.getAllByText('자동');
        expect(autoElements.length).toBeGreaterThanOrEqual(2);
    });

    it('shows empty state when no trades', async () => {
        mockedApi.getTrades.mockResolvedValue([]);

        renderWithQuery(<TradesPage />);

        await waitFor(() => {
            expect(screen.getByText('거래 내역이 없습니다')).toBeInTheDocument();
        });
    });

    it('shows error message on failure', async () => {
        mockedApi.getTrades.mockRejectedValue(new Error('Timeout'));

        renderWithQuery(<TradesPage />);

        await waitFor(() => {
            expect(screen.getByRole('alert')).toBeInTheDocument();
        });

        expect(screen.getByText('오류: Timeout')).toBeInTheDocument();
    });

    // --- Mode filter tests ---

    it('shows mode filter buttons', async () => {
        mockedApi.getTrades.mockResolvedValue(mockTrades);

        renderWithQuery(<TradesPage />);

        await waitFor(() => {
            expect(screen.getByRole('group', { name: '모드 필터' })).toBeInTheDocument();
        });

        expect(screen.getByRole('button', { name: '전체' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '모의' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '반자동' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '자동' })).toBeInTheDocument();
    });

    it('filters trades by paper mode when 모의 is selected', async () => {
        const user = userEvent.setup();
        mockedApi.getTrades.mockResolvedValue(mockTrades);

        renderWithQuery(<TradesPage />);

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });

        await user.click(screen.getByRole('button', { name: '모의' }));

        expect(screen.getByText('AAPL')).toBeInTheDocument();
        expect(screen.queryByText('TSLA')).not.toBeInTheDocument();
        expect(screen.queryByText('NVDA')).not.toBeInTheDocument();
    });

    it('filters trades by auto mode when 자동 is selected', async () => {
        const user = userEvent.setup();
        mockedApi.getTrades.mockResolvedValue(mockTrades);

        renderWithQuery(<TradesPage />);

        await waitFor(() => {
            expect(screen.getByText('NVDA')).toBeInTheDocument();
        });

        await user.click(screen.getByRole('button', { name: '자동' }));

        expect(screen.getByText('NVDA')).toBeInTheDocument();
        expect(screen.queryByText('AAPL')).not.toBeInTheDocument();
        expect(screen.queryByText('TSLA')).not.toBeInTheDocument();
    });

    it('filters trades by semi-auto mode', async () => {
        const user = userEvent.setup();
        mockedApi.getTrades.mockResolvedValue(mockTrades);

        renderWithQuery(<TradesPage />);

        await waitFor(() => {
            expect(screen.getByText('TSLA')).toBeInTheDocument();
        });

        await user.click(screen.getByRole('button', { name: '반자동' }));

        expect(screen.getByText('TSLA')).toBeInTheDocument();
        expect(screen.queryByText('AAPL')).not.toBeInTheDocument();
        expect(screen.queryByText('NVDA')).not.toBeInTheDocument();
    });

    it('shows all trades when 전체 is selected again', async () => {
        const user = userEvent.setup();
        mockedApi.getTrades.mockResolvedValue(mockTrades);

        renderWithQuery(<TradesPage />);

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });

        await user.click(screen.getByRole('button', { name: '모의' }));
        await user.click(screen.getByRole('button', { name: '전체' }));

        expect(screen.getByText('AAPL')).toBeInTheDocument();
        expect(screen.getByText('TSLA')).toBeInTheDocument();
        expect(screen.getByText('NVDA')).toBeInTheDocument();
        expect(screen.getByText('META')).toBeInTheDocument();
    });

    it('shows empty filtered state when no trades match the filter', async () => {
        const user = userEvent.setup();
        mockedApi.getTrades.mockResolvedValue([mockTrades[0]]);

        renderWithQuery(<TradesPage />);

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });

        await user.click(screen.getByRole('button', { name: '자동' }));

        expect(screen.getByText('해당 모드의 거래가 없습니다')).toBeInTheDocument();
    });

    // --- Trade count display ---

    it('shows total trade count', async () => {
        mockedApi.getTrades.mockResolvedValue(mockTrades);

        renderWithQuery(<TradesPage />);

        await waitFor(() => {
            expect(screen.getByText('4건')).toBeInTheDocument();
        });
    });

    it('shows filtered trade count', async () => {
        const user = userEvent.setup();
        mockedApi.getTrades.mockResolvedValue(mockTrades);

        renderWithQuery(<TradesPage />);

        await waitFor(() => {
            expect(screen.getByText('4건')).toBeInTheDocument();
        });

        await user.click(screen.getByRole('button', { name: '모의' }));

        expect(screen.getByText('1건')).toBeInTheDocument();
    });

    // --- Load more tests ---

    it('shows "더 보기" button when there are more than PAGE_SIZE items', async () => {
        const manyTrades = Array.from({ length: 25 }, (_, i) => ({
            id: i + 1,
            symbol: `SYM${i}`,
            side: 'buy',
            orderType: 'market',
            quantity: 1,
            price: '100.00',
            executedAt: `2026-05-24T0${String(9 + Math.floor(i / 6)).padStart(1, '0')}:${String((i % 6) * 10).padStart(2, '0')}:00Z`,
            reason: null,
            mode: 'dry_run',
        }));
        mockedApi.getTrades.mockResolvedValue(manyTrades);

        renderWithQuery(<TradesPage />);

        await waitFor(() => {
            expect(screen.getByText(/더 보기/)).toBeInTheDocument();
        });

        expect(screen.getByText(/5건 남음/)).toBeInTheDocument();
    });

    it('loads more items when "더 보기" is clicked', async () => {
        const user = userEvent.setup();
        const manyTrades = Array.from({ length: 25 }, (_, i) => ({
            id: i + 1,
            symbol: `SYM${i}`,
            side: 'buy',
            orderType: 'market',
            quantity: 1,
            price: '100.00',
            executedAt: `2026-05-24T0${String(9 + Math.floor(i / 6)).padStart(1, '0')}:${String((i % 6) * 10).padStart(2, '0')}:00Z`,
            reason: null,
            mode: 'dry_run',
        }));
        mockedApi.getTrades.mockResolvedValue(manyTrades);

        renderWithQuery(<TradesPage />);

        await waitFor(() => {
            expect(screen.getByText(/더 보기/)).toBeInTheDocument();
        });

        await user.click(screen.getByText(/더 보기/));

        // All 25 items should now be visible, no "더 보기" button
        expect(screen.queryByText(/더 보기/)).not.toBeInTheDocument();
    });

    // --- Skipped mode filter tests ---

    it('shows 미실행 filter button', async () => {
        mockedApi.getTrades.mockResolvedValue(mockTrades);

        renderWithQuery(<TradesPage />);

        await waitFor(() => {
            expect(screen.getByRole('button', { name: '미실행' })).toBeInTheDocument();
        });
    });

    it('filters trades by skipped mode when 미실행 is selected', async () => {
        const user = userEvent.setup();
        mockedApi.getTrades.mockResolvedValue(mockTrades);

        renderWithQuery(<TradesPage />);

        await waitFor(() => {
            expect(screen.getByText('META')).toBeInTheDocument();
        });

        await user.click(screen.getByRole('button', { name: '미실행' }));

        expect(screen.getByText('META')).toBeInTheDocument();
        expect(screen.queryByText('AAPL')).not.toBeInTheDocument();
        expect(screen.queryByText('TSLA')).not.toBeInTheDocument();
        expect(screen.queryByText('NVDA')).not.toBeInTheDocument();
    });

    it('shows 미실행 badge on skipped trades', async () => {
        mockedApi.getTrades.mockResolvedValue([mockTrades[3]]);

        renderWithQuery(<TradesPage />);

        await waitFor(() => {
            expect(screen.getByText('META')).toBeInTheDocument();
        });

        // "미실행" appears both as filter button and mode badge
        const skippedElements = screen.getAllByText('미실행');
        expect(skippedElements.length).toBeGreaterThanOrEqual(2);
    });
});
