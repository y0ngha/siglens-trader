import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const useMock = process.env.VITE_API_MOCK === 'true';

export default defineConfig({
    plugins: [
        react(),
        tailwindcss(),
        ...(useMock
            ? [
                  {
                      name: 'api-mock',
                      async configureServer(server: import('vite').ViteDevServer) {
                          const { apiMockMiddleware } = await import('./api-mock/middleware');
                          server.middlewares.use(apiMockMiddleware());
                          console.log('🔶 API Mock middleware enabled');
                      },
                  },
              ]
            : []),
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
        port: 4300,
    },
});
