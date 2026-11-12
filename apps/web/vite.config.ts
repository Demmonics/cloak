import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packagesDir = path.resolve(__dirname, '../../packages');

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Cloak Private Communications',
        short_name: 'Cloak',
        description: 'Anonymous-first encrypted rooms, voice, video, screen share, and archive exports.',
        theme_color: '#0b0c10',
        background_color: '#0b0c10',
        display: 'standalone',
        icons: [
          {
            src: '/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,ico,svg,wasm,mjs}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
    }),
  ],
  resolve: {
    alias: {
      '@cloak/config': path.join(packagesDir, 'config/src/index.ts'),
      '@cloak/protocol': path.join(packagesDir, 'protocol/src/index.ts'),
      '@cloak/crypto': path.join(packagesDir, 'crypto/src/index.ts'),
      '@cloak/archive': path.join(packagesDir, 'archive/src/index.ts'),
      '@cloak/ui/styles.css': path.join(packagesDir, 'ui/src/styles.css'),
      '@cloak/ui': path.join(packagesDir, 'ui/src/index.ts'),
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});

