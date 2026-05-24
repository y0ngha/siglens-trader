export function ErrorMessage({ error }: { error: Error }) {
    return (
        <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 p-4">
            <p className="text-sm text-red-400">오류: {error.message}</p>
        </div>
    );
}
