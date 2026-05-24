import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PendingPage } from '../Pending';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
    api: {
        getPending: vi.fn(),
        approveOrder: vi.fn(),
        rejectOrder: vi.fn(),
    },
}));

const mockedApi = vi.mocked(api);

function renderWithQuery(component: React.ReactElement) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(<QueryClientProvider client={queryClient}>{component}</QueryClientProvider>);
}

const mockOrders = [
    {
        id: 1,
        symbol: 'AAPL',
        side: 'buy',
        quantity: 10,
        priceLimit: '150.00',
        analysisSummary: 'Strong bullish signal',
        signalScore: '0.85',
        createdAt: '2026-05-24T10:00:00Z',
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        status: 'pending',
    },
    {
        id: 2,
        symbol: 'TSLA',
        side: 'sell',
        quantity: 5,
        priceLimit: null,
        analysisSummary: null,
        signalScore: '0.72',
        createdAt: '2026-05-24T11:00:00Z',
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        status: 'pending',
    },
];

describe('PendingPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('shows loading skeleton initially', () => {
        mockedApi.getPending.mockReturnValue(new Promise(() => {}));
        renderWithQuery(<PendingPage />);
        expect(screen.getByLabelText('로딩 중')).toBeInTheDocument();
    });

    it('displays pending orders with approve/reject buttons', async () => {
        mockedApi.getPending.mockResolvedValue(mockOrders);

        renderWithQuery(<PendingPage />);

        await waitFor(() => {
            expect(screen.getByText('승인 대기')).toBeInTheDocument();
        });

        expect(screen.getByText('AAPL')).toBeInTheDocument();
        expect(screen.getByText('매수')).toBeInTheDocument();
        expect(screen.getByText('10')).toBeInTheDocument();
        expect(screen.getByText('0.85')).toBeInTheDocument();
        expect(screen.getByText('$150.00')).toBeInTheDocument();
        expect(screen.getByText('Strong bullish signal')).toBeInTheDocument();

        expect(screen.getByText('TSLA')).toBeInTheDocument();
        expect(screen.getByText('매도')).toBeInTheDocument();
        expect(screen.getByText('5')).toBeInTheDocument();

        const approveButtons = screen.getAllByText('승인');
        const rejectButtons = screen.getAllByText('거부');
        expect(approveButtons).toHaveLength(2);
        expect(rejectButtons).toHaveLength(2);
    });

    it('calls approve API when approve button is clicked', async () => {
        const user = userEvent.setup();
        mockedApi.getPending.mockResolvedValue(mockOrders);
        mockedApi.approveOrder.mockResolvedValue(undefined);

        renderWithQuery(<PendingPage />);

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });

        await user.click(screen.getByLabelText('AAPL 승인'));

        expect(mockedApi.approveOrder).toHaveBeenCalledWith(1);
    });

    it('calls reject API when reject button is clicked', async () => {
        const user = userEvent.setup();
        mockedApi.getPending.mockResolvedValue(mockOrders);
        mockedApi.rejectOrder.mockResolvedValue(undefined);

        renderWithQuery(<PendingPage />);

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });

        await user.click(screen.getByLabelText('AAPL 거부'));

        expect(mockedApi.rejectOrder).toHaveBeenCalledWith(1);
    });

    it('shows empty state when no pending orders', async () => {
        mockedApi.getPending.mockResolvedValue([]);

        renderWithQuery(<PendingPage />);

        await waitFor(() => {
            expect(screen.getByText('승인 대기 중인 주문이 없습니다')).toBeInTheDocument();
        });
    });

    it('shows error message on failure', async () => {
        mockedApi.getPending.mockRejectedValue(new Error('Connection refused'));

        renderWithQuery(<PendingPage />);

        await waitFor(() => {
            expect(screen.getByRole('alert')).toBeInTheDocument();
        });

        expect(screen.getByText('오류: Connection refused')).toBeInTheDocument();
    });

    it('shows loading state on approve button while mutation is pending', async () => {
        const user = userEvent.setup();
        mockedApi.getPending.mockResolvedValue(mockOrders);
        mockedApi.approveOrder.mockReturnValue(new Promise(() => {}));

        renderWithQuery(<PendingPage />);

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });

        await user.click(screen.getByLabelText('AAPL 승인'));

        await waitFor(() => {
            expect(screen.getAllByText('처리 중...').length).toBeGreaterThanOrEqual(1);
        });
    });

    // --- Optimistic update tests ---

    it('removes order from list immediately after approve (optimistic update)', async () => {
        const user = userEvent.setup();
        // First call returns both, subsequent refetch after mutation returns only TSLA
        mockedApi.getPending.mockResolvedValueOnce(mockOrders).mockResolvedValue([mockOrders[1]]);
        mockedApi.approveOrder.mockResolvedValue(undefined);

        renderWithQuery(<PendingPage />);

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });

        await user.click(screen.getByLabelText('AAPL 승인'));

        await waitFor(() => {
            expect(screen.queryByText('AAPL')).not.toBeInTheDocument();
        });

        expect(screen.getByText('TSLA')).toBeInTheDocument();
    });

    it('removes order from list immediately after reject (optimistic update)', async () => {
        const user = userEvent.setup();
        // First call returns both, subsequent refetch after mutation returns only AAPL
        mockedApi.getPending.mockResolvedValueOnce(mockOrders).mockResolvedValue([mockOrders[0]]);
        mockedApi.rejectOrder.mockResolvedValue(undefined);

        renderWithQuery(<PendingPage />);

        await waitFor(() => {
            expect(screen.getByText('TSLA')).toBeInTheDocument();
        });

        await user.click(screen.getByLabelText('TSLA 거부'));

        await waitFor(() => {
            expect(screen.queryByText('TSLA')).not.toBeInTheDocument();
        });

        expect(screen.getByText('AAPL')).toBeInTheDocument();
    });

    // --- Feedback message tests ---

    it('shows success feedback after approve', async () => {
        const user = userEvent.setup();
        mockedApi.getPending.mockResolvedValue(mockOrders);
        mockedApi.approveOrder.mockResolvedValue(undefined);

        renderWithQuery(<PendingPage />);

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });

        await user.click(screen.getByLabelText('AAPL 승인'));

        await waitFor(() => {
            expect(screen.getByText('주문이 승인되었습니다')).toBeInTheDocument();
        });
    });

    it('shows success feedback after reject', async () => {
        const user = userEvent.setup();
        mockedApi.getPending.mockResolvedValue(mockOrders);
        mockedApi.rejectOrder.mockResolvedValue(undefined);

        renderWithQuery(<PendingPage />);

        await waitFor(() => {
            expect(screen.getByText('TSLA')).toBeInTheDocument();
        });

        await user.click(screen.getByLabelText('TSLA 거부'));

        await waitFor(() => {
            expect(screen.getByText('주문이 거부되었습니다')).toBeInTheDocument();
        });
    });

    it('shows error feedback and restores order on approve failure', async () => {
        const user = userEvent.setup();
        mockedApi.getPending.mockResolvedValue(mockOrders);
        mockedApi.approveOrder.mockRejectedValue(new Error('Server error'));

        renderWithQuery(<PendingPage />);

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });

        await user.click(screen.getByLabelText('AAPL 승인'));

        await waitFor(() => {
            expect(screen.getByText('승인 처리에 실패했습니다')).toBeInTheDocument();
        });

        // Order should be restored after rollback
        expect(screen.getByText('AAPL')).toBeInTheDocument();
    });

    it('shows error feedback and restores order on reject failure', async () => {
        const user = userEvent.setup();
        mockedApi.getPending.mockResolvedValue(mockOrders);
        mockedApi.rejectOrder.mockRejectedValue(new Error('Server error'));

        renderWithQuery(<PendingPage />);

        await waitFor(() => {
            expect(screen.getByText('TSLA')).toBeInTheDocument();
        });

        await user.click(screen.getByLabelText('TSLA 거부'));

        await waitFor(() => {
            expect(screen.getByText('거부 처리에 실패했습니다')).toBeInTheDocument();
        });

        // Order should be restored after rollback
        expect(screen.getByText('TSLA')).toBeInTheDocument();
    });

    // --- Expiry display ---

    it('shows time remaining for pending orders', async () => {
        mockedApi.getPending.mockResolvedValue([
            {
                ...mockOrders[0],
                expiresAt: new Date(Date.now() + 90 * 60_000).toISOString(),
            },
        ]);

        renderWithQuery(<PendingPage />);

        await waitFor(() => {
            // 90 minutes = 1 hour 30 minutes
            expect(screen.getByText(/1시간.*분 남음/)).toBeInTheDocument();
        });
    });

    it('shows "만료됨" for expired orders', async () => {
        mockedApi.getPending.mockResolvedValue([
            {
                ...mockOrders[0],
                expiresAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            },
        ]);

        renderWithQuery(<PendingPage />);

        await waitFor(() => {
            expect(screen.getByText('만료됨')).toBeInTheDocument();
        });
    });

    // --- Accessibility ---

    it('has aria-labels on approve and reject buttons', async () => {
        mockedApi.getPending.mockResolvedValue(mockOrders);

        renderWithQuery(<PendingPage />);

        await waitFor(() => {
            expect(screen.getByLabelText('AAPL 승인')).toBeInTheDocument();
        });

        expect(screen.getByLabelText('AAPL 거부')).toBeInTheDocument();
        expect(screen.getByLabelText('TSLA 승인')).toBeInTheDocument();
        expect(screen.getByLabelText('TSLA 거부')).toBeInTheDocument();
    });
});
