import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { dataStoreId, loadConfig } from '../../src/server/config.js';
import { BoardDatabase } from '../../src/server/database.js';
import type { CaptureConversationNoteInput, ConversationNoteReceipt } from '../../src/shared/conversationNote.js';
import { createDemoSnapshot } from '../../src/shared/demo.js';
import { canvasNodeSchema, type BoardSnapshotV1, type SnapshotProject, type SnapshotThread } from '../../src/shared/schema.js';

const when = '2026-01-01T00:00:00.000Z';
const threadId = '00000000-0000-4000-8000-000000000001';
const newId = '00000000-0000-4000-8000-000000000002';
const project: SnapshotProject = { projectKey: 'A', name: '同名项目', cwd: 'C:\\Example\\Sample', hostId: 'local', observedAt: when };
const other = { ...project, projectKey: 'B', cwd: 'C:\\Elsewhere\\Sample' };
const thread: SnapshotThread = { ...createDemoSnapshot(1, new Date(when)).threads[0]!, threadKey: 'saved:one', threadId,
  projectKey: project.projectKey, hostId: 'local', sourceKind: 'codex', title: '同名讨论', evidence: 'synthetic evidence outside the note' };
const mutation = { 'x-zz-board-mutation': '1' };
const route = '/api/notes/from-conversation';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function snapshot(projects: SnapshotProject[], threads: SnapshotThread[], generatedAt = when): BoardSnapshotV1 {
  return { schemaVersion: 1, source: 'review-project-progress', generatedAt, projects, threads,
    coverage: { projectsFound: projects.length, threadsFound: threads.length, deepRead: 0, fileChecked: 0, truncated: false, inaccessible: [] } };
}

async function fixture(projects = [project, other], threads = [thread]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zz-capture-test-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const config = loadConfig({ ZZ_BOARD_DATA_DIR: dir });
  const open = async () => {
    const db = new BoardDatabase(config.databasePath);
    const app = await buildApp(config, { db });
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await app.close(); } };
    cleanup.push(close);
    const input: CaptureConversationNoteInput = { mode: 'apply', expectedDataStoreId: dataStoreId(dir), clientRequestId: 'synthetic-request',
      project: { directory: 'c:/example/Sample/' }, expectedProjectKey: 'A', source: { hostId: 'local', threadId }, title: '布局决定', body: '已决定分两步。\n下一步验证保存。' };
    const send = (changes: Partial<CaptureConversationNoteInput> = {}) => app.inject({ method: 'POST', url: route, headers: mutation, payload: { ...input, ...changes } });
    return { app, db, close, send, input };
  };
  const current = await open();
  current.db.importSnapshot(snapshot(projects, threads));
  return { ...current, open, file: config.databasePath };
}

describe('remember an explicit Codex discussion as a connected local note', () => {
  it('previews privately, follows the project onto its current page, and undoes/redoes the note and edge together', async () => {
    const f = await fixture();
    const initial = f.db.getBoard();
    expect((await f.app.inject('/api/health')).json().capabilities.captureConversationNote).toBe(true);
    const preview = await f.send({ mode: 'preview', expectedProjectKey: undefined });
    const draft = preview.json<ConversationNoteReceipt>();
    expect(draft).toMatchObject({status: 'preview', projectKey: 'A', projectNodeId: 'project:A', source: { threadKey: 'saved:one' }});
    expect(preview.body).not.toContain(thread.evidence);
    expect(f.db.getBoard()).toEqual(initial);
    const page = f.db.createPage('研发');
    const anchor = initial.nodes.find(n => n.id === draft.projectNodeId)!;
    f.db.applySelectionAction({ action: 'movePage', nodes: [{ id: anchor.id, revision: anchor.revision }], ink: [], targetPageId: page.id });
    const before = f.db.getBoard();
    const reply = await f.send();
    const receipt = reply.json<ConversationNoteReceipt>();
    expect(reply.statusCode).toBe(201);
    expect(receipt).toMatchObject({ status: 'created', noteId: draft.noteId, pageId: page.id, pageName: page.name, source: draft.source });
    const board = f.db.getBoard(), note = board.nodes.find(n => n.id === receipt.noteId)!;
    expect(board.nodes.filter(n => n.id !== note.id)).toEqual(before.nodes);
    expect(board.threads).toEqual(before.threads);
    expect(canvasNodeSchema.parse(note)).toMatchObject({ pageId: page.id, kind: 'note', projectKey: null, threadKey: null,
      title: f.input.title, body: f.input.body, noteSource: receipt.source });
    expect(board.links).toHaveLength(1);
    expect(board.links[0]).toMatchObject({ sourceNodeId: anchor.id, targetNodeId: note.id });
    expect(board.boardRevision).toBe(before.boardRevision! + 1);
    f.db.undo();
    expect(f.db.getBoard().links).toEqual(before.links);
    expect(f.db.getBoard().nodes).toEqual(before.nodes);
    expect((await f.send()).json().code).toBe('capture_retired');
    f.db.redo();
    expect(f.db.getBoard().nodes.find(n => n.id === note.id)).toEqual(note);
    expect(f.db.getBoard().links).toEqual(board.links);
  });

  it('deduplicates concurrent submissions and survives edits, manual unlinking and permanent deletion across restarts', async () => {
    const f = await fixture();
    const [a,b] = await Promise.all([f.send(), f.send()]);
    expect([a.statusCode,b.statusCode].sort()).toEqual([200,201]);
    const { noteId } = a.json<ConversationNoteReceipt>();
    const linked = f.db.getBoard().links[0]!;
    f.db.deleteLink(linked.id, linked.revision);
    const edited = f.db.updateNode(noteId, { revision: 0, body: '用户后续修改' });
    const revision = f.db.getBoardRevision();
    expect((await f.send()).json().status).toBe('existing');
    expect((await f.send({ body: '另一份总结' })).json().code).toBe('request_conflict');
    expect(f.db.getBoardRevision()).toBe(revision);
    expect(f.db.getBoard().links).toHaveLength(0);
    expect(f.db.getBoard().nodes.find(n => n.id === noteId)).toEqual(edited);
    const archived = f.db.setNoteArchived(noteId, true, edited.revision);
    expect((await f.send()).json().code).toBe('note_archived');
    f.db.deleteNote(noteId, archived.revision);
    await f.close();
    const next = await f.open();
    const retired = await next.send();
    expect(retired.statusCode).toBe(410);
    expect(retired.json()).toMatchObject({ code: 'capture_retired', error: expect.stringContaining('永久删除') });
    const inspect = new DatabaseSync(f.file);
    try {
      expect(inspect.prepare('SELECT * FROM conversation_note_requests').all()).toEqual([{ node_id: noteId, digest: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    } finally { inspect.close(); }
  });

  it('retries the same registered source with or without its exact key', async () => {
    const f = await fixture();
    const unqualified = f.input.source, exact = { ...unqualified, threadKey: thread.threadKey };
    for (const [first, retry] of [[unqualified, exact], [exact, unqualified]]) {
      const clientRequestId = first === exact ? 'explicit-first' : 'implicit-first';
      const saved = await f.send({ clientRequestId, source: first });
      expect(saved.statusCode).toBe(201);
      const before = f.db.getBoard();
      expect((await f.send({ clientRequestId, source: retry })).json()).toEqual({ ...saved.json(), status: 'existing' });
      expect(f.db.getBoard()).toEqual(before);
    }
  });

  it('replays an old omitted-selector receipt but refuses a different recorded alias', async () => {
    const f = await fixture();
    const { noteId } = (await f.send()).json<ConversationNoteReceipt>();
    // The first implementation hashed the caller's absent key even though the verified key was saved on the note.
    const oldDigest = createHash('sha256').update(JSON.stringify(['A', 'local', threadId, null, f.input.title, f.input.body])).digest('hex');
    const legacy = new DatabaseSync(f.file);
    try { legacy.prepare('UPDATE conversation_note_requests SET digest=? WHERE node_id=?').run(oldDigest, noteId); }
    finally { legacy.close(); }
    const alias = { ...thread, threadKey: 'another-known-key' };
    f.db.importSnapshot(snapshot([project, other], [thread, alias], '2026-01-02T00:00:00.000Z'));
    const before = f.db.getBoard();
    expect((await f.send({ source: { ...f.input.source, threadKey: thread.threadKey } })).json()).toMatchObject({ status: 'existing', noteId });
    expect((await f.send({ source: { ...f.input.source, threadKey: alias.threadKey } })).json().code).toBe('source_mismatch');
    expect(f.db.getBoard()).toEqual(before);
  });

  it('preserves the current local origin before first sync without fabricating board threads', async () => {
    const f = await fixture();
    const source = { hostId: 'local', threadId: newId };
    const before = f.db.getBoard().threads;
    expect((await f.send({ project: { projectKey: 'A' }, source })).json().code).toBe('source_not_found');
    expect((await f.send({ source: { hostId: 'local', threadId: 'untrusted/path' } })).json().code).toBe('source_not_found');
    const result = await f.send({ source });
    const receipt = result.json<ConversationNoteReceipt>();
    expect(receipt.source).toEqual({ ...source, projectKey: 'A', threadKey: null, sourceKind: 'codex' });
    expect(f.db.getBoard().threads).toEqual(before);
    const now = '2026-01-02T00:00:00.000Z';
    const indexed = { ...thread, threadId: newId, threadKey: 'imported-later', observedAt: now };
    f.db.importSnapshot(snapshot([project, other], [thread, indexed], now));
    expect((await f.send({ source })).json()).toMatchObject({ status: 'existing', noteId: receipt.noteId });
    const qualified = { ...source, threadKey: indexed.threadKey };
    expect((await f.send({ source: qualified })).json()).toMatchObject({ status: 'existing', source: receipt.source, resolvedThreadKey: indexed.threadKey });
    f.db.importSnapshot(snapshot([project, other], [thread, indexed, { ...indexed, threadKey: 'ambiguous-later' }], '2026-01-03T00:00:00.000Z'));
    expect((await f.send({ source: qualified })).json().code).toBe('ambiguous_source');
    expect(f.db.getBoard().nodes.filter(n => n.kind === 'note')).toHaveLength(1);
  });

  it('rejects wrong binding, missing authorization header, ambiguous directories and archived projects without writes', async () => {
    const f = await fixture([project, { ...other, cwd: project.cwd }]);
    const start = f.db.getBoardRevision();
    const direct = { projectKey: 'A' };
    for (const mode of ['preview', 'apply'] as const) expect((await f.send({ mode, expectedDataStoreId: '1'.repeat(16) })).json().code).toBe('wrong_board');
    expect((await f.app.inject({ method: 'POST', url: route, payload: f.input })).statusCode).toBe(403);
    expect((await f.send({ expectedProjectKey: undefined })).json().code).toBe('invalid_capture');
    expect((await f.send({ title: '  ' })).json().code).toBe('invalid_capture');
    expect((await f.send({ body: '文'.repeat(20_001) })).json().code).toBe('invalid_capture');
    expect((await f.send({ project: { directory: 'Sample' } })).json().code).toBe('invalid_capture');
    expect((await f.send()).json().code).toBe('ambiguous_project');
    expect((await f.send({ project: direct, expectedProjectKey: 'B' })).json().code).toBe('project_changed');
    expect((await f.send({ project: direct, mode: 'preview' })).json().status).toBe('preview');
    expect(f.db.getBoardRevision()).toBe(start);
    const secondPage = f.db.createPage('活动页'), oldPage = f.db.getPage(f.db.getDefaultPageId());
    f.db.archivePage(oldPage.id, { revision: oldPage.revision, archived: true, replacementDefaultPageId: secondPage.id });
    expect((await f.send({ project: direct })).json().code).toBe('project_archived');
    expect(f.db.getBoard().nodes.filter(n => n.kind === 'note')).toHaveLength(0);
  });

  it('checks qualified host, native ID, project and exact keys for saved local or remote threads', async () => {
    const remoteProject = { ...other, hostId: 'ssh:sample' };
    const remote = { ...thread, threadId: 'remote/native', threadKey: 'remote:key', projectKey: 'B', sourceKind: 'remote' as const, hostId: remoteProject.hostId };
    const f = await fixture([project, remoteProject], [
      { ...thread, hostId: undefined, threadKey: 'codex:local:' + threadId },
      { ...thread, hostId: undefined, threadId: newId, threadKey: 'unknown-host' }, remote
    ]);
    expect((await f.send({ mode: 'preview' })).json().source.threadKey).toBe('codex:local:' + threadId);
    expect((await f.send({ source: { hostId: 'local', threadId: newId } })).json().code).toBe('source_mismatch');
    expect((await f.send({ source: { hostId: 'local', threadId, threadKey: remote.threadKey } })).json().code).toBe('source_mismatch');
    const selector = { project: {projectKey: 'B'}, expectedProjectKey: 'B', source: { hostId: remoteProject.hostId, threadId: remote.threadId, threadKey: remote.threadKey } };
    expect((await f.send({ ...selector, source: { ...selector.source, hostId: 'local' } })).json().code).toBe('source_mismatch');
    expect((await f.send({ ...selector, source: { hostId: remoteProject.hostId, threadId: newId + 'x' } })).json().code).toBe('source_not_found');
    expect((await f.send(selector)).json().source).toEqual({ ...selector.source, projectKey: 'B', sourceKind: 'remote' });
  });

  it('rolls back the entire creation on a link failure and can retry the same operation', async () => {
    const f = await fixture();
    const before = f.db.getBoard(), inspect = new DatabaseSync(f.file);
    try {
      inspect.exec("CREATE TRIGGER fail_capture_link BEFORE INSERT ON local_links BEGIN SELECT RAISE(ABORT, 'synthetic link failure'); END");
      const failed = await f.send();
      expect(failed.statusCode).toBe(500);
      expect(failed.json().code).toBe('capture_unavailable');
      expect(f.db.getBoard()).toEqual(before);
      expect(inspect.prepare('SELECT count(*) AS count FROM conversation_note_requests').get()?.count).toBe(0);
      inspect.exec('DROP TRIGGER fail_capture_link');
      expect((await f.send()).statusCode).toBe(201);
    } finally { inspect.close(); }
  });

  it('does not mistake aliases or conflicting UUID spellings for an unseen local conversation', async () => {
    const native = 'aba00000-0000-4000-8000-000000000001';
    const first = { ...thread, threadId: native, threadKey: 'first' };
    const alias = { ...first, threadKey: 'alias' };
    const f = await fixture([project, other], [first, alias, { ...thread, threadId: 'different-id', threadKey: 'codex:local:' + newId }]);
    const source = { hostId: 'local', threadId: native.toUpperCase() };
    expect((await f.send({ source })).json().code).toBe('ambiguous_source');
    expect((await f.send({ project: { projectKey: 'B' }, expectedProjectKey: 'B', source })).json().code).toBe('source_mismatch');
    expect((await f.send({ source: { hostId: 'local', threadId: newId } })).json().code).toBe('source_mismatch');
    expect((await f.send({ source: { hostId: 'local', threadId: native + '\n' } })).json().code).toBe('invalid_capture');
    const exact = await f.send({ source: { ...source, threadKey: 'alias' } });
    expect(exact.json().source).toMatchObject({ threadKey: 'alias', threadId: native });
  });

  it('opens a previous SQLite layout and replays a plain note whose history predates source metadata', async () => {
    const f = await fixture();
    const ordinary = f.db.createNote({ title:'旧便签', body:'原文', x:45, y:15, width:120, height:100 });
    await f.close();
    const legacy = new DatabaseSync(f.file);
    try {
      legacy.exec('ALTER TABLE canvas_nodes DROP COLUMN note_source; DROP TABLE conversation_note_requests');
      const row = legacy.prepare("SELECT sequence,patch_json FROM operation_journal WHERE label='创建便签'").get()!;
      const changes = JSON.parse(String(row.patch_json));
      delete changes[0].after.note_source;
      legacy.prepare('UPDATE operation_journal SET patch_json=? WHERE sequence=?').run(JSON.stringify(changes), row.sequence!);
    } finally { legacy.close(); }
    const next = await f.open();
    expect(next.db.getBoard().nodes.find(n => n.id === ordinary.id)).toEqual(ordinary);
    next.db.undo(); next.db.redo();
    expect(next.db.getBoard().nodes.find(n => n.id === ordinary.id)).toEqual(ordinary);
    expect((await next.send()).statusCode).toBe(201);
  });
});
