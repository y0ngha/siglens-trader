import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { StatusPage } from '../Status';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
    api: {
        getStatus: vi.fn(),
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

describe('StatusPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockedApi.getTrades.mockResolvedValue([]);
    });

    it('shows loading skeleton initially', () => {
        mockedApi.getStatus.mockReturnValue(new Promise(() => {}));
        renderWithQuery(<StatusPage />);
        expect(screen.getByLabelText('로딩 중')).toBeInTheDocument();
    });

    it('displays status data when loaded', async () => {
        mockedApi.getStatus.mockResolvedValue({
            running: true,
            tradingMode: 'paper',
            activePositions: 3,
            todayTrades: 7,
        });

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

    // --- Latest trade display tests ---

    it('shows latest trade info when trades exist', async () => {
        mockedApi.getStatus.mockResolvedValue({
            running: true,
            tradingMode: 'paper',
            activePositions: 1,
            todayTrades: 1,
        });
        mockedApi.getTrades.mockResolvedValue([
            {
                id: 1,
                symbol: 'AAPL',
                side: 'buy',
                orderType: 'market',
                quantity: 10,
                price: '175.50',
                executedAt: '2026-05-24T14:30:00Z',
                reason: null,
                mode: 'paper',
            },
        ]);

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });

        expect(screen.getByText('매수')).toBeInTheDocument();
        expect(screen.getByText('$175.50')).toBeInTheDocument();
    });

    it('shows "거래 내역 없음" when no trades', async () => {
        mockedApi.getStatus.mockResolvedValue({
            running: true,
            tradingMode: 'paper',
            activePositions: 0,
            todayTrades: 0,
        });
        mockedApi.getTrades.mockResolvedValue([]);

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByText('거래 내역 없음')).toBeInTheDocument();
        });
    });

    it('shows sell trade with red badge', async () => {
        mockedApi.getStatus.mockResolvedValue({
            running: true,
            tradingMode: 'auto',
            activePositions: 0,
            todayTrades: 1,
        });
        mockedApi.getTrades.mockResolvedValue([
            {
                id: 2,
                symbol: 'TSLA',
                side: 'sell',
                orderType: 'limit',
                quantity: 5,
                price: '200.00',
                executedAt: '2026-05-24T15:00:00Z',
                reason: null,
                mode: 'auto',
            },
        ]);

        renderWithQuery(<StatusPage />);

        await waitFor(() => {
            expect(screen.getByText('TSLA')).toBeInTheDocument();
        });

        expect(screen.getByText('매도')).toBeInTheDocument();
        expect(screen.getByText('$200.00')).toBeInTheDocument();
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
});
