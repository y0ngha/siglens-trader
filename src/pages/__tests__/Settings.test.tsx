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
    config: [
        { key: 'trading_mode', value: 'DRY_RUN', updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'max_position_size', value: 5000, updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'max_total_exposure', value: 25000, updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'stop_loss_percent', value: 5, updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'take_profit_percent', value: 10, updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'buy_threshold', value: 0.7, updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'sell_threshold', value: -0.7, updatedAt: '2026-01-01T00:00:00Z' },
    ],
    watchlist: [
        {
            id: 1,
            symbol: 'AAPL',
            companyName: 'Apple Inc.',
            enabled: true,
            createdAt: '2026-01-01T00:00:00Z',
        },
        {
            id: 2,
            symbol: 'TSLA',
            companyName: 'Tesla Inc.',
            enabled: false,
            createdAt: '2026-01-01T00:00:00Z',
        },
    ],
    analysis: [
        {
            id: 1,
            analysisType: 'technical',
            enabled: true,
            modelId: 'gemini-2.5-flash',
            useByok: false,
            updatedAt: '2026-01-01T00:00:00Z',
        },
        {
            id: 2,
            analysisType: 'news',
            enabled: true,
            modelId: 'claude-sonnet-4-6',
            useByok: false,
            updatedAt: '2026-01-01T00:00:00Z',
        },
        {
            id: 3,
            analysisType: 'options',
            enabled: false,
            modelId: 'gpt-5-mini',
            useByok: true,
            updatedAt: '2026-01-01T00:00:00Z',
        },
        {
            id: 4,
            analysisType: 'fundamental',
            enabled: true,
            modelId: 'gemini-2.5-pro',
            useByok: false,
            updatedAt: '2026-01-01T00:00:00Z',
        },
    ],
    notification: [
        {
            id: 1,
            channel: 'email',
            enabled: true,
            target: 'user@example.com',
            events: ['trade_executed', 'stop_loss'],
        },
    ],
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

    it('changes trading mode and calls API with config type', async () => {
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
            type: 'config',
            key: 'trading_mode',
            value: 'SEMI_AUTO',
        });
    });

    it('adds a new symbol to the watchlist with action-based API', async () => {
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

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'watchlist',
            action: 'add',
            symbol: 'NVDA',
            companyName: 'NVIDIA',
        });
    });

    it('removes a symbol from watchlist using id', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });

        const deleteButton = screen.getByLabelText('AAPL 삭제');
        await user.click(deleteButton);

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'watchlist',
            action: 'remove',
            id: 1,
        });
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

    it('rejects duplicate symbol and shows error message', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('감시 종목')).toBeInTheDocument();
        });

        const symbolInput = screen.getByPlaceholderText('종목 코드');
        const addButton = screen.getByText('추가');

        await user.type(symbolInput, 'aapl');
        await user.click(addButton);

        await waitFor(() => {
            expect(screen.getByText('이미 등록된 종목입니다')).toBeInTheDocument();
        });

        expect(mockedApi.updateConfig).not.toHaveBeenCalled();
    });

    it('changing analysis model dropdown calls API with analysisType', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('분석 설정')).toBeInTheDocument();
        });

        const modelSelects = screen.getAllByDisplayValue('gemini-2.5-flash');
        await user.selectOptions(modelSelects[0], 'claude-sonnet-4-6');

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'analysis',
            analysisType: 'technical',
            updates: { modelId: 'claude-sonnet-4-6' },
        });
    });

    it('toggling BYOK button calls API with analysisType', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('분석 설정')).toBeInTheDocument();
        });

        const byokButtons = screen.getAllByText('BYOK');
        // Click the first BYOK button (technical analysis - currently false)
        await user.click(byokButtons[0]);

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'analysis',
            analysisType: 'technical',
            updates: { useByok: true },
        });
    });

    it('changing stop loss value calls API on blur', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('리스크 관리')).toBeInTheDocument();
        });

        const stopLossInput = screen.getByDisplayValue('5');
        await user.clear(stopLossInput);
        await user.type(stopLossInput, '7');
        await user.tab();

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'config',
            key: 'stop_loss_percent',
            value: 7,
        });
    });

    it('changing take profit value calls API on blur', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('리스크 관리')).toBeInTheDocument();
        });

        const takeProfitInput = screen.getByDisplayValue('10');
        await user.clear(takeProfitInput);
        await user.type(takeProfitInput, '15');
        await user.tab();

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'config',
            key: 'take_profit_percent',
            value: 15,
        });
    });

    it('notification event checkbox toggle calls API with channel', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('알림')).toBeInTheDocument();
        });

        // 'order_pending' is not in the initial events, so check it
        const orderPendingCheckbox = screen.getByLabelText('주문 승인 대기');
        await user.click(orderPendingCheckbox);

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'notification',
            channel: 'email',
            updates: {
                events: ['trade_executed', 'stop_loss', 'order_pending'],
            },
        });
    });

    it('toggles email notification on/off', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('이메일 알림')).toBeInTheDocument();
        });

        // The email toggle is the ON button next to "이메일 알림" text
        const emailLabel = screen.getByText('이메일 알림');
        const emailToggle = emailLabel.parentElement!.querySelector('button')!;
        await user.click(emailToggle);

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'notification',
            channel: 'email',
            updates: { enabled: false },
        });
    });

    it('toggles watchlist symbol enabled state using id', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('AAPL')).toBeInTheDocument();
        });

        const toggleButton = screen.getByLabelText('AAPL 비활성화');
        await user.click(toggleButton);

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'watchlist',
            action: 'toggle',
            id: 1,
            enabled: false,
        });
    });

    it('toggles analysis type enabled state', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('분석 설정')).toBeInTheDocument();
        });

        // Toggle the 'options' analysis (currently disabled) ON
        const optionsToggle = screen.getByLabelText('옵션 분석 활성화');
        await user.click(optionsToggle);

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'analysis',
            analysisType: 'options',
            updates: { enabled: true },
        });
    });

    it('unchecking a notification event removes it', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('알림')).toBeInTheDocument();
        });

        // 'trade_executed' is in the initial events, so uncheck it
        const tradeExecutedCheckbox = screen.getByLabelText('거래 체결');
        await user.click(tradeExecutedCheckbox);

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'notification',
            channel: 'email',
            updates: {
                events: ['stop_loss'],
            },
        });
    });

    it('changing buy threshold calls API on blur', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('리스크 관리')).toBeInTheDocument();
        });

        const buyThresholdInput = screen.getByDisplayValue('0.7');
        await user.clear(buyThresholdInput);
        await user.type(buyThresholdInput, '0.8');
        await user.tab();

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'config',
            key: 'buy_threshold',
            value: 0.8,
        });
    });

    it('changing sell threshold calls API on blur', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('리스크 관리')).toBeInTheDocument();
        });

        const sellThresholdInput = screen.getByDisplayValue('-0.7');
        await user.clear(sellThresholdInput);
        await user.type(sellThresholdInput, '0.5');
        await user.tab();

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'config',
            key: 'sell_threshold',
            value: 0.5,
        });
    });

    it('adds symbol with default companyName when name is empty', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('감시 종목')).toBeInTheDocument();
        });

        const symbolInput = screen.getByPlaceholderText('종목 코드');
        const addButton = screen.getByText('추가');

        await user.type(symbolInput, 'MSFT');
        await user.click(addButton);

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'watchlist',
            action: 'add',
            symbol: 'MSFT',
            companyName: 'MSFT',
        });
    });
});
