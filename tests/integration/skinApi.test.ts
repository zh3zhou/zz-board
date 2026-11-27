import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { loadConfig } from '../../src/server/config.js';
import { BoardDatabase } from '../../src/server/database.js';
import { SkinLibrary } from '../../src/server/skinLibrary.js';
import { BUILT_IN_SKINS, serializeSkinPackage } from '../../src/shared/skin.js';
import { composedSkinStyle } from '../../src/web/skinRuntime.js';

let app: FastifyInstance | undefined;
let directory: string | undefined;
afterEach(async () => {
  await app?.close(); app = undefined;
  if (directory) await fs.rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('Skin library API', () => {
  it('lists declarative manifests, installs without applying, and sends a restrictive CSP', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zz-board-skin-api-'));
    const config = { ...loadConfig({ ZZ_BOARD_DATA_DIR: directory }), databasePath: ':memory:', demoMode: false };
    app = await buildApp(config, { db: new BoardDatabase(':memory:'), skins: new SkinLibrary(path.join(directory, 'skins')) });
    const listed = await app.inject({ method: 'GET', url: '/api/skins' });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers['content-security-policy']).toContain("object-src 'none'");
    expect(listed.json().items).toHaveLength(12);
    expect(listed.json().manifests.map((item: { skinId: string }) => item.skinId)).toContain('glass-drift');

    const source = BUILT_IN_SKINS.find((item) => item.schemaVersion === 3)!;
    const custom = {
      ...source,
      manifest: { ...source.manifest, skinId: 'quiet-garden', version: '1.0.0', displayName: '安静花园' },
      provenance: { ...source.provenance, createdAt: new Date().toISOString(), source: 'adapted' as const }
    };
    const installed = await app.inject({ method: 'POST', url: '/api/skins/install', headers: { 'x-zz-board-mutation': '1' }, payload: { text: serializeSkinPackage(custom) } });
    expect(installed.statusCode).toBe(201);
    expect(installed.json()).toMatchObject({ key: 'quiet-garden@1.0.0', builtIn: false, schemaVersion: 3, components: ['background', 'chrome', 'taskBubble', 'note', 'link', 'inkPalette'] });
    const board = await app.inject({ method: 'GET', url: '/api/board' });
    const { activeSkinRef, skinComponents } = board.json().settings;
    expect(activeSkinRef).toBe('ink-constellation@3.0.0');
    expect(composedSkinStyle(listed.json().manifests, activeSkinRef, skinComponents)).toMatchObject({
      '--paper': '#191A1B', '--panel': '#232426', '--note-skin-fill': '#35322F'
    });
  });

  it('rejects executable or traversing package content', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zz-board-skin-api-'));
    const config = { ...loadConfig({ ZZ_BOARD_DATA_DIR: directory }), databasePath: ':memory:', demoMode: false };
    app = await buildApp(config, { db: new BoardDatabase(':memory:'), skins: new SkinLibrary(path.join(directory, 'skins')) });
    const source = BUILT_IN_SKINS[0]!;
    const poisoned = { ...source, manifest: { ...source.manifest, skinId: 'unsafe', assets: [{ id: 'bad', file: '../bad.js', mediaType: 'image/png' }] } };
    const response = await app.inject({ method: 'POST', url: '/api/skins/install', headers: { 'x-zz-board-mutation': '1' }, payload: { text: JSON.stringify(poisoned) } });
    expect(response.statusCode).toBe(400);
    await expect(fs.stat(path.join(directory, 'skins'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
