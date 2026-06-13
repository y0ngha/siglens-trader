import { NavLink, useLocation } from 'react-router';
import { useState, useEffect, useCallback, useRef } from 'react';

export interface NavItem {
    to: string;
    label: string;
    icon: string;
    badge?: number;
    primary: boolean;
}

export function MobileNav({ navItems }: { navItems: NavItem[] }) {
    const [sheetOpen, setSheetOpen] = useState(false);
    const location = useLocation();

    const primaryItems = navItems.filter((item) => item.primary);
    const overflowItems = navItems.filter((item) => !item.primary);
    const overflowPaths = overflowItems.map((item) => item.to);
    const isOverflowActive = overflowPaths.includes(location.pathname);

    // Ref to the "더보기" trigger button for focus restore on close
    const moreButtonRef = useRef<HTMLButtonElement>(null);
    // Ref to the first focusable element inside the sheet
    const firstSheetItemRef = useRef<HTMLAnchorElement>(null);

    const closeSheet = useCallback(() => setSheetOpen(false), []);

    // Close sheet on route change
    useEffect(() => {
        closeSheet();
    }, [location.pathname, closeSheet]);

    // Close sheet on Escape key
    useEffect(() => {
        if (!sheetOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') closeSheet();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [sheetOpen, closeSheet]);

    // Fix 1: Move focus into sheet on open; restore to trigger button on close
    useEffect(() => {
        if (sheetOpen) {
            firstSheetItemRef.current?.focus();
        } else {
            moreButtonRef.current?.focus();
        }
    }, [sheetOpen]);

    // Fix 2: Lock background scroll while sheet is open
    useEffect(() => {
        if (!sheetOpen) return;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = previousOverflow;
        };
    }, [sheetOpen]);

    return (
        <>
            {/* Bottom sheet overlay — only in DOM when open */}
            {sheetOpen && (
                <div
                    className="fixed inset-x-0 top-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 bg-black/50 sm:hidden"
                    aria-hidden="true"
                    onClick={closeSheet}
                />
            )}

            {/* Bottom sheet panel — only rendered when open; sits ABOVE the nav bar */}
            {sheetOpen && (
                <div
                    role="dialog"
                    aria-label="더보기 메뉴"
                    aria-modal="true"
                    data-testid="overflow-sheet"
                    className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 sm:hidden"
                >
                    <div className="rounded-t-2xl border-t border-[#262626] bg-[#141414]">
                        {overflowItems.map((item, idx) => (
                            <NavLink
                                key={item.to}
                                to={item.to}
                                end={item.to === '/'}
                                onClick={closeSheet}
                                ref={idx === 0 ? firstSheetItemRef : undefined}
                                data-testid={`overflow-link-${item.label}`}
                                className={({ isActive }) =>
                                    `flex min-h-[44px] items-center gap-3 border-b border-[#262626] px-6 py-3 text-sm transition-colors last:border-b-0 ${isActive ? 'text-white' : 'text-neutral-400 active:text-neutral-200'}`
                                }
                            >
                                <span className="text-base" aria-hidden="true">
                                    {item.icon}
                                </span>
                                <span>{item.label}</span>
                            </NavLink>
                        ))}
                    </div>
                </div>
            )}

            {/* Bottom nav bar */}
            <nav
                className="fixed inset-x-0 bottom-0 z-20 flex min-h-[52px] items-center justify-around border-t border-[#262626] bg-[#0a0a0a]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm sm:hidden"
                aria-label="Mobile navigation"
                data-testid="mobile-nav"
            >
                {primaryItems.map((item) => (
                    <MobileNavLink
                        key={item.to}
                        to={item.to}
                        label={item.label}
                        icon={item.icon}
                        badge={item.badge}
                    />
                ))}

                {/* 더보기 button */}
                <button
                    type="button"
                    aria-expanded={sheetOpen}
                    aria-label="더보기 메뉴 열기"
                    data-testid="more-button"
                    ref={moreButtonRef}
                    onClick={() => setSheetOpen((prev) => !prev)}
                    data-overflow-active={isOverflowActive || sheetOpen}
                    className={`relative flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-[10px] transition-colors ${isOverflowActive || sheetOpen ? 'text-white' : 'text-neutral-500'}`}
                >
                    <span className="text-base" aria-hidden="true">
                        ⋯
                    </span>
                    <span>더보기</span>
                </button>
            </nav>
        </>
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
            data-testid={`primary-link-${label}`}
            className={({ isActive }) =>
                `relative flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-[10px] transition-colors ${isActive ? 'text-white' : 'text-neutral-500'}`
            }
        >
            <span className="text-base" aria-hidden="true">
                {icon}
            </span>
            <span>{label}</span>
            {badge != null && badge > 0 && (
                <span
                    data-testid="badge"
                    className="absolute top-1 right-1/4 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-red-500 px-0.5 text-[9px] leading-none font-bold text-white"
                >
                    {badge > 9 ? '9+' : badge}
                </span>
            )}
        </NavLink>
    );
}
