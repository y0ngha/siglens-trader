import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');

    return {
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
