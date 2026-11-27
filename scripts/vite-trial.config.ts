import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('../src/trial/', import.meta.url)),
  base: './',
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../dist/trial/', import.meta.url)),
    emptyOutDir: true
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    fs: {
      deny: [
        '.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.local-data/**', '**/.tmp/**',
        '**/.harness-backups/**', '**/exports/**', '**/src-tauri/target/**', '**/src-tauri/resources/runtime/**'
      ]
    }
  },
  preview: { host: '127.0.0.1', port: 4174 }
});
