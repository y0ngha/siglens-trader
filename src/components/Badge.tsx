interface BadgeProps {
    label: string;
    variant: 'green' | 'red' | 'neutral';
}

export function Badge({ label, variant }: BadgeProps) {
    const colors = {
        green: 'bg-green-500/10 text-green-400',
        red: 'bg-red-500/10 text-red-400',
        neutral: 'bg-neutral-700 text-neutral-300',
    };
    return (
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${colors[variant]}`}>
            {label}
        </span>
    );
}
