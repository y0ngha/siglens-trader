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
            include: ['lib/trading/**/*.ts'],
            exclude: ['lib/trading/**/*.test.ts', 'lib/trading/types.ts', 'lib/trading/CLAUDE.md'],
            thresholds: {
                lines: 90,
                functions: 90,
                branches: 90,
                statements: 90,
            },
        },
    },
});
