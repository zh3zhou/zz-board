/** Synthetic, opt-in browser acceptance server. Never uses the personal board. */
import { createServer } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
const root = path.resolve('.tmp/media-browser-check'); await fs.mkdir(root, { recursive: true });
const app = await buildApp(loadConfig({ ZZ_BOARD_DATA_DIR: root, ZZ_BOARD_DEMO: '0' }));
await app.listen({ host: '127.0.0.1', port: 0 });
const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('No local port');
const vite = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 4339, strictPort: true, watch: { ignored: ['**/.local-data/**', '**/.tmp/**', '**/src-tauri/target/**', '**/src-tauri/resources/runtime/**'] }, fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.local-data/**', '**/.tmp/**', '**/src-tauri/target/**', '**/src-tauri/resources/runtime/**'] }, proxy: { '/api': `http://127.0.0.1:${address.port}` } }, plugins: [{ name: 'synthetic-media-results', configureServer(server) {
  server.middlewares.use('/acceptance-result', (request, response) => {
    if (request.method !== 'POST' || request.headers['x-zz-board-mutation'] !== '1') { response.statusCode = 403; response.end(); return; }
    const name = (request.url || '').slice(1);
    if (!/^(night|paper|note|detail|stress|result)\.(png|json)$/.test(name)) { response.statusCode = 400; response.end(); return; }
    const chunks: Buffer[] = []; let bytes = 0;
    request.on('data', chunk => { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) request.destroy(); else chunks.push(chunk); });
    request.on('end', () => { void fs.writeFile(path.join(root, name), Buffer.concat(chunks)).then(() => response.end('ok')); });
  });
} }] });
await vite.listen();
console.log('Synthetic acceptance: http://127.0.0.1:4339/tests/browser/media.html');
async function close() { await vite.close(); await app.close(); process.exit(0); }
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
