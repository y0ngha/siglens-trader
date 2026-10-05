import { fileURLToPath, URL } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
            '@lib': fileURLToPath(new URL('./lib', import.meta.url)),
        },
    },
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: ['./src/__tests__/setup.ts'],
        // .claude/worktrees/의 다른 브랜치 사본을 집으면 React가 두 벌 로드돼 hook 오류가 난다.
        exclude: [...configDefaults.exclude, '.claude/**'],
        coverage: {
            provider: 'v8',
            include: [
                'lib/trading/**/*.ts',
                'lib/data/yahoo-options.ts',
                'lib/analysis/enrich-news-cards.ts',
                'lib/analysis/run-news.ts',
                'lib/db/queries.ts',
                'api/analysis.ts',
                // 2026-08-21 감사 대응: 진입·청산 판정을 실제로 내리는 순수 모듈이
                // 측정 대상 밖이라 90% 기준이 "측정"이 아니라 "구성"으로 충족되고 있었다.
                // 일봉 눌림매수의 판정 모듈(docs/specs/2026-09-24-daily-mean-reversion-design.md §9).
                'lib/strategy/mean-reversion.ts',
                'lib/strategy/daily-loss.ts',
                // 총자산 연동 사이징(docs/specs/2026-10-05-equity-scaled-sizing-design.md §9).
                'lib/strategy/sizing.ts',
            ],
            exclude: [
                'lib/trading/**/*.test.ts',
                'lib/trading/types.ts',
                'lib/trading/CLAUDE.md',
                '**/__tests__/**',
            ],
            thresholds: {
                lines: 90,
                functions: 90,
                branches: 90,
                statements: 90,
            },
        },
    },
});
