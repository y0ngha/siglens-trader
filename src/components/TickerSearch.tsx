import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type TickerSearchResult } from '@/lib/api';

interface TickerSearchProps {
    onSelect: (result: TickerSearchResult) => void;
    placeholder?: string;
}

export function TickerSearch({
    onSelect,
    placeholder = '종목 검색 (심볼 또는 회사명)',
}: TickerSearchProps) {
    const [query, setQuery] = useState('');
    const [isOpen, setIsOpen] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const { data: results = [] } = useQuery({
        queryKey: ['ticker-search', query],
        queryFn: ({ queryKey: [, q], signal }) => api.searchTickers(q as string, signal),
        enabled: query.length >= 1,
        staleTime: 30_000,
    });

    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    function handleSelect(result: TickerSearchResult) {
        onSelect(result);
        setQuery('');
        setIsOpen(false);
    }

    return (
        <div ref={containerRef} className="relative">
            <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => {
                    setQuery(e.target.value);
                    setIsOpen(true);
                }}
                onFocus={() => {
                    if (query.length >= 1) setIsOpen(true);
                }}
                placeholder={placeholder}
                className="w-full rounded-lg border border-[#262626] bg-[#0a0a0a] px-3 py-2 text-sm outline-none focus:border-neutral-500"
                aria-label="종목 검색"
                aria-expanded={isOpen && results.length > 0}
                role="combobox"
                aria-autocomplete="list"
            />
            {isOpen && results.length > 0 && (
                <ul
                    role="listbox"
                    className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-[#262626] bg-[#141414] shadow-lg"
                >
                    {results.map((result) => (
                        <li key={result.symbol}>
                            <button
                                type="button"
                                onClick={() => handleSelect(result)}
                                className="flex w-full items-center justify-between px-3 py-2.5 text-left transition-colors hover:bg-[#262626]"
                                role="option"
                            >
                                <div>
                                    <span className="text-sm font-medium">{result.symbol}</span>
                                    <span className="ml-2 text-xs text-neutral-400">
                                        {result.name}
                                    </span>
                                </div>
                                <span className="text-[10px] text-neutral-500">
                                    {result.exchange}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {isOpen && query.length >= 1 && results.length === 0 && (
                <div className="absolute z-20 mt-1 w-full rounded-lg border border-[#262626] bg-[#141414] px-3 py-2.5 text-xs text-neutral-500">
                    검색 결과 없음
                </div>
            )}
        </div>
    );
}
