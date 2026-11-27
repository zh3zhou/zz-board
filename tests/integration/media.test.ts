import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { BoardDatabase } from '../../src/server/database.js';
import { loadConfig } from '../../src/server/config.js';
import { imageInfo } from '../../src/shared/imageFormat.js';
import { MediaStore } from '../../src/server/mediaStore.js';
import { visibleWallpaper, type Wallpaper } from '../../src/shared/wallpaper.js';
import { DEFAULT_PAGE_ID } from '../../src/shared/pages.js';

let app: FastifyInstance | undefined, root = '';
const headers = { 'x-zz-board-mutation': '1', 'content-type': 'application/octet-stream' };
async function setup() {
  const base = path.resolve('.tmp'); await fs.mkdir(base, { recursive: true }); root = await fs.mkdtemp(path.join(base, 'media-test-'));
  app = await buildApp(loadConfig({ ZZ_BOARD_DATA_DIR: root }), { db: new BoardDatabase(path.join(root, 'test.sqlite')) });
  return app;
}
async function picture(format: 'png' | 'jpeg' | 'webp' = 'png') { return sharp({ create: { width: 48, height: 32, channels: 4, background: '#e4bc69' } }).toFormat(format).toBuffer(); }
afterEach(async () => { await app?.close(); app = undefined; if (root && root.startsWith(path.resolve('.tmp') + path.sep)) await fs.rm(root, { recursive: true, force: true }); root = ''; });
describe('local image assets', () => {
  it('persists personal wallpapers by media ID, supports page inheritance and journals each change once', async () => {
    const server = await setup(), bytes = await picture();
    const { id } = (await server.inject({ method: 'POST', url: '/api/media', headers, payload: bytes })).json();
    const writes = { 'x-zz-board-mutation': '1' }, boardUrl = '/api/settings/wallpaper', pageUrl = `/api/pages/${DEFAULT_PAGE_ID}`;
    const global: Wallpaper = { assetId: id, fit: 'cover', opacity: .4 };
    const personal: Wallpaper = { assetId: id, fit: 'tile', opacity: .75 };
    expect((await server.inject({ method: 'PATCH', url: boardUrl, payload: { previous: null, value: global } })).statusCode).toBe(403);
    const change = (previous: Wallpaper | null, value: Wallpaper | null) => server.inject({ method: 'PATCH', url: boardUrl, headers: writes, payload: { previous, value } });
    expect((await change(null, global)).statusCode).toBe(200);
    const db = server.zzServices.db, revision = db.getBoard().boardRevision;
    expect((await change(null, global)).statusCode).toBe(200);
    expect((await change(null, personal)).statusCode).toBe(409);
    expect((await change(global, { ...personal, assetId: '0'.repeat(64) })).statusCode).toBe(409);
    expect(db.getBoard().boardRevision).toBe(revision);
    let page = db.getPage(DEFAULT_PAGE_ID);
    expect(visibleWallpaper(global, page)).toEqual(global);
    const update = await server.inject({ method: 'PATCH', url: pageUrl, headers: writes, payload: { revision: page.revision, wallpaper: personal } });
    expect(update.statusCode, update.body).toBe(200);
    expect(visibleWallpaper(global, update.json())).toEqual(personal);
    expect((await server.inject({ method: 'PATCH', url: pageUrl, headers: writes, payload: { revision: page.revision, backgroundSkinRef: null } })).statusCode).toBe(409);
    expect(db.getPage(DEFAULT_PAGE_ID).wallpaper).toEqual(personal);
    db.undo();
    expect(visibleWallpaper(global, db.getPage(DEFAULT_PAGE_ID))).toEqual(global);
    db.redo();
    await server.close();
    app = await buildApp(loadConfig({ ZZ_BOARD_DATA_DIR: root }), { db: new BoardDatabase(path.join(root, 'test.sqlite')) });
    const reopened = app.zzServices.db.getBoard();
    page = app.zzServices.db.getPage(DEFAULT_PAGE_ID);
    expect(visibleWallpaper(reopened.settings.wallpaper, page)).toEqual(personal);
    expect((await app.inject({ method: 'GET', url: `/api/media/${id}/original` })).rawPayload).toEqual(bytes);
    expect((await app.inject({ method: 'PATCH', url: pageUrl, headers: writes, payload: { revision: page.revision, wallpaper: null, backgroundSkinRef: null } })).statusCode).toBe(200);
    expect(visibleWallpaper(reopened.settings.wallpaper, app.zzServices.db.getPage(DEFAULT_PAGE_ID))).toEqual(global);
    expect(visibleWallpaper(global, { backgroundSkinRef: 'synthetic@1.0.0#background' })).toBeNull();
  });
  it('preserves high-frequency original detail independently of the 1024px preview', async () => {
    const app = await setup(), pixels = Buffer.alloc(2400 * 8 * 3);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 2400; x++) pixels.fill(Math.floor(x / 2) % 2 ? 255 : 0, (y * 2400 + x) * 3, (y * 2400 + x + 1) * 3);
    const bytes = await sharp(pixels, { raw: { width: 2400, height: 8, channels: 3 } }).png().toBuffer();
    const asset = (await app.inject({ method: 'POST', url: '/api/media', headers, payload: bytes })).json();
    const original = (await app.inject({ method: 'GET', url: `/api/media/${asset.id}/original` })).rawPayload;
    const preview = (await app.inject({ method: 'GET', url: `/api/media/${asset.id}/preview` })).rawPayload;
    expect(original).toEqual(bytes);
    expect(await sharp(original).raw().toBuffer()).toEqual(pixels);
    expect(imageInfo(preview).width).toBe(1024);
  });
  it.each(['png', 'jpeg', 'webp'] as const)('decodes %s, deduplicates, serves original unchanged and creates a bounded preview', async format => {
    const app = await setup(), bytes = await picture(format);
    const uploaded = await app.inject({ method: 'POST', url: '/api/media', headers, payload: bytes });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const asset = uploaded.json(); expect(asset.id).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect((await app.inject({ method: 'POST', url: '/api/media', headers, payload: bytes })).json()).toEqual(asset);
    expect((await app.inject({ method: 'GET', url: `/api/media/${asset.id}/original` })).rawPayload).toEqual(bytes);
    const preview = await app.inject({ method: 'GET', url: `/api/media/${asset.id}/preview` });
    expect(imageInfo(preview.rawPayload)).toMatchObject({ width: 48, height: 32, mime: 'image/png' });
    expect((await sharp(preview.rawPayload).raw().toBuffer()).some(byte => byte > 0)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/media/usage' })).json()).toEqual({ count: 1, bytes: bytes.length + preview.rawPayload.length });
    expect(await fs.readdir(path.join(root, 'media'))).toHaveLength(2);
  });
  it('accepts zero-padded complete clipboard JPEGs unchanged and rejects missing scans or end markers', async () => {
    const server = await setup(), jpeg = await picture('jpeg'), padded = Buffer.concat([jpeg, Buffer.alloc(8)]);
    const result = await server.inject({ method: 'POST', url: '/api/media', headers, payload: padded });
    expect(result.statusCode, result.body).toBe(201);
    const { id } = result.json();
    expect((await server.inject({ method: 'GET', url: `/api/media/${id}/original` })).rawPayload).toEqual(padded);
    for (const payload of [jpeg.subarray(0, -2), Buffer.concat([jpeg.subarray(0, -2), Buffer.alloc(8)]), Buffer.concat([jpeg, Buffer.from('trailing junk')]), Buffer.concat([jpeg, jpeg])]) {
      const failed = await server.inject({ method: 'POST', url: '/api/media', headers, payload });
      expect(failed.statusCode).toBe(400); expect(failed.json().code).toBe('invalid_image');
    }
    expect(server.zzServices.db.mediaUsage().count).toBe(1);
    const progressive = await sharp(jpeg).jpeg({ progressive: true }).toBuffer();
    expect((await server.inject({ method: 'POST', url: '/api/media', headers, payload: progressive })).statusCode).toBe(201);
  });
  it('reopens the same image occurrences, wrapping placement and text and journals a position-only edit', async () => {
    const server = await setup(), bytes = await picture();
    const asset = (await server.inject({ method: 'POST', url: '/api/media', headers, payload: bytes })).json();
    const image = {type: 'image' as const, assetId: asset.id, width: 40, side: 'right' as const};
    const first = {version: 1 as const, content: [image, {type: 'text' as const, text: '在两图之间'}, {...image, placement: {xPercent: 53, offsetY: 11}}]};
    const db = server.zzServices.db;
    const note = db.createNote({body: '在两图之间', title: '', x: 32, y: 48, width: 200, height: 120, noteDocument: first});
    const next = {...first, content: [image, first.content[1], {...image, placement: {xPercent: 50, offsetY: 23}}]};
    db.updateNode(note.id, {revision: note.revision, noteDocument: next});
    expect(db.getNoteContentHistory(note.id).retainedEditTimes).toHaveLength(1);
    await server.close();
    app = await buildApp(loadConfig({ZZ_BOARD_DATA_DIR: root}), {db: new BoardDatabase(path.join(root, 'test.sqlite'))});
    const reopened = app.zzServices.db, current = () => reopened.getBoard().nodes.find(n => n.id === note.id);
    expect(current()).toMatchObject({x: 32, y: 48, body: '在两图之间', noteDocument: next});
    reopened.undo(); expect(current()?.noteDocument).toEqual(first);
    reopened.redo(); expect(current()?.noteDocument).toEqual(next);
  });
  it('bounds originals and previews, rejects animated, forged and corrupt pixel containers', async () => {
    const app = await setup();
    const png = await picture();
    const broken = Buffer.from(png); const at = broken.indexOf('IDAT'); broken[at + 4] ^= 255;
    const huge = Buffer.from(png); huge.writeUInt32BE(10000, 16); huge.writeUInt32BE(10000, 20);
    const jpeg = await picture('jpeg'); const brokenJpeg = Buffer.concat([jpeg.subarray(0, jpeg.indexOf(Buffer.from([255, 218])) + 10), Buffer.from([255, 217])]);
    const webp = await picture('webp'); const brokenWebp = Buffer.from(webp.subarray(0, 30)); brokenWebp.writeUInt32LE(22, 4); brokenWebp.writeUInt32LE(10, 16);
    const animated = Buffer.from(png); animated.write('acTL', animated.indexOf('IDAT'), 'ascii');
    for (const bytes of [Buffer.from('<svg/>'), broken, huge, animated, brokenJpeg, brokenWebp]) expect((await app.inject({ method: 'POST', url: '/api/media', headers, payload: bytes })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/media/usage' })).json().count).toBe(0);
    const large = await sharp({ create: { width: 1800, height: 1200, channels: 3, background: 'blue' } }).png().toBuffer();
    const asset = (await app.inject({ method: 'POST', url: '/api/media', headers, payload: large })).json();
    const preview = (await app.inject({ method: 'GET', url: `/api/media/${asset.id}/preview` })).rawPayload;
    expect(imageInfo(preview).width).toBe(1024); expect(asset.width).toBe(1800);
  });
  it('requires mutation authorization and rejects path references without persisting blobs in board state', async () => {
    const app = await setup(), bytes = await picture();
    expect((await app.inject({ method: 'POST', url: '/api/media', headers: { 'content-type': 'application/octet-stream' }, payload: bytes })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/media', headers: { ...headers, origin: 'https://example.com' }, payload: bytes })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/media/..%2Fsecret/original' })).statusCode).toBe(404);
    const asset = (await app.inject({ method: 'POST', url: '/api/media', headers, payload: bytes })).json();
    const note = await app.inject({ method: 'POST', url: '/api/notes', headers: { 'x-zz-board-mutation': '1' }, payload: { x: 0, y: 0, body: '', notePresentation: 'image', noteDocument: { version: 1, content: [{ type: 'image', assetId: asset.id }] } } });
    expect(note.statusCode, note.body).toBe(201);
    const board = (await app.inject({ method: 'GET', url: '/api/board' })).body;
    expect(board).not.toContain(bytes.toString('base64')); expect(board).toContain(asset.id);
  });
  it('rejects excess in-memory work before queuing buffers', async () => {
    await setup(); const db = new BoardDatabase(':memory:');
    try {
      const media = new MediaStore(path.join(root, 'queue'), db), bytes = await picture();
      const a = media.import(bytes), b = media.import(bytes);
      await expect(media.import(bytes)).rejects.toThrow(/稍后/);
      await Promise.all([a, b]); expect(db.mediaUsage().count).toBe(1);
    } finally { db.close(); }
  });
});
