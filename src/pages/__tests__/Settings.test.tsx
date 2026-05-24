import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SettingsPage } from '../Settings';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
    api: {
        getConfig: vi.fn(),
        updateConfig: vi.fn(),
    },
}));

const mockedApi = vi.mocked(api);

function renderWithQuery(component: React.ReactElement) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(<QueryClientProvider client={queryClient}>{component}</QueryClientProvider>);
}

const mockConfig = {
    tradingMode: 'DRY_RUN',
    watchlist: [
        { symbol: 'AAPL', name: 'Apple Inc.', enabled: true },
        { symbol: 'TSLA', name: 'Tesla Inc.', enabled: false },
    ],
    analysis: [
        { type: 'technical', enabled: true, model: 'gemini-2.5-flash', byok: false },
        { type: 'news', enabled: true, model: 'claude-sonnet-4-6', byok: false },
        { type: 'options', enabled: false, model: 'gpt-5-mini', byok: true },
        { type: 'fundamental', enabled: true, model: 'gemini-2.5-pro', byok: false },
    ],
    risk: {
        maxPositionSize: 5000,
        maxTotalExposure: 25000,
        stopLossPercent: 5,
        takeProfitPercent: 10,
        buyThreshold: 0.7,
        sellThreshold: -0.7,
    },
    notifications: {
        emailEnabled: true,
        events: ['trade_executed', 'stop_loss'],
    },
};

describe('SettingsPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('shows loading skeleton initially', () => {
        mockedApi.getConfig.mockReturnValue(new Promise(() => {}));
        renderWithQuery(<SettingsPage />);
        expect(screen.getByLabelText('로딩 중')).toBeInTheDocument();
    });

    it('renders all config sections when loaded', async () => {
        mockedApi.getConfig.mockResolvedValue(mockConfig);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('설정')).toBeInTheDocument();
        });

        expect(screen.getByText('일반')).toBeInTheDocument();
        expect(screen.getByText('감시 종목')).toBeInTheDocument();
        expect(screen.getByText('분석 설정')).toBeInTheDocument();
        expect(screen.getByText('리스크 관리')).toBeInTheDocument();
        expect(screen.getByText('알림')).toBeInTheDocument();
    });

    it('displays watchlist items', async () => {
        mockedApi.getConfig.mockResolvedValue(mockConfig);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });

        expect(screen.getByText('Apple Inc.')).toBeInTheDocument();
        expect(screen.getByText('TSLA')).toBeInTheDocument();
        expect(screen.getByText('Tesla Inc.')).toBeInTheDocument();
    });

    it('changes trading mode and calls API', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('설정')).toBeInTheDocument();
        });

        const select = screen.getByDisplayValue('모의투자 (DRY_RUN)');
        await user.selectOptions(select, 'SEMI_AUTO');

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'general',
            tradingMode: 'SEMI_AUTO',
        });
    });

    it('adds a new symbol to the watchlist', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('감시 종목')).toBeInTheDocument();
        });

        const symbolInput = screen.getByPlaceholderText('종목 코드');
        const nameInput = screen.getByPlaceholderText('회사명');
        const addButton = screen.getByText('추가');

        await user.type(symbolInput, 'NVDA');
        await user.type(nameInput, 'NVIDIA');
        await user.click(addButton);

        expect(mockedApi.updateConfig).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'watchlist',
                watchlist: expect.arrayContaining([
                    expect.objectContaining({ symbol: 'NVDA', name: 'NVIDIA', enabled: true }),
                ]),
            }),
        );
    });

    it('removes a symbol from watchlist', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });

        const deleteButton = screen.getByLabelText('AAPL 삭제');
        await user.click(deleteButton);

        expect(mockedApi.updateConfig).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'watchlist',
                watchlist: expect.not.arrayContaining([
                    expect.objectContaining({ symbol: 'AAPL' }),
                ]),
            }),
        );
    });

    it('shows error message on failure', async () => {
        mockedApi.getConfig.mockRejectedValue(new Error('Config unavailable'));

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByRole('alert')).toBeInTheDocument();
        });

        expect(screen.getByText('오류: Config unavailable')).toBeInTheDocument();
    });

    it('shows save error feedback', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockRejectedValue(new Error('Save failed'));

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('설정')).toBeInTheDocument();
        });

        const select = screen.getByDisplayValue('모의투자 (DRY_RUN)');
        await user.selectOptions(select, 'AUTO');

        await waitFor(() => {
            expect(screen.getByText('오류: Save failed')).toBeInTheDocument();
        });
    });

    it('shows success feedback after save', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('설정')).toBeInTheDocument();
        });

        const select = screen.getByDisplayValue('모의투자 (DRY_RUN)');
        await user.selectOptions(select, 'AUTO');

        await waitFor(() => {
            expect(screen.getByText('저장되었습니다')).toBeInTheDocument();
        });
    });
});
