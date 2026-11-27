import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../../src/server/app.js';
import { BoardDatabase } from '../../src/server/database.js';
import { loadConfig } from '../../src/server/config.js';
import { createDemoSnapshot } from '../../src/shared/demo.js';
import { APP_VERSION } from '../../src/shared/version.js';

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

describe('local API', () => {
  it('reports compatibility and lifetime metadata without exposing the storage path', async () => {
    app = await buildApp({ ...loadConfig({}), databasePath: ':memory:', demoMode: false }, { db: new BoardDatabase(':memory:') });
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      ok: true,
      appVersion: APP_VERSION,
      snapshotSchemaVersions: [1, 2, 3, 4],
      runtime: 'web-fallback',
      dataStoreId: expect.stringMatching(/^[a-f0-9]{16}$/),
      mode: 'local',
      uptimeSeconds: expect.any(Number)
    });
    expect(response.json()).not.toHaveProperty('storage');
    expect(response.json()).not.toHaveProperty('packagedRuntime');
  });

  it('reports the desktop resource identifier without exposing arbitrary environment values', async () => {
    const slot = 'zzb-runtime-' + 'a'.repeat(64);
    const desktop = { ZZ_BOARD_RUNTIME: 'desktop-sidecar', ZZ_BOARD_PACKAGED_RUNTIME: slot };
    expect(loadConfig({ ...desktop, ZZ_BOARD_RUNTIME: 'web-fallback' }).packagedRuntime).toBeUndefined();
    expect(loadConfig({ ...desktop, ZZ_BOARD_PACKAGED_RUNTIME: 'unrelated env text' }).packagedRuntime).toBeUndefined();
    app = await buildApp({ ...loadConfig(desktop), databasePath: ':memory:' }, { db: new BoardDatabase(':memory:') });
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.json()).toMatchObject({ runtime: 'desktop-sidecar', packagedRuntime: slot });
  });

  it('requires the deliberate mutation header', async () => {
    app = await buildApp({ ...loadConfig({}), databasePath: ':memory:', demoMode: false }, { db: new BoardDatabase(':memory:') });
    const denied = await app.inject({ method: 'POST', url: '/api/notes', payload: { body: 'hello', x: 0, y: 0 } });
    expect(denied.statusCode).toBe(403);
  });

  it('creates and moves a local note without touching Codex', async () => {
    app = await buildApp({ ...loadConfig({}), databasePath: ':memory:', demoMode: false }, { db: new BoardDatabase(':memory:') });
    const created = await app.inject({
      method: 'POST', url: '/api/notes', headers: { 'x-zz-board-mutation': '1' },
      payload: { title: '想法', body: '试一下空间便签', x: 20, y: 30, width: 210, height: 150 }
    });
    expect(created.statusCode).toBe(201);
    const note = created.json();
    const moved = await app.inject({ method: 'PATCH', url: `/api/nodes/${encodeURIComponent(note.id)}`, headers: { 'x-zz-board-mutation': '1' }, payload: { x: 88, revision: note.revision } });
    expect(moved.json().x).toBe(88);
    expect((await app.inject({ method: 'GET', url: '/api/board' })).json().nodes).toHaveLength(1);
  });

  it('persists a local visual link between two canvas records', async () => {
    app = await buildApp({ ...loadConfig({}), databasePath: ':memory:', demoMode: false }, { db: new BoardDatabase(':memory:') });
    const headers = { 'x-zz-board-mutation': '1' };
    const first = (await app.inject({ method: 'POST', url: '/api/notes', headers, payload: { body: '起点', x: 20, y: 30 } })).json();
    const second = (await app.inject({ method: 'POST', url: '/api/notes', headers, payload: { body: '终点', x: 260, y: 180 } })).json();
    const linked = await app.inject({ method: 'POST', url: '/api/links', headers,
      payload: { sourceNodeId: first.id, targetNodeId: second.id, label: '' } });
    expect(linked.statusCode).toBe(201);
    expect(linked.json()).toMatchObject({ sourceNodeId: first.id, targetNodeId: second.id });
    expect((await app.inject({ method: 'GET', url: '/api/board' })).json().links).toEqual([linked.json()]);
    const revision = (await app.inject({ method: 'GET', url: '/api/board' })).json().boardRevision;
    const reversed = await app.inject({ method: 'POST', url: '/api/links', headers,
      payload: { sourceNodeId: second.id, targetNodeId: first.id, label: '重复' } });
    expect(reversed.statusCode).toBe(201);
    expect(reversed.json().id).toBe(linked.json().id);
    const after = (await app.inject({ method: 'GET', url: '/api/board' })).json();
    expect(after.links).toHaveLength(1);
    expect(after.boardRevision).toBe(revision);
  });

  it('sets one or many manual priorities in one revision-safe mutation', async () => {
    app = await buildApp({ ...loadConfig({}), databasePath: ':memory:', demoMode: false }, { db: new BoardDatabase(':memory:') });
    const headers = { 'x-zz-board-mutation': '1' };
    const first = (await app.inject({ method: 'POST', url: '/api/notes', headers, payload: { body: '一', x: 0, y: 0 } })).json();
    const second = (await app.inject({ method: 'POST', url: '/api/notes', headers, payload: { body: '二', x: 20, y: 20 } })).json();
    const before = (await app.inject({ method: 'GET', url: '/api/board' })).json().boardRevision;
    expect((await app.inject({ method: 'POST', url: '/api/nodes/priorities', payload: { updates: [] } })).statusCode).toBe(403);
    const changed = await app.inject({ method: 'POST', url: '/api/nodes/priorities', headers, payload: { updates: [
      { id: first.id, revision: first.revision, manualPriority: 'p1' },
      { id: second.id, revision: second.revision, manualPriority: 'p3' }
    ] } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ boardRevision: before + 1, nodes: [{ manualPriority: 'p1' }, { manualPriority: 'p3' }] });
    const stale = await app.inject({ method: 'POST', url: '/api/nodes/priorities', headers, payload: { updates: [
      { id: first.id, revision: changed.json().nodes[0].revision, manualPriority: 'p2' },
      { id: second.id, revision: second.revision, manualPriority: null }
    ] } });
    expect(stale.statusCode).toBe(409);
    const board = (await app.inject({ method: 'GET', url: '/api/board' })).json();
    expect(board.nodes.find((node: { id: string }) => node.id === first.id).manualPriority).toBe('p1');
    expect(board.nodes.find((node: { id: string }) => node.id === second.id).manualPriority).toBe('p3');
  });

  it('evaluates pinned days without writing, and saves each arrangement as one revision-safe operation', async () => {
    const db = new BoardDatabase(':memory:');
    app = await buildApp({ ...loadConfig({}), databasePath: ':memory:', demoMode: false }, { db });
    db.importSnapshot(createDemoSnapshot(1));
    const project = db.getBoard().nodes.find(node => node.kind === 'task')!;
    const note = db.createNote({ title: '', body: 'fixture', x: 1, y: 2, width: 180, height: 140 });
    const headers = { 'x-zz-board-mutation': '1' };
    const update = (id: string, revision: number, noteSchedule: unknown) => app!.inject({ method: 'POST', url: '/api/nodes/priorities', headers,
      payload: { updates: [{ id, revision, manualPriority: 'p3', noteSchedule }] } });
    const board = async (day: string) => (await app!.inject({ method: 'GET', url: `/api/board?priorityDate=${day}` })).json();
    const schedule = { dueDate: '2026-03-09', autoPromote: true, attentionDays: 7, priorityDays: 1, completed: false };
    expect((await update(project.id, project.revision, schedule)).statusCode).toBe(409);
    expect((await update(note.id, note.revision, { ...schedule, priorityDays: 8 })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/board?priorityDate=2026-02-30' })).statusCode).toBe(400);
    const saved = (await update(note.id, note.revision, schedule)).json();
    expect(saved.nodes[0]).toMatchObject({ id: note.id, noteSchedule: schedule, contentEditedAt: note.contentEditedAt, manualPriority: 'p3' });
    const at = async (day: string) => {
      const b = await board(day); expect(b).toMatchObject({ priorityDate: day, boardRevision: saved.boardRevision });
      return b.nodes.find((row: { id: string }) => row.id === note.id);
    };
    expect(await at('2026-03-01')).toMatchObject({ effectivePriority: 'p2', prioritySource: 'manual' });
    expect(await at('2026-03-02')).toMatchObject({ effectivePriority: 'p2', prioritySource: 'both' });
    expect(await at('2026-03-08')).toMatchObject({ effectivePriority: 'p1', prioritySource: 'date' });
    expect((await update(note.id, saved.nodes[0].revision, schedule)).json().boardRevision).toBe(saved.boardRevision);
    expect((await update(note.id, note.revision, null)).statusCode).toBe(409);
    const completed = (await update(note.id, saved.nodes[0].revision, { ...schedule, completed: true })).json();
    expect(completed.nodes[0]).toMatchObject({ effectivePriority: 'p2', prioritySource: 'manual', noteSchedule: { dueDate: schedule.dueDate, completed: true } });
    db.undo(); expect(db.getBoard('2026-03-09').nodes.find(row => row.id === note.id)).toMatchObject({ effectivePriority: 'p1', noteSchedule: schedule, manualPriority: 'p3' });
    db.redo(); db.undo(); db.undo();
    expect(db.getBoard().nodes.find(row => row.id === note.id)).toMatchObject({ manualPriority: null, noteSchedule: null, contentEditedAt: note.contentEditedAt });
    db.redo();
    const archived = db.setNoteArchived(note.id, true, saved.nodes[0].revision);
    expect((await update(note.id, archived.revision, null)).statusCode).toBe(409);
    const restored = db.setNoteArchived(note.id, false, archived.revision);
    expect((await update(note.id, restored.revision, null)).json().nodes[0]).toMatchObject({ noteSchedule: null, effectivePriority: 'p2' });
  });

  it('returns V3 preview counts and a daily review driven only by manual project priority', async () => {
    const db = new BoardDatabase(':memory:');
    const snapshot = createDemoSnapshot(16, new Date('2026-08-20T00:00:00.000Z'));
    const extraThread = {
      ...snapshot.threads[0]!,
      threadKey: 'demo:extra-same-project',
      threadId: 'extra-same-project',
      title: 'Independent review blocker in the first project',
      humanAction: 'review' as const,
      stopPoint: 'A separate artifact is explicitly waiting for review.'
    };
    snapshot.threads.push(extraThread);
    snapshot.coverage.threadsFound = snapshot.threads.length;
    snapshot.todos.push({
      ...snapshot.todos[0]!,
      todoKey: 'demo-extra-same-project',
      sourceThreadKeys: [extraThread.threadKey],
      kind: 'review',
      title: extraThread.title,
      minimumAction: 'Review the separate artifact and record a decision.',
      whyNow: extraThread.stopPoint,
      explicitDeadline: '2026-08-19T00:00:00.000Z'
    });
    app = await buildApp({ ...loadConfig({}), databasePath: ':memory:', demoMode: false }, { db });
    const preview = await app.inject({
      method: 'POST', url: '/api/snapshots/preview', headers: { 'x-zz-board-mutation': '1' },
      payload: { text: JSON.stringify(snapshot) }
    });
    expect(preview.json()).toMatchObject({ schemaVersion: 3, projectBriefs: 8, todos: snapshot.todos.length });
    db.importSnapshot(snapshot);
    expect((await app.inject({ method: 'GET', url: '/api/daily-review' })).json().items).toEqual([]);

    const projectNodes = db.getBoard().nodes.filter((node) => node.projectKey && !node.threadKey).slice(0, 2);
    db.setNodePriorities([
      { id: projectNodes[0]!.id, revision: projectNodes[0]!.revision, manualPriority: 'p3' },
      { id: projectNodes[1]!.id, revision: projectNodes[1]!.revision, manualPriority: 'p1' }
    ]);

    const review = (await app.inject({ method: 'GET', url: '/api/daily-review' })).json();
    expect(review.date).toBe((await app.inject({ method: 'GET', url: '/api/board' })).json().priorityDate);
    expect(review.items.length).toBeGreaterThan(0);
    expect(new Set(review.items.map((item: { projectKey: string }) => item.projectKey))).toEqual(new Set(projectNodes.map((node) => node.projectKey)));
    expect(review.items[0]).toMatchObject({ todoKey: expect.any(String), threadKey: expect.any(String), minimumAction: expect.any(String), manualPriority: 'p1' });
    expect(review.items.at(-1).manualPriority).toBe('p2');
  });

  it('creates only one note when an offline request is retried with the same clientRequestId', async () => {
    app = await buildApp({ ...loadConfig({}), databasePath: ':memory:', demoMode: false }, { db: new BoardDatabase(':memory:') });
    const request = {
      method: 'POST' as const,
      url: '/api/notes',
      headers: { 'x-zz-board-mutation': '1' },
      payload: { clientRequestId: 'offline-note-12345678', title: '离线想法', body: '只应该保存一次', x: 12, y: 34 }
    };
    const first = await app.inject(request);
    const retried = await app.inject(request);
    expect(retried.json().id).toBe(first.json().id);
    expect((await app.inject({ method: 'GET', url: '/api/board' })).json().nodes).toHaveLength(1);
  });

  it('exposes revision-safe archive, restore and archived-only deletion while rejecting task mutations', async () => {
    const db = new BoardDatabase(':memory:');
    db.importSnapshot(createDemoSnapshot(1));
    app = await buildApp({ ...loadConfig({}), databasePath: ':memory:', demoMode: false }, { db });
    const headers = { 'x-zz-board-mutation': '1' };
    const note = (await app.inject({ method: 'POST', url: '/api/notes', headers,
      payload: { body: '归档后才允许永久删除', x: 12, y: 34 } })).json();
    const url = `/api/notes/${encodeURIComponent(note.id)}`;
    expect((await app.inject({ method: 'DELETE', url, headers, payload: { revision: note.revision } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `${url}/archive`, headers, payload: { archived: true } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${url}/archive`, payload: { archived: true, revision: note.revision } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: `/api/nodes/${encodeURIComponent(note.id)}`, headers,
      payload: { archivedAt: '2026-08-31T00:00:00.000Z', revision: note.revision } })).statusCode).toBe(400);
    const archivedResponse = await app.inject({ method: 'POST', url: `${url}/archive`, headers,
      payload: { archived: true, revision: note.revision } });
    expect(archivedResponse.statusCode).toBe(200);
    const archived = archivedResponse.json();
    expect(archived).toMatchObject({ body: note.body, x: 12, y: 34, archivedAt: expect.any(String), revision: note.revision + 1 });
    expect((await app.inject({ method: 'POST', url: `${url}/archive`, headers,
      payload: { archived: false, revision: note.revision } })).statusCode).toBe(409);
    const restored = (await app.inject({ method: 'POST', url: `${url}/archive`, headers,
      payload: { archived: false, revision: archived.revision } })).json();
    expect(restored.archivedAt).toBeNull();
    const rearchived = (await app.inject({ method: 'POST', url: `${url}/archive`, headers,
      payload: { archived: true, revision: restored.revision } })).json();
    expect((await app.inject({ method: 'DELETE', url, headers })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url, headers, payload: { revision: restored.revision } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url, headers, payload: { revision: rearchived.revision } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: `${url}/archive`, headers,
      payload: { archived: false, revision: rearchived.revision } })).statusCode).toBe(404);
    for (const task of db.getBoard().nodes.filter((node) => node.kind === 'task')) {
      const taskUrl = `/api/notes/${encodeURIComponent(task.id)}`;
      expect((await app.inject({ method: 'POST', url: `${taskUrl}/archive`, headers,
        payload: { archived: true, revision: task.revision } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'DELETE', url: taskUrl, headers, payload: { revision: task.revision } })).statusCode).toBe(409);
    }
  });

  it('returns terminal HTTP 410 when a deleted offline create request is retried', async () => {
    const db = new BoardDatabase(':memory:');
    app = await buildApp({ ...loadConfig({}), databasePath: ':memory:', demoMode: false }, { db });
    const headers = { 'x-zz-board-mutation': '1' };
    const createRequest = { method: 'POST' as const, url: '/api/notes', headers,
      payload: { clientRequestId: 'terminal-offline-request', title: '', body: '不能被延迟重试复活', x: 0, y: 0 } };
    const note = (await app.inject(createRequest)).json();
    const url = `/api/notes/${encodeURIComponent(note.id)}`;
    const archived = (await app.inject({ method: 'POST', url: `${url}/archive`, headers,
      payload: { archived: true, revision: note.revision } })).json();
    expect((await app.inject({ method: 'DELETE', url, headers, payload: { revision: archived.revision } })).statusCode).toBe(204);
    const revision = db.getBoardRevision();
    const retry = await app.inject(createRequest);
    expect(retry.statusCode).toBe(410);
    expect(retry.json()).toEqual({ error: 'This note was permanently deleted. Discard the queued create request.' });
    expect(db.getBoardRevision()).toBe(revision);
    expect(db.getBoard().nodes).toHaveLength(0);
  });

  it('streams the committed board revision after a mutation', async () => {
    app = await buildApp({ ...loadConfig({}), databasePath: ':memory:', demoMode: false }, { db: new BoardDatabase(':memory:') });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;
    const events = await fetch(`http://127.0.0.1:${address.port}/events`);
    expect(events.headers.get('content-type')).toContain('text/event-stream');
    const reader = events.body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    expect(initial).toContain('"boardRevision":0');

    const mutated = await fetch(`http://127.0.0.1:${address.port}/api/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zz-board-mutation': '1' },
      body: JSON.stringify({ body: 'SSE synthetic note', x: 0, y: 0 })
    });
    expect(mutated.status).toBe(201);
    const update = new TextDecoder().decode((await reader.read()).value);
    expect(update).toContain('"boardRevision":1');
    const note = await mutated.json() as { id: string; revision: number };
    const archived = await fetch(`http://127.0.0.1:${address.port}/api/notes/${encodeURIComponent(note.id)}/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zz-board-mutation': '1' },
      body: JSON.stringify({ archived: true, revision: note.revision })
    });
    expect(archived.status).toBe(200);
    const archiveEvent = new TextDecoder().decode((await reader.read()).value);
    expect(archiveEvent).toContain('"boardRevision":2');
    await reader.cancel();
  });
});
