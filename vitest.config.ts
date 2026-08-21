import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

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
                'lib/strategy/entry-zone.ts',
                'lib/strategy/risk-manager.ts',
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
