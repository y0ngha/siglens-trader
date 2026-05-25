import { BrowserRouter, Routes, Route, NavLink } from 'react-router';
import { lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

const StatusPage = lazy(() => import('./pages/Status').then((m) => ({ default: m.StatusPage })));
const PositionsPage = lazy(() =>
    import('./pages/Positions').then((m) => ({ default: m.PositionsPage })),
);
const TradesPage = lazy(() => import('./pages/Trades').then((m) => ({ default: m.TradesPage })));
const AnalysisPage = lazy(() =>
    import('./pages/Analysis').then((m) => ({ default: m.AnalysisPage })),
);
const PendingPage = lazy(() => import('./pages/Pending').then((m) => ({ default: m.PendingPage })));
const SettingsPage = lazy(() =>
    import('./pages/Settings').then((m) => ({ default: m.SettingsPage })),
);

interface NavItem {
    to: string;
    label: string;
    icon: string;
    badge?: number;
}

const INVESTMENT_DISCLAIMER =
    '본 서비스는 Siglens의 분석 결과를 바탕으로 이용자가 설정한 값에 따라 자동 매매를 진행하는 서비스입니다. 모든 투자 판단, 설정값 구성, 자동 매매 실행 및 그 결과에 대한 책임은 이용자 본인에게 있으며, Siglens 및 Siglens Trader는 투자 손실이나 기타 불이익에 대해 책임을 지지 않습니다.';

export function App() {
    const { data: pendingOrders } = useQuery({
        queryKey: ['pending'],
        queryFn: ({ signal }) => api.getPending(signal),
    });
    const pendingCount = pendingOrders?.length ?? 0;

    const navItems: NavItem[] = [
        { to: '/', label: '상태', icon: '●' },
        { to: '/positions', label: '포지션', icon: '◆' },
        { to: '/trades', label: '거래', icon: '↕' },
        { to: '/analysis', label: '분석', icon: '◎' },
        { to: '/pending', label: '승인', icon: '✓', badge: pendingCount },
        { to: '/settings', label: '설정', icon: '⚙' },
    ];

    return (
        <BrowserRouter>
            <div className="flex min-h-dvh w-full max-w-full flex-col overflow-x-clip bg-[#0a0a0a] text-[#fafafa]">
                {/* Desktop top nav — hidden on mobile */}
                <DesktopNav navItems={navItems} />

                <main className="min-w-0 flex-1 p-3 pb-20 sm:p-4 sm:pb-4">
                    <Suspense fallback={<LoadingSpinner />}>
                        <Routes>
                            <Route path="/" element={<StatusPage />} />
                            <Route path="/positions" element={<PositionsPage />} />
                            <Route path="/trades" element={<TradesPage />} />
                            <Route path="/analysis" element={<AnalysisPage />} />
                            <Route path="/pending" element={<PendingPage />} />
                            <Route path="/settings" element={<SettingsPage />} />
                        </Routes>
                    </Suspense>
                </main>

                <footer className="max-w-full min-w-0 border-t border-[#262626] px-4 pt-4 pb-24 text-center text-[11px] leading-5 text-neutral-500 sm:pb-4 sm:text-xs">
                    <p className="mx-auto max-w-5xl [overflow-wrap:anywhere] break-words">
                        {INVESTMENT_DISCLAIMER}
                    </p>
                </footer>

                {/* Mobile bottom tab bar — hidden on desktop */}
                <MobileNav navItems={navItems} />
            </div>
        </BrowserRouter>
    );
}

function DesktopNav({ navItems }: { navItems: NavItem[] }) {
    return (
        <nav
            className="scrollbar-hide sticky top-0 z-10 hidden gap-1 overflow-x-auto border-b border-[#262626] bg-[#0a0a0a]/80 px-3 py-2 backdrop-blur-sm sm:flex sm:gap-3 sm:px-4 sm:py-3"
            aria-label="Main navigation"
        >
            {navItems.map((item) => (
                <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) =>
                        `flex items-center rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors ${isActive ? 'bg-[#262626] text-white' : 'text-neutral-400 hover:text-neutral-200'}`
                    }
                >
                    {item.label}
                    {item.badge != null && item.badge > 0 && (
                        <span className="ml-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] leading-none font-bold text-white">
                            {item.badge > 9 ? '9+' : item.badge}
                        </span>
                    )}
                </NavLink>
            ))}
        </nav>
    );
}

function MobileNav({ navItems }: { navItems: NavItem[] }) {
    return (
        <nav
            className="fixed inset-x-0 bottom-0 z-10 flex items-center justify-around border-t border-[#262626] bg-[#0a0a0a]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm sm:hidden"
            aria-label="Mobile navigation"
        >
            {navItems.map((item) => (
                <MobileNavLink
                    key={item.to}
                    to={item.to}
                    label={item.label}
                    icon={item.icon}
                    badge={item.badge}
                />
            ))}
        </nav>
    );
}

function MobileNavLink({
    to,
    label,
    icon,
    badge,
}: {
    to: string;
    label: string;
    icon: string;
    badge?: number;
}) {
    return (
        <NavLink
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
                `relative flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-[10px] transition-colors ${isActive ? 'text-white' : 'text-neutral-500'}`
            }
        >
            <span className="text-base">{icon}</span>
            <span>{label}</span>
            {badge != null && badge > 0 && (
                <span className="absolute top-1 right-1/4 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-red-500 px-0.5 text-[9px] leading-none font-bold text-white">
                    {badge > 9 ? '9+' : badge}
                </span>
            )}
        </NavLink>
    );
}

function LoadingSpinner() {
    return (
        <div className="flex items-center justify-center py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-600 border-t-neutral-300" />
        </div>
    );
}
