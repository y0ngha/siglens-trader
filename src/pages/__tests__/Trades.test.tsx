import { render, screen, waitFor } from '@testing-library/react';
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
        mockedApi.getTrades.mockResolvedValue([
            {
                id: 1,
                symbol: 'AAPL',
                side: 'buy',
                orderType: 'market',
                quantity: 10,
                price: '150.00',
                executedAt: '2026-05-24T09:30:00Z',
                reason: 'RSI oversold signal',
                mode: 'paper',
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
                mode: 'semi-auto',
            },
        ]);

        renderWithQuery(<TradesPage />);

        await waitFor(() => {
            expect(screen.getByText('거래 내역')).toBeInTheDocument();
        });

        expect(screen.getByText('AAPL')).toBeInTheDocument();
        expect(screen.getByText('매수')).toBeInTheDocument();
        expect(screen.getByText('10')).toBeInTheDocument();
        expect(screen.getByText('$150.00')).toBeInTheDocument();
        expect(screen.getByText('시장가')).toBeInTheDocument();
        expect(screen.getByText('모의')).toBeInTheDocument();
        expect(screen.getByText('RSI oversold signal')).toBeInTheDocument();

        expect(screen.getByText('TSLA')).toBeInTheDocument();
        expect(screen.getByText('매도')).toBeInTheDocument();
        expect(screen.getByText('5')).toBeInTheDocument();
        expect(screen.getByText('$210.50')).toBeInTheDocument();
        expect(screen.getByText('지정가')).toBeInTheDocument();
        expect(screen.getByText('반자동')).toBeInTheDocument();
    });

    it('shows auto mode badge', async () => {
        mockedApi.getTrades.mockResolvedValue([
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
        ]);

        renderWithQuery(<TradesPage />);

        await waitFor(() => {
            expect(screen.getByText('자동')).toBeInTheDocument();
        });
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
});
