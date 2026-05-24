interface CardProps {
    label: string;
    value: string;
    indicator?: 'green' | 'red';
    className?: string;
}

export function Card({ label, value, indicator, className }: CardProps) {
    return (
        <div className={`rounded-lg border border-[#262626] bg-[#141414] p-3 ${className ?? ''}`}>
            <p className="text-xs text-neutral-400">{label}</p>
            <div className="mt-1 flex items-center gap-2">
                {indicator && (
                    <span
                        aria-label={indicator === 'green' ? '활성' : '비활성'}
                        className={`inline-block h-2 w-2 rounded-full ${indicator === 'green' ? 'bg-green-500' : 'bg-red-500'}`}
                    />
                )}
                <p className="text-sm font-medium">{value}</p>
            </div>
        </div>
    );
}
