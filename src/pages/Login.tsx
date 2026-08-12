import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';

/**
 * Login screen. There is no signup — operator accounts are provisioned with
 * `yarn db:seed-operator`, so this form is the only entry point.
 */
export function LoginPage() {
    const queryClient = useQueryClient();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');

    const login = useMutation({
        mutationFn: () => api.login(email, password),
        onSuccess: async () => {
            // Drop everything fetched while logged out (all 401s) and refetch as the user.
            await queryClient.invalidateQueries();
        },
    });

    const errorMessage =
        login.error instanceof ApiError
            ? login.error.displayMessage
            : login.error
              ? '로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.'
              : null;

    return (
        <main className="flex min-h-dvh items-center justify-center bg-[#0a0a0a] p-4 text-[#fafafa]">
            <div className="w-full max-w-sm">
                <h1 className="text-center text-lg font-semibold">Siglens Trader</h1>
                <p className="mt-1 text-center text-xs text-neutral-500">
                    등록된 계정으로 로그인하세요
                </p>

                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (!login.isPending) login.mutate();
                    }}
                    className="mt-8 flex flex-col gap-3"
                >
                    <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                        이메일
                        <input
                            type="email"
                            name="email"
                            autoComplete="username"
                            required
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="rounded-md border border-[#262626] bg-[#111] px-3 py-2 text-sm text-[#fafafa] outline-none focus:border-neutral-500"
                        />
                    </label>

                    <label className="flex flex-col gap-1.5 text-xs text-neutral-400">
                        비밀번호
                        <input
                            type="password"
                            name="password"
                            autoComplete="current-password"
                            required
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="rounded-md border border-[#262626] bg-[#111] px-3 py-2 text-sm text-[#fafafa] outline-none focus:border-neutral-500"
                        />
                    </label>

                    {errorMessage && (
                        <p role="alert" className="text-xs text-red-400">
                            {errorMessage}
                        </p>
                    )}

                    <button
                        type="submit"
                        disabled={login.isPending}
                        className="mt-2 rounded-md bg-[#fafafa] px-3 py-2 text-sm font-medium text-[#0a0a0a] transition-opacity disabled:opacity-50"
                    >
                        {login.isPending ? '로그인 중…' : '로그인'}
                    </button>
                </form>
            </div>
        </main>
    );
}
