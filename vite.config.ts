import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');

    return {
        /**
         * 번들에 박히는 빌드 시점 버전.
         *
         * 서버는 `/api/health`가 `APP_VERSION`(배포 이미지 태그)을 이미 낸다. 그런데 캐시
         * 문제는 **번들이 갱신됐는지**라, 서버 버전만 봐서는 답이 안 나온다 — 새 서버에
         * 옛 SPA가 붙어 있는 상태가 정확히 그 증상이다. 둘을 따로 심어 화면에서 비교한다.
         *
         * `APP_VERSION`은 Docker 빌드 인자로 들어오고(로컬 개발에서는 없다), 그때는
         * `package.json`의 버전에 `-dev`를 붙여 배포본과 구분한다.
         */
        define: {
            __APP_VERSION__: JSON.stringify(process.env.APP_VERSION ?? `${pkg.version}-dev`),
        },
        plugins: [
            react(),
            tailwindcss(),
            {
                name: 'fmp-search-proxy',
                configureServer(server) {
                    server.middlewares.use('/api/search', async (req, res) => {
                        const url = new URL(req.url ?? '', 'http://localhost');
                        const query = url.searchParams.get('q');
                        if (!query) {
                            res.end(JSON.stringify([]));
                            return;
                        }

                        const apiKey = env.FMP_API_KEY;
                        if (!apiKey) {
                            res.end(JSON.stringify([]));
                            return;
                        }

                        const params = new URLSearchParams({ query, limit: '10', apikey: apiKey });
                        const US_EXCHANGES = new Set(['NYSE', 'NASDAQ', 'AMEX', 'NYSEArca']);

                        try {
                            const [r1, r2] = await Promise.all([
                                fetch(
                                    `https://financialmodelingprep.com/stable/search-symbol?${params}`,
                                ).then((r) => (r.ok ? r.json() : [])),
                                fetch(
                                    `https://financialmodelingprep.com/stable/search-name?${params}`,
                                ).then((r) => (r.ok ? r.json() : [])),
                            ]);
                            const seen = new Set<string>();
                            const results: Array<{
                                symbol: string;
                                name: string;
                                exchange: string;
                            }> = [];
                            for (const item of [...(r1 as any[]), ...(r2 as any[])]) {
                                if (!item?.symbol || !item?.name || !item?.exchange) continue;
                                if (!US_EXCHANGES.has(item.exchange)) continue;
                                if (seen.has(item.symbol)) continue;
                                seen.add(item.symbol);
                                results.push({
                                    symbol: item.symbol,
                                    name: item.name,
                                    exchange: item.exchange,
                                });
                            }
                            res.setHeader('Content-Type', 'application/json');
                            res.end(JSON.stringify(results.slice(0, 10)));
                        } catch {
                            res.end(JSON.stringify([]));
                        }
                    });
                },
            },
            VitePWA({
                registerType: 'autoUpdate',
                manifest: {
                    name: 'Siglens Auto Trader',
                    short_name: 'Trader',
                    description: 'Auto-trading dashboard',
                    theme_color: '#0a0a0a',
                    background_color: '#0a0a0a',
                    display: 'standalone',
                    icons: [
                        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
                        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
                    ],
                },
            }),
        ],
        resolve: {
            alias: {
                '@': fileURLToPath(new URL('./src', import.meta.url)),
                '@lib': fileURLToPath(new URL('./lib', import.meta.url)),
            },
        },
        server: {
            port: 6270,
        },
    };
});
