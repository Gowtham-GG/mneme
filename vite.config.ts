import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png', 'theme-init.js'],
      manifest: {
        name: 'Mneme',
        short_name: 'Mneme',
        description: 'A quiet place to capture, connect and find your notes.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#1a1226',
        theme_color: '#1a1226',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
        // Android "Share → Mneme" lands on /share and becomes a capture.
        share_target: {
          action: '/share',
          method: 'GET',
          params: { title: 'title', text: 'text', url: 'url' },
        },
      } as Record<string, unknown>,
      workbox: {
        // App shell only. API traffic is never cached: notes must always be fresh.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        // device notifications (push-sw.js lives in public/)
        importScripts: ['push-sw.js'],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
