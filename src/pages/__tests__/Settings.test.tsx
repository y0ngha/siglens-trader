import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SettingsPage } from '../Settings';
import { api, ApiError } from '@/lib/api';

// `ApiError` is imported for real (via importOriginal) so Settings.tsx's
// `err instanceof ApiError` check still works when a mocked call rejects with one (C5).
vi.mock('@/lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/api')>();
    return {
        ...actual,
        api: {
            getConfig: vi.fn(),
            updateConfig: vi.fn(),
            searchTickers: vi.fn(),
        },
    };
});

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
        { key: 'trading_enabled', value: true, updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'max_trades_per_day', value: 20, updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'max_daily_loss_usd', value: 500, updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'execute_interval_min', value: 10, updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'mr_rsi_entry', value: 10, updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'mr_max_hold_days', value: 10, updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'mr_stop_atr', value: 5, updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'mr_regime_filter', value: true, updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'dry_run_cash_usd', value: 25000, updatedAt: '2026-01-01T00:00:00Z' },
        { key: 'dry_run_cost_bps', value: 10, updatedAt: '2026-01-01T00:00:00Z' },
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
            modelId: 'gemini-3.6-flash',
            useByok: false,
            updatedAt: '2026-01-01T00:00:00Z',
        },
        {
            id: 2,
            analysisType: 'news',
            enabled: true,
            modelId: 'claude-sonnet-5',
            useByok: false,
            updatedAt: '2026-01-01T00:00:00Z',
        },
        {
            id: 3,
            analysisType: 'fundamental',
            enabled: true,
            modelId: 'gemini-3.1-pro-preview',
            useByok: false,
            updatedAt: '2026-01-01T00:00:00Z',
        },
        {
            id: 4,
            analysisType: 'entry_review',
            enabled: true,
            modelId: 'gpt-5.6-terra',
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
        expect(screen.getByText('전략 설정')).toBeInTheDocument();
        expect(screen.getByText('매매 실행 주기')).toBeInTheDocument();
        expect(screen.getByText('감시 종목')).toBeInTheDocument();
        expect(screen.getByText('분석 설정')).toBeInTheDocument();
        expect(screen.getByText('투자 관리')).toBeInTheDocument();
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

    it('blocks adding a 31st symbol once the watchlist is at the 30-symbol cap', async () => {
        const user = userEvent.setup();
        const fullWatchlist = Array.from({ length: 30 }, (_, i) => ({
            id: i + 1,
            symbol: `SYM${i}`,
            companyName: `Company ${i}`,
            enabled: true,
            createdAt: '2026-01-01T00:00:00Z',
        }));
        mockedApi.getConfig.mockResolvedValue({ ...mockConfig, watchlist: fullWatchlist });
        mockedApi.updateConfig.mockResolvedValue(undefined);
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

        await waitFor(() => {
            expect(
                screen.getByText('감시 종목은 최대 30개까지 설정 가능합니다'),
            ).toBeInTheDocument();
        });
        expect(mockedApi.updateConfig).not.toHaveBeenCalled();
    });

    it('allows adding the 30th symbol when the watchlist has 29 items', async () => {
        const user = userEvent.setup();
        const almostFullWatchlist = Array.from({ length: 29 }, (_, i) => ({
            id: i + 1,
            symbol: `SYM${i}`,
            companyName: `Company ${i}`,
            enabled: true,
            createdAt: '2026-01-01T00:00:00Z',
        }));
        mockedApi.getConfig.mockResolvedValue({ ...mockConfig, watchlist: almostFullWatchlist });
        mockedApi.updateConfig.mockResolvedValue(undefined);
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

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'watchlist',
            action: 'add',
            symbol: 'NVDA',
            companyName: 'NVIDIA Corporation',
        });
    });

    it('changing analysis model dropdown calls API with analysisType', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('분석 설정')).toBeInTheDocument();
        });

        const modelSelects = screen.getAllByDisplayValue('gemini-3.6-flash');
        await user.selectOptions(modelSelects[0], 'claude-sonnet-5');

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'analysis',
            analysisType: 'technical',
            updates: { modelId: 'claude-sonnet-5' },
        });
    });

    it('renders the entry_review row and its note, and changing its model calls the API', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        const entryReviewItem = (await screen.findByText('AI 진입 리뷰')).closest('li');
        expect(entryReviewItem).not.toBeNull();

        expect(
            within(entryReviewItem!).getByText(
                '신호가 난 종목의 하락 원인을 판단해 기록만 합니다 — 주문에는 영향을 주지 않습니다',
            ),
        ).toBeInTheDocument();

        const modelSelect = within(entryReviewItem!).getByRole('combobox');
        expect(modelSelect).toHaveValue('gpt-5.6-terra');

        await user.selectOptions(modelSelect, 'claude-opus-5');

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'analysis',
            analysisType: 'entry_review',
            updates: { modelId: 'claude-opus-5' },
        });
    });

    it('offers flash lite while preserving the configured technical analysis model', async () => {
        mockedApi.getConfig.mockResolvedValue(mockConfig);

        renderWithQuery(<SettingsPage />);

        const technicalItem = (await screen.findByText('기술적 분석')).closest('li');
        expect(technicalItem).not.toBeNull();

        const modelSelect = within(technicalItem!).getByRole('combobox');
        expect(modelSelect).toHaveValue('gemini-3.6-flash');
        expect(
            within(modelSelect).getByRole('option', { name: 'gemini-3.5-flash-lite' }),
        ).toBeInTheDocument();
    });

    it('defaults all synthesized analysis configurations to deepseek flash', async () => {
        mockedApi.getConfig.mockResolvedValue({
            ...mockConfig,
            analysis: [],
        });

        renderWithQuery(<SettingsPage />);

        const analysisHeading = await screen.findByText('분석 설정');
        const analysisList = analysisHeading.closest('section')?.querySelector('ul');
        expect(analysisList).not.toBeNull();

        // technical, news, fundamental, entry_review
        const modelSelects = within(analysisList!).getAllByRole('combobox');
        expect(modelSelects).toHaveLength(4);
        modelSelects.forEach((select) => {
            expect(select).toHaveValue('deepseek-v4.1-flash');
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

        const positionSizeInput = screen.getByDisplayValue('5000');
        await user.clear(positionSizeInput);
        await user.type(positionSizeInput, '7000');
        await user.tab();

        expect(mockedApi.updateConfig).not.toHaveBeenCalled();
    });

    it('shows save button when risk values are changed', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('투자 관리')).toBeInTheDocument();
        });

        const positionSizeInput = screen.getByDisplayValue('5000');
        await user.clear(positionSizeInput);
        await user.type(positionSizeInput, '7000');

        // Save button should appear (floating below sections)
        expect(screen.getByRole('button', { name: '저장' })).toBeInTheDocument();
    });

    it('saves all changed risk values when save button is clicked', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('투자 관리')).toBeInTheDocument();
        });

        const positionSizeInput = screen.getByDisplayValue('5000');
        await user.clear(positionSizeInput);
        await user.type(positionSizeInput, '7000');

        const exposureInput = strategyInput('전체 투자 한도 ($)');
        await user.clear(exposureInput);
        await user.type(exposureInput, '30000');

        await user.click(screen.getByRole('button', { name: '저장' }));

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'config',
            key: 'max_position_size',
            value: 7000,
        });
        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'config',
            key: 'max_total_exposure',
            value: 30000,
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

        // Toggle the 'entry_review' analysis (currently enabled) OFF
        const entryReviewToggle = screen.getByLabelText('AI 진입 리뷰 비활성화');
        await user.click(entryReviewToggle);

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'analysis',
            analysisType: 'entry_review',
            updates: { enabled: false },
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

        const positionSizeInput = screen.getByDisplayValue('5000');
        await user.clear(positionSizeInput);
        await user.type(positionSizeInput, '8000');

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
        mockedApi.updateConfig.mockRejectedValue(new Error('max_position_size validation failed'));

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('투자 관리')).toBeInTheDocument();
        });

        const positionSizeInput = screen.getByDisplayValue('5000');
        await user.clear(positionSizeInput);
        await user.type(positionSizeInput, '8000');

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

        const positionSizeInput = screen.getByDisplayValue('5000');
        await user.clear(positionSizeInput);
        await user.type(positionSizeInput, '8000');

        await user.click(screen.getByRole('button', { name: '저장' }));

        await waitFor(() => {
            expect(screen.getByText('설정이 저장되었습니다')).toBeInTheDocument();
        });
    });

    // -----------------------------------------------------------------------
    // dollar-amount inputs have no 0-100 cap
    // -----------------------------------------------------------------------

    it('dollar-amount inputs (max_position_size) do NOT have max=100 cap', async () => {
        mockedApi.getConfig.mockResolvedValue(mockConfig);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('투자 관리')).toBeInTheDocument();
        });

        const positionSizeInput = screen.getByDisplayValue('5000');
        expect(positionSizeInput).not.toHaveAttribute('max', '100');
    });

    // -----------------------------------------------------------------------
    // dry_run_cash_usd / dry_run_cost_bps
    // -----------------------------------------------------------------------

    it('displays dry_run_cash_usd and dry_run_cost_bps with their helper text', async () => {
        mockedApi.getConfig.mockResolvedValue(mockConfig);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('투자 관리')).toBeInTheDocument();
        });

        expect(strategyInput('모의 계좌 예치금 ($)')).toHaveValue(25000);
        expect(strategyInput('모의 체결 비용 (bp, 편도)')).toHaveValue(10);
    });

    // -----------------------------------------------------------------------
    // 매매 실행 주기 — only 5/10 minutes
    // -----------------------------------------------------------------------

    it('실행 주기 선택지는 5분·10분뿐이다', async () => {
        mockedApi.getConfig.mockResolvedValue(mockConfig);

        renderWithQuery(<SettingsPage />);

        const select = await screen.findByLabelText('매매 실행 주기');
        const options = Array.from((select as HTMLSelectElement).options).map((option) => ({
            label: option.textContent,
            value: option.value,
        }));

        expect(options).toEqual([
            { label: '5분', value: '5' },
            { label: '10분', value: '10' },
        ]);
    });

    it('실행 주기는 저장된 값을 보여주고, 바꾸면 즉시 저장한다', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue({
            ...mockConfig,
            config: mockConfig.config.map((c) =>
                c.key === 'execute_interval_min' ? { ...c, value: 5 } : c,
            ),
        });
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        const select = await screen.findByLabelText('매매 실행 주기');
        expect(select).toHaveValue('5');

        await user.selectOptions(select, '10');

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'config',
            key: 'execute_interval_min',
            value: 10,
        });
    });

    it('실행 주기 설정이 없으면 기본 10분을 보여준다', async () => {
        mockedApi.getConfig.mockResolvedValue({
            ...mockConfig,
            config: mockConfig.config.filter((c) => c.key !== 'execute_interval_min'),
        });

        renderWithQuery(<SettingsPage />);

        expect(await screen.findByLabelText('매매 실행 주기')).toHaveValue('10');
    });

    // -----------------------------------------------------------------------
    // 전략 설정 — mr_rsi_entry / mr_max_hold_days / mr_stop_atr / mr_regime_filter
    // -----------------------------------------------------------------------

    /** Strategy/investment fields now have htmlFor+id (C4) — this still works via the
     * shared wrapper div, kept so the many existing call sites below don't need churn.
     * New tests use `getByLabelText` directly to pin the accessibility fix itself. */
    function strategyInput(labelText: string): HTMLInputElement {
        const label = screen.getByText(labelText);
        const input = label.closest('div')!.querySelector('input');
        expect(input).not.toBeNull();
        return input!;
    }

    it('전략 설정 입력이 기본값으로 렌더된다', async () => {
        mockedApi.getConfig.mockResolvedValue({
            ...mockConfig,
            config: mockConfig.config.filter((c) => !c.key.startsWith('mr_')),
        });

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('전략 설정')).toBeInTheDocument();
        });

        expect(strategyInput('매수 기준 RSI(2)')).toHaveValue(10);
        expect(strategyInput('최대 보유 거래일')).toHaveValue(10);
        expect(strategyInput('재난 손절 ATR 배수')).toHaveValue(5);
        expect(screen.getByLabelText('시장 국면 필터 비활성화')).toHaveTextContent('ON');
    });

    it('전략 설정 입력을 바꾸고 저장 버튼으로 저장한다', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('전략 설정')).toBeInTheDocument();
        });

        const rsiInput = strategyInput('매수 기준 RSI(2)');
        await user.clear(rsiInput);
        await user.type(rsiInput, '15');

        await user.click(screen.getByRole('button', { name: '저장' }));

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'config',
            key: 'mr_rsi_entry',
            value: 15,
        });
    });

    it('mr_stop_atr 입력은 0~20, step 0.5 범위를 갖는다', async () => {
        mockedApi.getConfig.mockResolvedValue(mockConfig);

        renderWithQuery(<SettingsPage />);

        await waitFor(() => {
            expect(screen.getByText('재난 손절 ATR 배수')).toBeInTheDocument();
        });

        const stopAtrInput = screen.getByDisplayValue('5');
        expect(stopAtrInput).toHaveAttribute('min', '0');
        expect(stopAtrInput).toHaveAttribute('max', '20');
        expect(stopAtrInput).toHaveAttribute('step', '0.5');
    });

    it('시장 국면 필터 토글은 즉시 저장된다', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        const toggle = await screen.findByLabelText('시장 국면 필터 비활성화');
        await user.click(toggle);

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'config',
            key: 'mr_regime_filter',
            value: false,
        });
    });

    it('시장 국면 필터가 꺼져 있으면 OFF로 표시된다', async () => {
        mockedApi.getConfig.mockResolvedValue({
            ...mockConfig,
            config: mockConfig.config.map((c) =>
                c.key === 'mr_regime_filter' ? { ...c, value: false } : c,
            ),
        });

        renderWithQuery(<SettingsPage />);

        expect(await screen.findByLabelText('시장 국면 필터 활성화')).toHaveTextContent('OFF');
    });

    // -----------------------------------------------------------------------
    // 분석 설정 섹션 helper copy
    // -----------------------------------------------------------------------

    it('분석 설정 섹션에 기록 전용 안내 문구가 보인다', async () => {
        mockedApi.getConfig.mockResolvedValue(mockConfig);

        renderWithQuery(<SettingsPage />);

        expect(
            await screen.findByText(
                '분석은 매수 신호가 난 종목에만, 장 마감 직후 실행됩니다 (기록 전용)',
            ),
        ).toBeInTheDocument();
    });

    // -----------------------------------------------------------------------
    // Notifications footnote mentions the 100h decision-silence check
    // -----------------------------------------------------------------------

    it('알림 안내 문구에 매매 판단 단계 100시간 무응답 조건이 포함된다', async () => {
        mockedApi.getConfig.mockResolvedValue(mockConfig);

        renderWithQuery(<SettingsPage />);

        expect(
            await screen.findByText(
                /크론이 실패했거나 72시간 이상 멈춘 경우, 또는 매매 판단 단계가 100시간 동안 돌지 않은 경우/,
            ),
        ).toBeInTheDocument();
    });

    // -----------------------------------------------------------------------
    // C2 — clearing a numeric field blocks its save instead of sending 0
    // -----------------------------------------------------------------------

    it('clearing mr_stop_atr and saving sends no request for that key and shows an inline error', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        const stopAtrInput = await screen.findByLabelText('재난 손절 ATR 배수');
        await user.clear(stopAtrInput);

        await user.click(screen.getByRole('button', { name: '저장' }));

        // Never sent as 0 — the field is excluded from the save entirely.
        expect(mockedApi.updateConfig).not.toHaveBeenCalledWith(
            expect.objectContaining({ key: 'mr_stop_atr' }),
        );
        expect(screen.getByText('숫자를 입력하세요')).toBeInTheDocument();
        // The typed (empty) value is kept, not reverted to the last saved 5.
        expect(stopAtrInput).toHaveValue(null);
    });

    it('a non-finite risk value also blocks its own save while other valid fields still save', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockResolvedValue(undefined);

        renderWithQuery(<SettingsPage />);

        const stopAtrInput = await screen.findByLabelText('재난 손절 ATR 배수');
        await user.clear(stopAtrInput);

        const rsiInput = screen.getByLabelText('매수 기준 RSI(2)');
        await user.clear(rsiInput);
        await user.type(rsiInput, '15');

        await user.click(screen.getByRole('button', { name: '저장' }));

        expect(mockedApi.updateConfig).toHaveBeenCalledWith({
            type: 'config',
            key: 'mr_rsi_entry',
            value: 15,
        });
        expect(mockedApi.updateConfig).not.toHaveBeenCalledWith(
            expect.objectContaining({ key: 'mr_stop_atr' }),
        );
    });

    // -----------------------------------------------------------------------
    // C4 — strategy/investment inputs are properly labelled (id + htmlFor)
    // -----------------------------------------------------------------------

    it('exposes strategy and investment inputs via getByLabelText (C4)', async () => {
        mockedApi.getConfig.mockResolvedValue(mockConfig);

        renderWithQuery(<SettingsPage />);

        expect(await screen.findByLabelText('매수 기준 RSI(2)')).toHaveValue(10);
        expect(screen.getByLabelText('최대 보유 거래일')).toHaveValue(10);
        expect(screen.getByLabelText('재난 손절 ATR 배수')).toHaveValue(5);
        expect(screen.getByLabelText('모의 체결 비용 (bp, 편도)')).toHaveValue(10);
        expect(screen.getByLabelText('일일 최대 손실 한도 ($)')).toHaveValue(500);
    });

    // -----------------------------------------------------------------------
    // C5 — failed risk saves show the server's message and keep typed values
    // -----------------------------------------------------------------------

    it('shows the server error message and keeps the typed value on a failed risk save (C5)', async () => {
        const user = userEvent.setup();
        mockedApi.getConfig.mockResolvedValue(mockConfig);
        mockedApi.updateConfig.mockRejectedValue(
            new ApiError(400, JSON.stringify({ error: 'mr_stop_atr must be between 0 and 20' })),
        );

        renderWithQuery(<SettingsPage />);

        const stopAtrInput = await screen.findByLabelText('재난 손절 ATR 배수');
        await user.clear(stopAtrInput);
        await user.type(stopAtrInput, '25');

        await user.click(screen.getByRole('button', { name: '저장' }));

        await waitFor(() => {
            expect(screen.getByText(/mr_stop_atr must be between 0 and 20/)).toBeInTheDocument();
        });
        // Typed value stays — it is not silently cleared back to the last saved 5.
        expect(stopAtrInput).toHaveValue(25);
    });
});
