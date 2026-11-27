import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { BoardDatabase } from '../../src/server/database.js';
import { loadConfig } from '../../src/server/config.js';
import { ImageExports } from '../../src/server/imageExports.js';

let app: FastifyInstance | undefined, root = '', db: BoardDatabase;
const headers = { 'x-zz-board-mutation': '1', 'content-type': 'image/png' };
const settingsHeaders = { 'x-zz-board-mutation': '1' };
async function setup() {
  await fs.mkdir(path.resolve('.tmp'), { recursive: true }); root = await fs.mkdtemp(path.resolve('.tmp/image-exports-'));
  db = new BoardDatabase(path.join(root, 'board.sqlite'));
  app = await buildApp(loadConfig({ ZZ_BOARD_DATA_DIR: path.join(root, '.local-data') }), { db }); return app;
}
const png = () => sharp({ create: { width: 48, height: 32, channels: 4, background: '#e4bc69' } }).png().toBuffer();
afterEach(async () => { vi.restoreAllMocks(); await app?.close(); app = undefined; if (root && root.startsWith(path.resolve('.tmp') + path.sep)) await fs.rm(root, { recursive: true, force: true }); root = ''; });

describe('reliable local PNG output', () => {
  it('defaults beside the board data, writes exact bytes, and leaves board/undo unchanged', async () => {
    const app = await setup(), bytes = await png();
    const settings = (await app.inject('/api/settings/image-export')).json();
    expect(settings).toEqual({ directory: path.join(root, 'exports'), defaultDirectory: path.join(root, 'exports') });
    const before = db.getBoard(), history = db.getHistoryStatus();
    const first = await app.inject({ method: 'POST', url: '/api/image-exports?kind=region', headers, payload: bytes });
    expect(first.statusCode, first.body).toBe(201);
    const saved = first.json(); expect(saved).toMatchObject({ bytes: bytes.length, width: 48, height: 32 });
    expect(path.dirname(saved.path)).toBe(await fs.realpath(settings.directory)); expect(path.basename(saved.path)).toMatch(/^ZZ-Board-region-.*\.png$/);
    expect(await fs.readFile(saved.path)).toEqual(bytes);
    const second = (await app.inject({ method: 'POST', url: '/api/image-exports?kind=note', headers, payload: bytes })).json();
    expect(second.path).not.toBe(saved.path); expect(await fs.readFile(second.path)).toEqual(bytes);
    expect(db.getBoard()).toEqual(before); expect(db.getHistoryStatus()).toEqual(history);
  });
  it('persists an explicit output directory without rewriting canvas history, then resets', async () => {
    let app = await setup(); const note = db.createNote({ title: '', body: '合成便签', x: 1, y: 2, width: 200, height: 100 });
    db.undo(); const history = db.getHistoryStatus(), directory = path.join(root, '自定义 图片');
    const changed = await app.inject({ method: 'PATCH', url: '/api/settings/image-export', headers: settingsHeaders, payload: { directory } });
    expect(changed.statusCode).toBe(200); expect(changed.json().directory).toBe(directory);
    expect(db.getHistoryStatus()).toEqual(history); expect(db.getBoard().nodes).not.toContainEqual(note);
    await app.close();
    db = new BoardDatabase(path.join(root, 'board.sqlite')); app = await buildApp(loadConfig({ ZZ_BOARD_DATA_DIR: path.join(root, '.local-data') }), { db });
    // Keep the reopened instance in the cleanup owner as well.
    activeApp(app);
    expect((await app.inject('/api/settings/image-export')).json().directory).toBe(directory);
    const saved = (await app.inject({ method: 'POST', url: '/api/image-exports', headers, payload: await png() })).json();
    expect(path.dirname(saved.path)).toBe(await fs.realpath(directory));
    expect((await app.inject({ method: 'PATCH', url: '/api/settings/image-export', headers: settingsHeaders, payload: { directory: null } })).json().directory).toBe(path.join(root, 'exports'));
  });
  it('requires deliberate mutations and rejects unsafe or implicit output paths', async () => {
    const app = await setup();
    for (const url of ['/api/image-exports', '/api/settings/image-export']) {
      expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'POST', url: '/api/image-exports', headers: { ...headers, origin: 'https://example.com' }, payload: await png() })).statusCode).toBe(403);
    for (const directory of ['relative', '..', path.parse(root).root, os.homedir(), '\\\\host\\folder', '//server/share', path.join(root, '.local-data'), path.join(root, '.local-data', 'media'), `${root}${path.sep}folder${path.sep}..${path.sep}escape`, root + '\n']) {
      const response = await app.inject({ method: 'PATCH', url: '/api/settings/image-export', headers: settingsHeaders, payload: { directory } });
      expect(response.statusCode, directory).toBe(400);
    }
    expect((await app.inject('/api/settings/image-export')).json().directory).toBe(path.join(root, 'exports'));
  });
  it('rejects corrupt/non-PNG/oversized input and still accepts a later valid save', async () => {
    const app = await setup(), bytes = await png(), broken = Buffer.from(bytes), huge = Buffer.from(bytes);
    broken[broken.indexOf('IDAT') + 4] ^= 255; huge.writeUInt32BE(9000, 16);
    const jpeg = await sharp(bytes).jpeg().toBuffer();
    for (const payload of [Buffer.from('<svg/>'), broken, huge, jpeg]) expect((await app.inject({ method: 'POST', url: '/api/image-exports', headers, payload })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/image-exports?kind=../../other', headers, payload: bytes })).statusCode).toBe(400);
    await expect(fs.stat(path.join(root, 'exports'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await app.inject({ method: 'POST', url: '/api/image-exports', headers, payload: bytes })).statusCode).toBe(201);
  });
  it('does not report success or overwrite an existing file used as the output folder', async () => {
    const app = await setup(), directory = path.join(root, 'already-a-file'); await fs.writeFile(directory, 'keep');
    await app.inject({ method: 'PATCH', url: '/api/settings/image-export', headers: settingsHeaders, payload: { directory } });
    expect((await app.inject({ method: 'POST', url: '/api/image-exports', headers, payload: await png() })).statusCode).toBe(400);
    expect(await fs.readFile(directory, 'utf8')).toBe('keep');
  });
  it('rejects concurrent saves before buffering more work and releases the gate after failure', async () => {
    const app = await setup(), bytes = await png(); let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const finish = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(ImageExports.prototype, 'save').mockImplementationOnce(async () => { entered(); await finish; throw new Error('合成写盘失败'); });
    const first = app.inject({ method: 'POST', url: '/api/image-exports', headers, payload: bytes });
    await started;
    expect((await app.inject({ method: 'POST', url: '/api/image-exports', headers, payload: bytes })).statusCode).toBe(429);
    release(); expect((await first).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/image-exports', headers, payload: bytes })).statusCode).toBe(201);
  });
  it('uses the bound project root for custom private data directories and forbids their descendants', async () => {
    await setup(); const privateDir = path.join(root, 'private-store'), project = path.join(root, 'source');
    const exports = new ImageExports(db, privateDir, project);
    expect(exports.settings().directory).toBe(path.join(project, 'exports'));
    for (const directory of [privateDir, path.join(privateDir, 'media'), path.join(privateDir, '..named-child')]) expect(() => exports.setDirectory(directory)).toThrow('私有数据库');
    for (const source of [privateDir, path.join(privateDir, 'source')]) expect(new ImageExports(db, privateDir, source).defaultDirectory).toBe(path.join(root, 'private-store-exports'));
    const result = await exports.save(await png(), 'region'); expect(path.dirname(result.path)).toBe(await fs.realpath(path.join(project, 'exports')));
  });
  it('cleans its own partial output when the final close fails', async () => {
    await setup(); const originalOpen = fs.open;
    vi.spyOn(fs, 'open').mockImplementationOnce(async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode);
      vi.spyOn(handle, 'close').mockRejectedValueOnce(new Error('合成关闭失败'));
      return handle;
    });
    const exports = new ImageExports(db, path.join(root, '.local-data'));
    await expect(exports.save(await png(), 'note')).rejects.toThrow('合成关闭失败');
    expect(await fs.readdir(exports.settings().directory)).toEqual([]);
    expect(await exports.save(await png(), 'note')).toMatchObject({ width: 48, height: 32 });
  });
});

function activeApp(value: FastifyInstance) { app = value; }
