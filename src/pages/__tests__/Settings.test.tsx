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
        searchTickers: vi.fn(),
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
        { key: 'trading_mode', value: 'dry_run', updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'max_position_size', value: 5000, updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'max_total_exposure', value: 25000, updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'stop_loss_percent', value: 5, updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'take_profit_percent', value: 10, updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'buy_threshold', value: 0.7, updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'sell_threshold', value: -0.7, updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'fixed_exit_enabled', value: false, updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'trading_enabled', value: true, updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'max_trades_per_day', value: 20, updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'max_daily_loss_usd', value: 500, updatedAt: '2026-01-01T00:00:00Z' },
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

        expect(screen.getByText('시스템 제어')).toBeInTheDocument();
        expect(screen.getByText('일반')).toBeInTheDocument();
        expect(screen.getByText('감시 종목')).toBeInTheDocument();
        expect(screen.getByText('분석 설정')).toBeInTheDocument();
        expect(screen.getByText('고정 손절/익절')).toBeInTheDocument();
        expect(screen.getByText('투자 관리')).toBeInTheDocument();
        expect(screen.getByText('AI 매매 신호 기준')).toBeInTheDocument();
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

    it('does not auto-save trading mode on select change', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('설정')).toBeInTheDocument();
        });

        const select = screen.getByDisplayValue('모의투자 (DRY_RUN)');
        await user.selectOptions(select, 'semi_auto');

        expect(mockedApi.updateConfig).not.toHaveBeenCalled();
    });

    it('shows save/cancel buttons when trading mode is changed', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('설정')).toBeInTheDocument();
        });

        // No save/cancel buttons initially
        expect(screen.queryByText('저장')).not.toBeInTheDocument();
        expect(screen.queryByText('취소')).not.toBeInTheDocument();

        const select = screen.getByDisplayValue('모의투자 (DRY_RUN)');
        await user.selectOptions(select, 'semi_auto');

        // Save/cancel buttons appear
        expect(screen.getByText('저장')).toBeInTheDocument();
        expect(screen.getByText('취소')).toBeInTheDocument();
    });

    it('saves trading mode when save button is clicked', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('설정')).toBeInTheDocument();
        });

        const select = screen.getByDisplayValue('모의투자 (DRY_RUN)');
        await user.selectOptions(select, 'semi_auto');

        const saveButton = screen.getByText('저장');
        await user.click(saveButton);

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'config',
            key: 'trading_mode',
            value: 'semi_auto',
        });
    });

    it('reverts trading mode when cancel button is clicked', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('설정')).toBeInTheDocument();
        });

        const select = screen.getByDisplayValue('모의투자 (DRY_RUN)');
        await user.selectOptions(select, 'semi_auto');

        // Buttons visible
        expect(screen.getByText('저장')).toBeInTheDocument();

        const cancelButton = screen.getByText('취소');
        await user.click(cancelButton);

        // Buttons should disappear and mode should revert
        expect(screen.queryByText('저장')).not.toBeInTheDocument();
        expect(screen.queryByText('취소')).not.toBeInTheDocument();
        expect(mockedApi.updateConfig).not.toHaveBeenCalled();
    });

    it('shows mode description for current trading mode', async () => {
        mockedApi.getConfig.mockResolvedValue(mockConfig);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('설정')).toBeInTheDocument();
        });

        expect(
            screen.getByText('실제 주문 없이 가상 거래만 기록합니다. 전략 검증에 적합합니다.'),
        ).toBeInTheDocument();
    });

    it('adds a new symbol to the watchlist via ticker search', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);
        mockedApi.searchTickers.mockResolvedValue([
            { symbol: 'NVDA', name: 'NVIDIA Corporation', exchange: 'NASDAQ' },
        ]);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('감시 종목')).toBeInTheDocument();
        });

        const searchInput = screen.getByLabelText('종목 검색');
        await user.type(searchInput, 'NV');

        await waitFor(() => {
            expect(screen.getByText('NVDA')).toBeInTheDocument();
        });

        const nvdaButton = screen.getByText('NVDA').closest('button')!;
        await user.click(nvdaButton);

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'watchlist',
            action: 'add',
            symbol: 'NVDA',
            companyName: 'NVIDIA Corporation',
        });
    });

    it('optimistically shows the new symbol before the request resolves', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        // Never resolves: the new item must appear from the optimistic update alone.
        mockedApi.updateConfig.mockReturnValue(new Promise(() => {}));
        mockedApi.searchTickers.mockResolvedValue([
            { symbol: 'NVDA', name: 'NVIDIA Corporation', exchange: 'NASDAQ' },
        ]);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('감시 종목')).toBeInTheDocument();
        });

        await user.type(screen.getByLabelText('종목 검색'), 'NV');
        await waitFor(() => {
            expect(screen.getByText('NVDA')).toBeInTheDocument();
        });
        await user.click(screen.getByText('NVDA').closest('button')!);

        // The new symbol is inserted into the watchlist immediately (it now has a
        // 삭제 button), without waiting for the server round-trip or a refetch.
        await waitFor(() => {
            expect(screen.getByLabelText('NVDA 삭제')).toBeInTheDocument();
        });
        expect(mockedApi.getConfig).toHaveBeenCalledTimes(1);
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

        // Use semi_auto to test error without confirmation step
        const select = screen.getByDisplayValue('모의투자 (DRY_RUN)');
        await user.selectOptions(select, 'semi_auto');

        const saveButton = screen.getByText('저장');
        await user.click(saveButton);

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
        await user.selectOptions(select, 'semi_auto');

        const saveButton = screen.getByText('저장');
        await user.click(saveButton);

        await waitFor(() => {
            expect(screen.getByText('저장되었습니다')).toBeInTheDocument();
        });
    });

    // -----------------------------------------------------------------------
    // Auto mode confirmation dialog
    // -----------------------------------------------------------------------

    it('shows confirmation dialog when saving auto mode', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('설정')).toBeInTheDocument();
        });

        const select = screen.getByDisplayValue('모의투자 (DRY_RUN)');
        await user.selectOptions(select, 'auto');

        const saveButton = screen.getByText('저장');
        await user.click(saveButton);

        // Should show confirmation dialog, not save yet
        expect(
            screen.getByText(/자동 모드에서는 매매 신호 발생 시 즉시 주문이 실행됩니다/),
        ).toBeInTheDocument();
        expect(screen.getByText('확인, 자동 모드 활성화')).toBeInTheDocument();
        expect(mockedApi.updateConfig).not.toHaveBeenCalled();
    });

    it('saves auto mode after confirmation', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('설정')).toBeInTheDocument();
        });

        const select = screen.getByDisplayValue('모의투자 (DRY_RUN)');
        await user.selectOptions(select, 'auto');

        await user.click(screen.getByText('저장'));

        // Confirm
        await user.click(screen.getByText('확인, 자동 모드 활성화'));

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'config',
            key: 'trading_mode',
            value: 'auto',
        });
    });

    it('cancels auto mode confirmation and reverts', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('설정')).toBeInTheDocument();
        });

        const select = screen.getByDisplayValue('모의투자 (DRY_RUN)');
        await user.selectOptions(select, 'auto');

        await user.click(screen.getByText('저장'));

        // Cancel the confirmation
        await user.click(screen.getByText('취소'));

        // Confirmation dialog should disappear
        expect(
            screen.queryByText(/자동 모드에서는 매매 신호 발생 시 즉시 주문이 실행됩니다/),
        ).not.toBeInTheDocument();
        expect(mockedApi.updateConfig).not.toHaveBeenCalled();
    });

    it('does not show confirmation for semi_auto mode', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('설정')).toBeInTheDocument();
        });

        const select = screen.getByDisplayValue('모의투자 (DRY_RUN)');
        await user.selectOptions(select, 'semi_auto');

        await user.click(screen.getByText('저장'));

        // Should directly save without confirmation
        expect(
            screen.queryByText(/자동 모드에서는 매매 신호 발생 시 즉시 주문이 실행됩니다/),
        ).not.toBeInTheDocument();
        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'config',
            key: 'trading_mode',
            value: 'semi_auto',
        });
    });

    it('rejects duplicate symbol and shows error message', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);
        mockedApi.searchTickers.mockResolvedValue([
            { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ' },
        ]);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('감시 종목')).toBeInTheDocument();
        });

        const searchInput = screen.getByLabelText('종목 검색');
        await user.type(searchInput, 'AAPL');

        await waitFor(() => {
            expect(screen.getByRole('listbox')).toBeInTheDocument();
        });

        // Select the AAPL result from the dropdown (which is already in the watchlist)
        const aaplOption = screen
            .getAllByText('AAPL')
            .find((el) => el.closest('[role="option"]') != null)!;
        await user.click(aaplOption.closest('button')!);

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

    it('does not save risk values on blur', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('투자 관리')).toBeInTheDocument();
        });

        const stopLossInput = screen.getByDisplayValue('5');
        await user.clear(stopLossInput);
        await user.type(stopLossInput, '7');
        await user.tab();

        expect(mockedApi.updateConfig).not.toHaveBeenCalled();
    });

    it('shows save button when risk values are changed', async () => {
        const user = userEvent.setup();
        const enabledConfig = {
            ...mockConfig,
            config: mockConfig.config.map((c) =>
                c.key === 'fixed_exit_enabled' ? { ...c, value: true } : c,
            ),
        };
        mockedApi.getConfig.mockResolvedValue(enabledConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('투자 관리')).toBeInTheDocument();
        });

        const stopLossInput = screen.getByDisplayValue('5');
        await user.clear(stopLossInput);
        await user.type(stopLossInput, '7');

        // Save button should appear (floating below sections)
        expect(screen.getByRole('button', { name: '저장' })).toBeInTheDocument();
    });

    it('saves all changed risk values when save button is clicked', async () => {
        const user = userEvent.setup();
        const enabledConfig = {
            ...mockConfig,
            config: mockConfig.config.map((c) =>
                c.key === 'fixed_exit_enabled' ? { ...c, value: true } : c,
            ),
        };
        mockedApi.getConfig.mockResolvedValue(enabledConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('투자 관리')).toBeInTheDocument();
        });

        const stopLossInput = screen.getByDisplayValue('5');
        await user.clear(stopLossInput);
        await user.type(stopLossInput, '7');

        const takeProfitInput = screen.getByDisplayValue('10');
        await user.clear(takeProfitInput);
        await user.type(takeProfitInput, '15');

        await user.click(screen.getByRole('button', { name: '저장' }));

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'config',
            key: 'stop_loss_percent',
            value: 7,
        });
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

    it('risk cancel button reverts changes and hides buttons', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('투자 관리')).toBeInTheDocument();
        });

        const buyThresholdInput = screen.getByDisplayValue('0.7');
        await user.clear(buyThresholdInput);
        await user.type(buyThresholdInput, '0.8');

        await user.click(screen.getByRole('button', { name: '취소' }));

        // Save/cancel buttons should disappear
        expect(screen.queryByRole('button', { name: '저장' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: '취소' })).not.toBeInTheDocument();

        expect(mockedApi.updateConfig).not.toHaveBeenCalled();
    });

    it('renders ticker search input in watchlist section', async () => {
        mockedApi.getConfig.mockResolvedValue(mockConfig);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('감시 종목')).toBeInTheDocument();
        });

        expect(screen.getByLabelText('종목 검색')).toBeInTheDocument();
    });

    it('renders fixed exit toggle in risk section showing OFF by default', async () => {
        mockedApi.getConfig.mockResolvedValue(mockConfig);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('투자 관리')).toBeInTheDocument();
        });

        expect(screen.getByText('고정 손절/익절')).toBeInTheDocument();
        expect(screen.getByText('OFF 시 AI 분석 기반으로만 판단합니다')).toBeInTheDocument();
        expect(screen.getByLabelText('고정 손절/익절 활성화')).toHaveTextContent('OFF');
    });

    it('toggles fixed exit enabled on click and calls API', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('고정 손절/익절')).toBeInTheDocument();
        });

        const toggleButton = screen.getByLabelText('고정 손절/익절 활성화');
        await user.click(toggleButton);

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'config',
            key: 'fixed_exit_enabled',
            value: true,
        });
    });

    it('greys out stop_loss and take_profit inputs when fixed exit is disabled', async () => {
        mockedApi.getConfig.mockResolvedValue(mockConfig);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('투자 관리')).toBeInTheDocument();
        });

        // The grid containing stop_loss and take_profit inputs should be greyed out
        const stopLossInput = screen.getByDisplayValue('5');
        const gridContainer = stopLossInput.closest('.grid');
        expect(gridContainer).toHaveClass('opacity-40');
    });

    it('does not grey out stop_loss and take_profit inputs when fixed exit is enabled', async () => {
        const enabledConfig = {
            ...mockConfig,
            config: mockConfig.config.map((c) =>
                c.key === 'fixed_exit_enabled' ? { ...c, value: true } : c,
            ),
        };
        mockedApi.getConfig.mockResolvedValue(enabledConfig);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('투자 관리')).toBeInTheDocument();
        });

        const stopLossInput = screen.getByDisplayValue('5');
        const gridContainer = stopLossInput.closest('.grid');
        expect(gridContainer).not.toHaveClass('opacity-40');
    });

    // -----------------------------------------------------------------------
    // Kill switch (trading_enabled)
    // -----------------------------------------------------------------------

    it('shows kill switch toggle in system control section as ON', async () => {
        mockedApi.getConfig.mockResolvedValue(mockConfig);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('시스템 제어')).toBeInTheDocument();
        });

        expect(screen.getByText('자동매매 활성화')).toBeInTheDocument();
        expect(screen.getByText('OFF 시 모든 자동 매매가 중지됩니다')).toBeInTheDocument();
        expect(screen.getByLabelText('자동매매 비활성화')).toHaveTextContent('ON');
    });

    it('toggles kill switch off and calls API', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('시스템 제어')).toBeInTheDocument();
        });

        const toggleButton = screen.getByLabelText('자동매매 비활성화');
        await user.click(toggleButton);

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'config',
            key: 'trading_enabled',
            value: false,
        });
    });

    it('shows kill switch as OFF when trading_enabled is false', async () => {
        const disabledConfig = {
            ...mockConfig,
            config: mockConfig.config.map((c) =>
                c.key === 'trading_enabled' ? { ...c, value: false } : c,
            ),
        };
        mockedApi.getConfig.mockResolvedValue(disabledConfig);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('시스템 제어')).toBeInTheDocument();
        });

        expect(screen.getByLabelText('자동매매 활성화')).toHaveTextContent('OFF');
    });

    // -----------------------------------------------------------------------
    // Circuit breaker config fields
    // -----------------------------------------------------------------------

    it('displays max_trades_per_day and max_daily_loss_usd in investment section', async () => {
        mockedApi.getConfig.mockResolvedValue(mockConfig);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('투자 관리')).toBeInTheDocument();
        });

        expect(screen.getByText('일일 최대 거래 횟수')).toBeInTheDocument();
        expect(screen.getByText('일일 최대 손실 한도 ($)')).toBeInTheDocument();
    });

    // -----------------------------------------------------------------------
    // L15 — risk save partial failure surfacing
    // -----------------------------------------------------------------------

    it('shows error message when a risk field save fails server-side', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        // Simulate a server 400: updateConfig rejects on any call
        mockedApi.updateConfig.mockRejectedValue(new Error('buy_threshold validation failed'));

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('투자 관리')).toBeInTheDocument();
        });

        const buyThresholdInput = screen.getByDisplayValue('0.7');
        await user.clear(buyThresholdInput);
        await user.type(buyThresholdInput, '0.8');

        await user.click(screen.getByRole('button', { name: '저장' }));

        await waitFor(() => {
            const msg = screen.getByRole('status');
            expect(msg.textContent).toMatch(/오류/);
        });
    });

    it('shows success when all risk field saves succeed', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('투자 관리')).toBeInTheDocument();
        });

        const buyThresholdInput = screen.getByDisplayValue('0.7');
        await user.clear(buyThresholdInput);
        await user.type(buyThresholdInput, '0.8');

        await user.click(screen.getByRole('button', { name: '저장' }));

        await waitFor(() => {
            expect(screen.getByText('설정이 저장되었습니다')).toBeInTheDocument();
        });
    });
});
