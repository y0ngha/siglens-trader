import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from '@/lib/api';
import { LoginPage } from '../Login';

const mockLogin = vi.fn();
vi.mock('@/lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/api')>();
    return {
        ...actual,
        api: { ...actual.api, login: (...args: unknown[]) => mockLogin(...args) },
    };
});

function renderLogin() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={queryClient}>
            <LoginPage />
        </QueryClientProvider>,
    );
}

async function submitCredentials(email: string, password: string) {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('이메일'), email);
    await user.type(screen.getByLabelText('비밀번호'), password);
    await user.click(screen.getByRole('button', { name: '로그인' }));
}

describe('LoginPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('offers no signup path — accounts are provisioned server-side', () => {
        renderLogin();
        expect(screen.queryByText(/회원가입/)).not.toBeInTheDocument();
    });

    it('submits the typed credentials', async () => {
        mockLogin.mockResolvedValue({ user: { id: 'u1', email: 'a@b.c', name: null } });

        renderLogin();
        await submitCredentials('operator@example.com', 'secret');

        await waitFor(() =>
            expect(mockLogin).toHaveBeenCalledWith('operator@example.com', 'secret'),
        );
    });

    it("shows the server's message when credentials are rejected", async () => {
        mockLogin.mockRejectedValue(
            new ApiError(
                401,
                JSON.stringify({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' }),
            ),
        );

        renderLogin();
        await submitCredentials('operator@example.com', 'wrong');

        expect(await screen.findByRole('alert')).toHaveTextContent(
            '이메일 또는 비밀번호가 올바르지 않습니다.',
        );
    });

    it('shows the rate-limit message on 429', async () => {
        mockLogin.mockRejectedValue(
            new ApiError(
                429,
                JSON.stringify({
                    error: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.',
                }),
            ),
        );

        renderLogin();
        await submitCredentials('operator@example.com', 'wrong');

        expect(await screen.findByRole('alert')).toHaveTextContent('로그인 시도가 너무 많습니다');
    });

    it('falls back to a generic message for a non-API failure', async () => {
        mockLogin.mockRejectedValue(new Error('network down'));

        renderLogin();
        await submitCredentials('operator@example.com', 'secret');

        expect(await screen.findByRole('alert')).toHaveTextContent('로그인에 실패했습니다');
    });
});
