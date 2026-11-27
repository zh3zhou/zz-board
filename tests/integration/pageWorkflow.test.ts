import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { BoardDatabase } from '../../src/server/database.js';
import { loadConfig } from '../../src/server/config.js';
import { createDemoSnapshot } from '../../src/shared/demo.js';
import { DEFAULT_PAGE_ID } from '../../src/shared/pages.js';
import type { BoardState, CanvasNodeRecord } from '../../src/shared/schema.js';

let app: FastifyInstance | undefined;
let directory: string | undefined;
afterEach(async () => {
  await app?.close(); app = undefined;
  if (directory) {
    const absolute = path.resolve(directory);
    if (!absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(absolute).startsWith('zz-page-workflow-')) throw new Error('Unexpected test cleanup target');
    await fs.rm(absolute, { recursive: true, force: true });
  }
  directory = undefined;
});
const headers = { 'x-zz-board-mutation': '1' };
async function setup() {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zz-page-workflow-'));
  const config = loadConfig({ ZZ_BOARD_DATA_DIR: directory });
  const db = new BoardDatabase(config.databasePath);
  app = await buildApp(config, { db });
  return { db, config };
}
async function write(method: 'POST' | 'PATCH', url: string, payload: unknown) {
  const response = await app!.inject({ method, url, headers, payload: payload as object });
  expect(response.statusCode, response.body).toBeLessThan(300);
  return response.json();
}
async function board(): Promise<BoardState> { return (await app!.inject('/api/board')).json(); }
function node(value: BoardState, id: string): CanvasNodeRecord { return value.nodes.find(item => item.id === id)!; }

describe('multi-page user workflow', () => {
  it('moves a folded project group once, preserves external links through undo and sync, then reopens in place', async () => {
    const { db, config } = await setup();
    const snapshot = createDemoSnapshot(8, new Date('2026-11-17T00:00:00Z'));
    db.importSnapshot(snapshot);
    const first = await board();
    const project = first.nodes.find(item => item.projectKey === snapshot.projects[0]!.projectKey)!;
    const target = await write('POST', '/api/pages', { name: 'Synthetic research' });
    const note = await write('POST', '/api/notes', { pageId: DEFAULT_PAGE_ID, body: '中文与图文布局保持', x: 25, y: 35 });
    const outside = await write('POST', '/api/notes', { pageId: DEFAULT_PAGE_ID, body: '留在原页', x: 80, y: 90 });
    await write('POST', '/api/links', { sourceNodeId: project.id, targetNodeId: note.id });
    await write('POST', '/api/links', { sourceNodeId: project.id, targetNodeId: outside.id });
    await write('PATCH', `/api/nodes/${encodeURIComponent(note.id)}`, { foldedIntoNodeId: project.id, revision: note.revision });
    const before = await board();
    const current = node(before, project.id);
    await write('POST', '/api/selection', { action: 'movePage', nodes: [{ id: current.id, revision: current.revision }], ink: [], targetPageId: target.id, delta: { x: 50, y: -10 } });
    const moved = await board();
    expect(node(moved, project.id).pageId).toBe(target.id);
    expect(node(moved, note.id)).toMatchObject({ pageId: target.id, body: note.body, x: 75, y: 25, foldedIntoNodeId: project.id });
    expect(node(moved, outside.id).pageId).toBe(DEFAULT_PAGE_ID);
    expect(moved.links).toEqual(before.links);
    const undo = await write('POST', '/api/history/undo', {});
    expect(undo.focusPageId).toBe(DEFAULT_PAGE_ID);
    const restored = await board();
    expect(node(restored, project.id).pageId).toBe(DEFAULT_PAGE_ID);
    expect(node(restored, note.id)).toMatchObject({ pageId: DEFAULT_PAGE_ID, x: 25, y: 35 });
    const redo = await write('POST', '/api/history/redo', {});
    expect(redo.focusPageId).toBe(target.id);
    db.importSnapshot(snapshot);
    expect(node(await board(), project.id).pageId).toBe(target.id);
    expect(node(await board(), note.id).body).toBe(note.body);
    await app!.close(); app = undefined;
    app = await buildApp(config, { db: new BoardDatabase(config.databasePath) });
    const reopened = await board();
    expect(node(reopened, project.id).pageId).toBe(target.id);
    expect(node(reopened, note.id).pageId).toBe(target.id);
    expect(reopened.links).toEqual(before.links);
  });

  it('makes archived pages readonly while allowing explicit source imports, and restores with checks paused', async () => {
    const { db } = await setup();
    const snapshot = createDemoSnapshot(8, new Date('2026-11-17T00:00:00Z'));
    db.importSnapshot(snapshot);
    const page = await write('POST', '/api/pages', { name: 'Synthetic archive' });
    const project = (await board()).nodes.find(item => item.projectKey === snapshot.projects[0]!.projectKey)!;
    await write('POST', '/api/selection', { action: 'movePage', nodes: [{ id: project.id, revision: project.revision }], ink: [], targetPageId: page.id });
    const note = await write('POST', '/api/notes', { pageId: page.id, body: '保留我的正文', x: 2, y: 3 });
    const archived = await write('POST', `/api/pages/${encodeURIComponent(page.id)}/archive`, { archived: true, revision: page.revision });
    expect(archived.autoCheckPaused).toBe(true);
    const before = await board();
    for (const [method, url, payload] of [
      ['POST', '/api/notes', { pageId: page.id, body: '不能写入', x: 0, y: 0 }],
      ['PATCH', `/api/nodes/${encodeURIComponent(note.id)}`, { body: '不能覆盖', revision: note.revision }],
      ['POST', '/api/annotations', { targetNodeId: note.id, body: '不能批注' }],
      ['POST', '/api/nodes/priorities', { updates: [{ id: note.id, revision: note.revision, manualPriority: 'p1' }] }]
    ] as const) {
      const result = await app!.inject({ method, url, headers, payload });
      expect(result.statusCode, result.body).toBeGreaterThanOrEqual(400);
      expect((await board()).nodes).toEqual(before.nodes);
    }
    const updated = createDemoSnapshot(8, new Date('2026-11-18T00:00:00Z'));
    updated.projects[0]!.name = 'Explicit source update';
    db.importSnapshot(updated);
    const imported = await board();
    expect(imported.projects.find(item => item.projectKey === project.projectKey)?.name).toBe('Explicit source update');
    expect(node(imported, project.id).pageId).toBe(page.id);
    expect(node(imported, note.id).body).toBe(note.body);
    const restored = await write('POST', `/api/pages/${encodeURIComponent(page.id)}/archive`, { archived: false, revision: archived.revision });
    expect(restored.archivedAt).toBeNull();
    expect(restored.autoCheckPaused).toBe(true);
    await write('PATCH', `/api/nodes/${encodeURIComponent(note.id)}`, { body: '恢复后可编辑', revision: node(await board(), note.id).revision });
    expect(node(await board(), note.id).body).toBe('恢复后可编辑');
  });
});
