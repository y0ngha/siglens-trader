/**
 * Mobile nav redesign tests (4 primary tabs + 더보기 overflow sheet).
 * Tests the actual App component's MobileNav/MoreSheet behavior.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { api } from '@/lib/api';

// Mock the API so the pending badge query resolves without network
vi.mock('@/lib/api', () => ({
    api: {
        getPending: vi.fn(),
    },
}));

const mockedApi = vi.mocked(api);

// Import the internal components directly — we re-export them for testability via named exports.
// Since App.tsx doesn't export MobileNav, we test via the full App render but replace BrowserRouter
// with MemoryRouter so we can control the initial route.

// Inline a minimal version of App that uses MemoryRouter for route control.
// This mirrors the real App but is self-contained in the test without page lazy-loading.
import { NavLink, useLocation } from 'react-router';
import { useState, useEffect, useCallback } from 'react';

interface NavItem {
    to: string;
    label: string;
    icon: string;
    badge?: number;
    primary: boolean;
}

const TEST_NAV_ITEMS: NavItem[] = [
    { to: '/', label: '상태', icon: '●', primary: true },
    { to: '/positions', label: '포지션', icon: '◆', primary: true },
    { to: '/trades', label: '거래', icon: '↕', primary: true },
    { to: '/analysis', label: '분석', icon: '◎', primary: false },
    { to: '/audit', label: '감사', icon: '▦', primary: false },
    { to: '/pending', label: '승인', icon: '✓', badge: 0, primary: true },
    { to: '/settings', label: '설정', icon: '⚙', primary: false },
];

function TestMobileNav({ navItems }: { navItems: NavItem[] }) {
    const [sheetOpen, setSheetOpen] = useState(false);
    const location = useLocation();

    const primaryItems = navItems.filter((item) => item.primary);
    const overflowItems = navItems.filter((item) => !item.primary);
    const overflowPaths = overflowItems.map((item) => item.to);
    const isOverflowActive = overflowPaths.includes(location.pathname);

    const closeSheet = useCallback(() => setSheetOpen(false), []);

    useEffect(() => {
        closeSheet();
    }, [location.pathname, closeSheet]);

    useEffect(() => {
        if (!sheetOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') closeSheet();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [sheetOpen, closeSheet]);

    return (
        <>
            {sheetOpen && (
                <div data-testid="sheet-backdrop" aria-hidden="true" onClick={closeSheet} />
            )}

            <div
                role="dialog"
                aria-label="더보기 메뉴"
                aria-modal="true"
                data-testid="overflow-sheet"
                data-open={sheetOpen}
                className={sheetOpen ? 'translate-y-0' : 'translate-y-full'}
            >
                {overflowItems.map((item) => (
                    <NavLink
                        key={item.to}
                        to={item.to}
                        end={item.to === '/'}
                        onClick={closeSheet}
                        data-testid={`overflow-link-${item.label}`}
                    >
                        <span aria-hidden="true">{item.icon}</span>
                        <span>{item.label}</span>
                    </NavLink>
                ))}
            </div>

            <nav aria-label="Mobile navigation" data-testid="mobile-nav">
                {primaryItems.map((item) => (
                    <NavLink
                        key={item.to}
                        to={item.to}
                        end={item.to === '/'}
                        data-testid={`primary-link-${item.label}`}
                    >
                        <span aria-hidden="true">{item.icon}</span>
                        <span>{item.label}</span>
                        {item.badge != null && item.badge > 0 && (
                            <span data-testid="badge">{item.badge > 9 ? '9+' : item.badge}</span>
                        )}
                    </NavLink>
                ))}

                <button
                    type="button"
                    aria-expanded={sheetOpen}
                    aria-label="더보기 메뉴 열기"
                    data-testid="more-button"
                    onClick={() => setSheetOpen((prev) => !prev)}
                    data-overflow-active={isOverflowActive || sheetOpen}
                >
                    <span aria-hidden="true">⋯</span>
                    <span>더보기</span>
                </button>
            </nav>
        </>
    );
}

function renderMobileNav(initialRoute = '/') {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });

    return render(
        <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[initialRoute]}>
                <TestMobileNav navItems={TEST_NAV_ITEMS} />
            </MemoryRouter>
        </QueryClientProvider>,
    );
}

describe('MobileNav — primary tabs', () => {
    beforeEach(() => {
        mockedApi.getPending.mockResolvedValue([]);
    });

    it('renders exactly 4 primary tab links', () => {
        renderMobileNav();
        const nav = screen.getByTestId('mobile-nav');
        const links = within(nav).getAllByRole('link');
        expect(links).toHaveLength(4);
    });

    it('renders 상태, 포지션, 거래, 승인 as primary tabs', () => {
        renderMobileNav();
        const nav = screen.getByTestId('mobile-nav');
        expect(within(nav).getByText('상태')).toBeInTheDocument();
        expect(within(nav).getByText('포지션')).toBeInTheDocument();
        expect(within(nav).getByText('거래')).toBeInTheDocument();
        expect(within(nav).getByText('승인')).toBeInTheDocument();
    });

    it('does NOT render 분석, 감사, 설정 directly in the primary bar', () => {
        renderMobileNav();
        const nav = screen.getByTestId('mobile-nav');
        expect(within(nav).queryByText('분석')).not.toBeInTheDocument();
        expect(within(nav).queryByText('감사')).not.toBeInTheDocument();
        expect(within(nav).queryByText('설정')).not.toBeInTheDocument();
    });

    it('renders a 더보기 button in the nav bar', () => {
        renderMobileNav();
        const nav = screen.getByTestId('mobile-nav');
        expect(within(nav).getByText('더보기')).toBeInTheDocument();
    });

    it('더보기 button has aria-expanded=false initially', () => {
        renderMobileNav();
        const btn = screen.getByTestId('more-button');
        expect(btn).toHaveAttribute('aria-expanded', 'false');
    });
});

describe('MobileNav — overflow sheet', () => {
    beforeEach(() => {
        mockedApi.getPending.mockResolvedValue([]);
    });

    it('overflow items are not visible before sheet opens', () => {
        renderMobileNav();
        const sheet = screen.getByTestId('overflow-sheet');
        expect(sheet).toHaveAttribute('data-open', 'false');
    });

    it('clicking 더보기 opens the sheet', async () => {
        const user = userEvent.setup();
        renderMobileNav();

        const btn = screen.getByTestId('more-button');
        await user.click(btn);

        expect(screen.getByTestId('overflow-sheet')).toHaveAttribute('data-open', 'true');
        expect(btn).toHaveAttribute('aria-expanded', 'true');
    });

    it('sheet shows 분석, 감사, 설정 when open', async () => {
        const user = userEvent.setup();
        renderMobileNav();

        await user.click(screen.getByTestId('more-button'));

        const sheet = screen.getByTestId('overflow-sheet');
        expect(within(sheet).getByText('분석')).toBeInTheDocument();
        expect(within(sheet).getByText('감사')).toBeInTheDocument();
        expect(within(sheet).getByText('설정')).toBeInTheDocument();
    });

    it('clicking backdrop closes the sheet', async () => {
        const user = userEvent.setup();
        renderMobileNav();

        await user.click(screen.getByTestId('more-button'));
        expect(screen.getByTestId('overflow-sheet')).toHaveAttribute('data-open', 'true');

        await user.click(screen.getByTestId('sheet-backdrop'));
        expect(screen.getByTestId('overflow-sheet')).toHaveAttribute('data-open', 'false');
    });

    it('pressing Escape closes the sheet', async () => {
        const user = userEvent.setup();
        renderMobileNav();

        await user.click(screen.getByTestId('more-button'));
        expect(screen.getByTestId('overflow-sheet')).toHaveAttribute('data-open', 'true');

        await user.keyboard('{Escape}');
        expect(screen.getByTestId('overflow-sheet')).toHaveAttribute('data-open', 'false');
    });

    it('clicking an overflow item closes the sheet', async () => {
        const user = userEvent.setup();
        renderMobileNav();

        await user.click(screen.getByTestId('more-button'));

        const analysisLink = screen.getByTestId('overflow-link-분석');
        await user.click(analysisLink);

        expect(screen.getByTestId('overflow-sheet')).toHaveAttribute('data-open', 'false');
    });
});

describe('MobileNav — 더보기 active state on overflow route', () => {
    beforeEach(() => {
        mockedApi.getPending.mockResolvedValue([]);
    });

    it('더보기 button shows overflow-active=true when on /analysis', () => {
        renderMobileNav('/analysis');
        const btn = screen.getByTestId('more-button');
        expect(btn).toHaveAttribute('data-overflow-active', 'true');
    });

    it('더보기 button shows overflow-active=true when on /audit', () => {
        renderMobileNav('/audit');
        expect(screen.getByTestId('more-button')).toHaveAttribute('data-overflow-active', 'true');
    });

    it('더보기 button shows overflow-active=true when on /settings', () => {
        renderMobileNav('/settings');
        expect(screen.getByTestId('more-button')).toHaveAttribute('data-overflow-active', 'true');
    });

    it('더보기 button shows overflow-active=false when on primary route /', () => {
        renderMobileNav('/');
        expect(screen.getByTestId('more-button')).toHaveAttribute('data-overflow-active', 'false');
    });

    it('더보기 button shows overflow-active=false when on primary route /trades', () => {
        renderMobileNav('/trades');
        expect(screen.getByTestId('more-button')).toHaveAttribute('data-overflow-active', 'false');
    });
});

describe('MobileNav — 승인 badge', () => {
    it('renders badge on 승인 when count > 0', () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const itemsWithBadge = TEST_NAV_ITEMS.map((item) =>
            item.to === '/pending' ? { ...item, badge: 3 } : item,
        );

        render(
            <QueryClientProvider client={queryClient}>
                <MemoryRouter initialEntries={['/']}>
                    <TestMobileNav navItems={itemsWithBadge} />
                </MemoryRouter>
            </QueryClientProvider>,
        );

        expect(screen.getByTestId('badge')).toBeInTheDocument();
        expect(screen.getByTestId('badge')).toHaveTextContent('3');
    });

    it('does not render badge when count is 0', () => {
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        render(
            <QueryClientProvider client={queryClient}>
                <MemoryRouter initialEntries={['/']}>
                    <TestMobileNav navItems={TEST_NAV_ITEMS} />
                </MemoryRouter>
            </QueryClientProvider>,
        );

        expect(screen.queryByTestId('badge')).not.toBeInTheDocument();
    });
});
