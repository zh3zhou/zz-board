import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  root: '.',
  plugins: [
    react(),
    VitePWA({
      injectRegister: false,
      registerType: 'autoUpdate',
      includeAssets: ['zz-mark.svg'],
      manifest: {
        name: 'ZZ Board',
        short_name: 'ZZ Board',
        description: 'A local-first spatial companion for Codex tasks and notes.',
        theme_color: '#e8e2d4',
        background_color: '#e8e2d4',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/zz-mark.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
        ]
      },
      workbox: {
        navigateFallback: '/index.html',
        globPatterns: ['**/*.{js,css,html,svg,woff2}']
      }
    })
  ],
  build: {
    outDir: 'dist/web',
    emptyOutDir: true
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    // Development UI verification must not watch locked desktop caches or
    // expose private evidence/build resources through the Vite file server.
    watch: { ignored: ['**/.local-data/**', '**/.tmp/**', '**/src-tauri/target/**', '**/src-tauri/resources/runtime/**'] },
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.local-data/**', '**/.tmp/**', '**/src-tauri/target/**', '**/src-tauri/resources/runtime/**'] },
    proxy: {
      '/api': 'http://127.0.0.1:4318',
      '/events': 'http://127.0.0.1:4318'
    }
  }
});
