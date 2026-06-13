import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PositionsPage } from '../Positions';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
    api: {
        getPositions: vi.fn(),
        closePosition: vi.fn(),
    },
}));

const mockedApi = vi.mocked(api);

function renderWithQuery(component: React.ReactElement) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(<QueryClientProvider client={queryClient}>{component}</QueryClientProvider>);
}

const mockPositions = [
    {
        id: 1,
        symbol: 'AAPL',
        side: 'long',
        quantity: 10,
        avgPrice: '150.00',
        currentPrice: '165.00',
        openedAt: '2026-05-20T10:00:00Z',
        status: 'open',
    },
    {
        id: 2,
        symbol: 'TSLA',
        side: 'short',
        quantity: 5,
        avgPrice: '200.00',
        currentPrice: '180.00',
        openedAt: '2026-05-21T14:00:00Z',
        status: 'open',
    },
];

describe('PositionsPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('shows loading skeleton initially', () => {
        mockedApi.getPositions.mockReturnValue(new Promise(() => {}));
        renderWithQuery(<PositionsPage />);
        expect(screen.getByLabelText('로딩 중')).toBeInTheDocument();
    });

    it('displays positions when loaded', async () => {
        mockedApi.getPositions.mockResolvedValue(mockPositions);

        renderWithQuery(<PositionsPage />);

        await waitFor(() => {
            expect(screen.getByText('포지션')).toBeInTheDocument();
        });

        expect(screen.getByText('AAPL')).toBeInTheDocument();
        expect(screen.getByText('롱')).toBeInTheDocument();
        expect(screen.getByText('10')).toBeInTheDocument();
        expect(screen.getByText('$150.00')).toBeInTheDocument();

        expect(screen.getByText('TSLA')).toBeInTheDocument();
        expect(screen.getByText('숏')).toBeInTheDocument();
        expect(screen.getByText('5')).toBeInTheDocument();
        expect(screen.getByText('$200.00')).toBeInTheDocument();
    });

    it('shows empty state when no positions', async () => {
        mockedApi.getPositions.mockResolvedValue([]);

        renderWithQuery(<PositionsPage />);

        await waitFor(() => {
            expect(screen.getByText('활성 포지션이 없습니다')).toBeInTheDocument();
        });
    });

    it('shows error message on failure', async () => {
        mockedApi.getPositions.mockRejectedValue(new Error('Server down'));

        renderWithQuery(<PositionsPage />);

        await waitFor(() => {
            expect(screen.getByRole('alert')).toBeInTheDocument();
        });

        expect(screen.getByText('오류: Server down')).toBeInTheDocument();
    });

    // --- P&L display tests ---

    it('displays positive P&L for profitable long position', async () => {
        mockedApi.getPositions.mockResolvedValue([
            {
                id: 1,
                symbol: 'AAPL',
                side: 'long',
                quantity: 10,
                avgPrice: '150.00',
                currentPrice: '165.00',
                openedAt: '2026-05-20T10:00:00Z',
                status: 'open',
            },
        ]);

        renderWithQuery(<PositionsPage />);

        await waitFor(() => {
            expect(screen.getByText('+10.00%')).toBeInTheDocument();
        });
    });

    it('displays negative P&L for losing long position', async () => {
        mockedApi.getPositions.mockResolvedValue([
            {
                id: 1,
                symbol: 'AAPL',
                side: 'long',
                quantity: 10,
                avgPrice: '150.00',
                currentPrice: '135.00',
                openedAt: '2026-05-20T10:00:00Z',
                status: 'open',
            },
        ]);

        renderWithQuery(<PositionsPage />);

        await waitFor(() => {
            expect(screen.getByText('-10.00%')).toBeInTheDocument();
        });
    });

    it('displays positive P&L for profitable short position (price went down)', async () => {
        mockedApi.getPositions.mockResolvedValue([
            {
                id: 2,
                symbol: 'TSLA',
                side: 'short',
                quantity: 5,
                avgPrice: '200.00',
                currentPrice: '180.00',
                openedAt: '2026-05-21T14:00:00Z',
                status: 'open',
            },
        ]);

        renderWithQuery(<PositionsPage />);

        await waitFor(() => {
            expect(screen.getByText('+10.00%')).toBeInTheDocument();
        });
    });

    it('displays dash when currentPrice is not available', async () => {
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

        renderWithQuery(<PositionsPage />);

        await waitFor(() => {
            expect(screen.getByText('-')).toBeInTheDocument();
        });
    });

    // --- Current price display ---

    it('shows current price when available', async () => {
        mockedApi.getPositions.mockResolvedValue([mockPositions[0]]);

        renderWithQuery(<PositionsPage />);

        await waitFor(() => {
            expect(screen.getByText('$165.00')).toBeInTheDocument();
        });
    });

    // --- Close position button ---

    it('shows a close position button for each position', async () => {
        mockedApi.getPositions.mockResolvedValue(mockPositions);

        renderWithQuery(<PositionsPage />);

        await waitFor(() => {
            expect(screen.getByLabelText('AAPL 포지션 청산')).toBeInTheDocument();
        });

        expect(screen.getByLabelText('TSLA 포지션 청산')).toBeInTheDocument();
    });

    it('calls closePosition API when close button is clicked then confirmed', async () => {
        const user = userEvent.setup();
        mockedApi.getPositions.mockResolvedValue(mockPositions);
        mockedApi.closePosition.mockResolvedValue(undefined);

        renderWithQuery(<PositionsPage />);

        await waitFor(() => {
            expect(screen.getByLabelText('AAPL 포지션 청산')).toBeInTheDocument();
        });

        // First tap: shows inline confirm
        await user.click(screen.getByLabelText('AAPL 포지션 청산'));

        // Confirm dialog appears; closePosition NOT yet called
        expect(screen.getByText('정말 청산하시겠습니까?')).toBeInTheDocument();
        expect(mockedApi.closePosition).not.toHaveBeenCalled();

        // Second tap: confirm button (aria-label == 'AAPL 포지션 청산' on the confirm btn)
        await user.click(screen.getByLabelText('AAPL 포지션 청산'));

        expect(mockedApi.closePosition).toHaveBeenCalledWith(1);
    });

    it('cancel button dismisses the confirm dialog without calling closePosition', async () => {
        const user = userEvent.setup();
        mockedApi.getPositions.mockResolvedValue(mockPositions);
        mockedApi.closePosition.mockResolvedValue(undefined);

        renderWithQuery(<PositionsPage />);

        await waitFor(() => {
            expect(screen.getByLabelText('AAPL 포지션 청산')).toBeInTheDocument();
        });

        // Show confirm
        await user.click(screen.getByLabelText('AAPL 포지션 청산'));
        expect(screen.getByText('정말 청산하시겠습니까?')).toBeInTheDocument();

        // Cancel
        await user.click(screen.getByRole('button', { name: '취소' }));

        // Confirm dialog gone; closePosition never called
        expect(screen.queryByText('정말 청산하시겠습니까?')).not.toBeInTheDocument();
        expect(mockedApi.closePosition).not.toHaveBeenCalled();
        // The original 청산 button is back
        expect(screen.getByLabelText('AAPL 포지션 청산')).toBeInTheDocument();
    });

    it('optimistically removes the position while the close is pending', async () => {
        const user = userEvent.setup();
        mockedApi.getPositions.mockResolvedValue(mockPositions);
        // Never resolves: the row must disappear from the optimistic update alone.
        mockedApi.closePosition.mockReturnValue(new Promise(() => {}));

        renderWithQuery(<PositionsPage />);

        await waitFor(() => {
            expect(screen.getByLabelText('AAPL 포지션 청산')).toBeInTheDocument();
        });

        // Two-step: click 청산, then confirm
        await user.click(screen.getByLabelText('AAPL 포지션 청산'));
        await user.click(screen.getByLabelText('AAPL 포지션 청산'));

        await waitFor(() => {
            expect(screen.queryByLabelText('AAPL 포지션 청산')).not.toBeInTheDocument();
        });
    });

    it('restores the position and shows an error when close fails', async () => {
        const user = userEvent.setup();
        mockedApi.getPositions.mockResolvedValue(mockPositions);
        mockedApi.closePosition.mockRejectedValue(new Error('boom'));

        renderWithQuery(<PositionsPage />);

        await waitFor(() => {
            expect(screen.getByLabelText('AAPL 포지션 청산')).toBeInTheDocument();
        });

        // Two-step: click 청산, then confirm
        await user.click(screen.getByLabelText('AAPL 포지션 청산'));
        await user.click(screen.getByLabelText('AAPL 포지션 청산'));

        await waitFor(() => {
            expect(screen.getByText('포지션 청산에 실패했습니다')).toBeInTheDocument();
        });
        // Rolled back: the position is visible again.
        expect(screen.getByLabelText('AAPL 포지션 청산')).toBeInTheDocument();
    });

    // --- timeAgo display ---

    it('shows time ago for recently opened positions', async () => {
        mockedApi.getPositions.mockResolvedValue([
            {
                id: 1,
                symbol: 'NVDA',
                side: 'long',
                quantity: 3,
                avgPrice: '900.00',
                currentPrice: '910.00',
                openedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
                status: 'open',
            },
        ]);

        renderWithQuery(<PositionsPage />);

        await waitFor(() => {
            expect(screen.getByText('30분 전')).toBeInTheDocument();
        });
    });
});
