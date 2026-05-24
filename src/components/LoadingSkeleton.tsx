export function LoadingSkeleton() {
    return (
        <div aria-busy="true" aria-label="로딩 중" className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-16 animate-pulse rounded-lg bg-[#141414]" />
            ))}
        </div>
    );
}
