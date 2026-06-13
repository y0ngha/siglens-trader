export function ErrorFallback({ error }: { error: unknown }) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return (
        <div className="flex min-h-dvh items-center justify-center p-4">
            <div className="max-w-sm text-center">
                <p className="text-lg font-semibold text-red-400">오류 발생</p>
                <p className="mt-2 text-sm text-neutral-400">{message}</p>
                <button
                    onClick={() => window.location.reload()}
                    className="mt-4 min-h-[44px] rounded-lg bg-neutral-800 px-4 py-2 text-sm active:bg-neutral-700"
                >
                    새로고침
                </button>
            </div>
        </div>
    );
}
