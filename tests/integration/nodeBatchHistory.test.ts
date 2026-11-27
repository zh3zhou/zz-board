import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { BoardDatabase } from '../../src/server/database.js';
import { loadConfig } from '../../src/server/config.js';

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

describe('multi-node gesture history', () => {
  it('stores one drag gesture as one undo step', async () => {
    app = await buildApp({ ...loadConfig({}), databasePath: ':memory:', demoMode: false }, { db: new BoardDatabase(':memory:') });
    const headers = { 'x-zz-board-mutation': '1' };
    const first = (await app.inject({ method: 'POST', url: '/api/notes', headers, payload: { body: '一', x: 10, y: 20 } })).json();
    const second = (await app.inject({ method: 'POST', url: '/api/notes', headers, payload: { body: '二', x: 40, y: 50 } })).json();
    const moved = await app.inject({ method: 'POST', url: '/api/nodes/batch', headers, payload: { updates: [
      { id: first.id, patch: { x: 110, y: 120, revision: first.revision } },
      { id: second.id, patch: { x: 140, y: 150, revision: second.revision } }
    ] } });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().nodes.map((node: { x: number }) => node.x)).toEqual([110, 140]);
    await app.inject({ method: 'POST', url: '/api/history/undo', headers, payload: {} });
    const board = (await app.inject({ method: 'GET', url: '/api/board' })).json();
    expect(board.nodes.map((node: { x: number }) => node.x)).toEqual([10, 40]);
    expect(board.historyStatus.undoLabel).toBe('创建便签');
  });

  it('persists aspect locks, rejects stale toggles, and restores them through undo', async () => {
    app = await buildApp({ ...loadConfig({}), databasePath: ':memory:', demoMode: false }, { db: new BoardDatabase(':memory:') });
    const headers = { 'x-zz-board-mutation': '1' };
    const note = (await app.inject({ method: 'POST', url: '/api/notes', headers, payload: { body: '比例锁', x: 10, y: 20 } })).json();
    const locked = await app.inject({ method: 'PATCH', url: `/api/nodes/${encodeURIComponent(note.id)}`, headers, payload: { aspectLocked: true, revision: note.revision } });
    expect(locked.statusCode).toBe(200);
    expect(locked.json().aspectLocked).toBe(true);
    const stale = await app.inject({ method: 'PATCH', url: `/api/nodes/${encodeURIComponent(note.id)}`, headers, payload: { aspectLocked: false, revision: note.revision } });
    expect(stale.statusCode).toBe(409);
    await app.inject({ method: 'POST', url: '/api/history/undo', headers, payload: {} });
    const board = (await app.inject({ method: 'GET', url: '/api/board' })).json();
    expect(board.nodes.find((node: { id: string }) => node.id === note.id).aspectLocked).toBeNull();
  });
});
