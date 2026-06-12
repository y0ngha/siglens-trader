import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: [
            'dist',
            'drizzle',
            'node_modules',
            'coverage',
            '.yarn',
            '.vercel',
            '*.config.*',
            '.claude/**',
            'public/mockServiceWorker.js',
        ],
    },
    {
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        files: ['**/*.{ts,tsx}'],
        languageOptions: {
            ecmaVersion: 2022,
            globals: { ...globals.browser, ...globals.node },
        },
        plugins: {
            'react-hooks': reactHooks,
            'react-refresh': reactRefresh,
        },
        rules: {
            ...reactHooks.configs.recommended.rules,
            'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
        },
    },
    // 서버 코드(api/, lib/)는 Vercel이 번들링 없이 파일별로 ESM 트랜스파일한다.
    // → 상대 import는 .js 확장자 필수, tsconfig path alias(@lib/@)는 런타임 미해석.
    // 위반 시 런타임에 ERR_MODULE_NOT_FOUND → 500. typecheck(bundler resolution)로는 못 잡으므로 lint로 강제.
    {
        files: ['api/**/*.ts', 'lib/**/*.ts'],
        ignores: ['**/__tests__/**'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            regex: '^@/|^@lib/',
                            message:
                                '서버 코드(api/, lib/)에서는 path alias(@/, @lib/)를 쓸 수 없습니다 — Vercel ESM 트랜스파일에서 해석되지 않습니다. 상대경로 + .js 확장자로 작성하세요.',
                        },
                        {
                            regex: '^\\.\\.?/.*(?<!\\.js)(?<!\\.json)$',
                            message:
                                '서버 코드(api/, lib/)의 상대 import는 .js 확장자가 필수입니다 (네이티브 ESM). 디렉토리 import는 /index.js로 명시하세요.',
                        },
                    ],
                },
            ],
        },
    },
);
