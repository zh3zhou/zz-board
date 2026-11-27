import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { BoardDatabase } from '../../src/server/database.js';
import { buildApp } from '../../src/server/app.js';
import { loadConfig } from '../../src/server/config.js';
import { createDemoSnapshot } from '../../src/shared/demo.js';
import { createNoteInputSchema, drawingPreferencesSchema } from '../../src/shared/schema.js';

let app: FastifyInstance | undefined;
let db: BoardDatabase | undefined;
afterEach(async () => { if (app) await app.close(); else db?.close(); app = undefined; db = undefined; });
const headers = { 'x-zz-board-mutation': '1' };
const noteInput = (body = '') => createNoteInputSchema.parse({ body, x: 20, y: 30 });
const getNode = (id: string) => db!.getBoard().nodes.find((node) => node.id === id)!;

describe('V0.6 persistence', () => {
  it('migrates only legacy note bodies once and respects intentional blank/placeholder text after restart', () => {
    const tempRoot = path.resolve('.tmp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(tempRoot, 'v06-note-body-'));
    const databasePath = path.join(directory, 'board.sqlite');
    try {
      db = new BoardDatabase(databasePath);
      const a = db.createNote({ ...noteInput(''), title: '旧标题 A' });
      const b = db.createNote({ ...noteInput('写下一句话…'), title: '旧标题 B' });
      const c = db.createNote({ ...noteInput('真实正文'), title: '隐藏标题' });
      db.close(); db = undefined;
      const old = new DatabaseSync(databasePath);
      old.prepare('DELETE FROM settings WHERE key=?').run('noteBodyMigrationV06');
      old.close();
      db = new BoardDatabase(databasePath);
      expect(getNode(a.id)).toMatchObject({ body: '旧标题 A', title: '旧标题 A', x: a.x, y: a.y });
      expect(getNode(b.id).body).toBe('旧标题 B');
      expect(getNode(a.id).contentEditedAt).toBeNull();
      expect(db.getNoteContentHistory(a.id).retainedEditTimes).toEqual([]);
      expect(getNode(c.id).body).toBe('真实正文');
      db.undo();
      expect(getNode(a.id).body).toBe('');
      expect(getNode(b.id).body).toBe('写下一句话…');
      db.redo();
      db.updateNode(a.id, { body: '', revision: getNode(a.id).revision });
      db.updateNode(b.id, { body: '写下一句话…', revision: getNode(b.id).revision });
      db.close(); db = new BoardDatabase(databasePath);
      expect(getNode(a.id).body).toBe('');
      expect(getNode(b.id).body).toBe('写下一句话…');
      expect(getNode(a.id).title).toBe('旧标题 A');
    } finally {
      db?.close(); db = undefined;
      for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
      fs.rmdirSync(directory);
    }
  });
  it('adds compatible nullable columns without rewriting geometry and persists new fields after restart', () => {
    const tempRoot = path.resolve('.tmp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(tempRoot, 'v06-persistence-'));
    const databasePath = path.join(directory, 'board.sqlite');
    try {
      db = new BoardDatabase(databasePath);
      const a = db.createNote(noteInput('a')); const b = db.createNote(noteInput('b'));
      db.close(); db = undefined;
      const old = new DatabaseSync(databasePath);
      old.exec('ALTER TABLE canvas_nodes DROP COLUMN folded_into_node_id; ALTER TABLE local_links DROP COLUMN bend_json; ALTER TABLE operation_journal DROP COLUMN edit_session_id');
      old.close();
      db = new BoardDatabase(databasePath);
      expect(getNode(a.id)).toMatchObject({ x: a.x, y: a.y, width: a.width, height: a.height, foldedIntoNodeId: null });
      const link = db.createLink(a.id, b.id, '');
      db.updateLink(link.id, { revision: link.revision, bend: { along: 0, normal: 0.4 } });
      const preferences = db.getBoard().settings.drawingPreferences;
      const slots = ['#100001', '#100002', '#100003', '#100004', '#100005', '#100006'];
      db.setInteractionSettings({ drawingPreferences: { ...preferences, highlighterColorSlots: slots } });
      db.close(); db = new BoardDatabase(databasePath);
      expect(db.getBoard().links[0]!.bend).toEqual({ along: 0, normal: 0.4 });
      expect(db.getBoard().settings.drawingPreferences.highlighterColorSlots).toEqual(slots);
    } finally {
      db?.close(); db = undefined;
      for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
      fs.rmdirSync(directory);
    }
  });
  it('retries an identical stroke id without new history or revision, but rejects differing content', () => {
    db = new BoardDatabase(':memory:');
    const stroke = { id: 'retry-stroke', tool: 'highlighter' as const, points: [{ x: 2, y: 3, pressure: 0.5 }], color: '#ffff00', size: 12, opacity: 0.3, layer: 'background' as const, zIndex: 1 };
    const first = db.applyInkBatch({ creates: [stroke], updates: [], deletes: [] });
    const retry = db.applyInkBatch({ creates: [stroke], updates: [], deletes: [] });
    expect(retry).toEqual(first);
    expect(() => db!.applyInkBatch({ creates: [{ ...stroke, size: 14 }], updates: [], deletes: [] })).toThrow(/different/);
    db.undo(); expect(db.getBoard().inkStrokes).toEqual([]);
  });
  it('retains blank notes and raw whitespace; coalesces one text session but not unrelated operations', () => {
    db = new BoardDatabase(':memory:');
    const blank = db.createNote(noteInput());
    expect(blank.body).toBe('');
    const one = db.updateNode(blank.id, { body: '  一\n', revision: blank.revision, editSessionId: 'edit-a' });
    const two = db.updateNode(blank.id, { body: '  一\n二  ', revision: one.revision, editSessionId: 'edit-a' });
    expect(two.body).toBe('  一\n二  ');
    db.undo(); expect(getNode(blank.id).body).toBe('');
    db.redo(); expect(getNode(blank.id).body).toBe(two.body);
    db.createNote(noteInput('other'));
    db.updateNode(blank.id, { body: 'new', revision: getNode(blank.id).revision, editSessionId: 'edit-a' });
    db.undo(); expect(getNode(blank.id).body).toBe(two.body);
  });

  it('folds using projected legacy task edges, preserves layouts on import, unfolds broken hosts, and undoes atomically', () => {
    db = new BoardDatabase(':memory:');
    const snapshot = createDemoSnapshot(1);
    db.importSnapshot(snapshot);
    const board = db.getBoard();
    const root = board.nodes.find((node) => node.projectKey === snapshot.projects[0]!.projectKey)!;
    const legacy = board.nodes.find((node) => node.threadKey === snapshot.threads[0]!.threadKey)!;
    const a = db.createNote(noteInput('A')); const b = db.createNote(noteInput('B'));
    db.createLink(legacy.id, a.id, 'legacy');
    db.createLink(root.id, a.id, 'duplicate projected');
    const ab = db.createLink(a.id, b.id, '');
    const foldedA = db.updateNode(a.id, { foldedIntoNodeId: root.id, revision: a.revision });
    db.updateNode(b.id, { foldedIntoNodeId: a.id, revision: b.revision });
    db.importSnapshot({ ...snapshot, generatedAt: new Date(Date.now() + 1000).toISOString() });
    expect(getNode(a.id)).toMatchObject({ foldedIntoNodeId: root.id, x: a.x, y: a.y });
    db.deleteLink(ab.id, ab.revision);
    expect(getNode(b.id).foldedIntoNodeId).toBeNull();
    db.undo(); expect(getNode(b.id).foldedIntoNodeId).toBe(a.id);
    db.setNoteArchived(a.id, true, foldedA.revision);
    expect(getNode(a.id).foldedIntoNodeId).toBeNull();
    expect(getNode(b.id).foldedIntoNodeId).toBeNull();
    db.undo(); expect(getNode(a.id).foldedIntoNodeId).toBe(root.id);
    expect(getNode(b.id).foldedIntoNodeId).toBe(a.id);
    db.createLink(root.id, b.id, 'cycle');
    expect(getNode(a.id).foldedIntoNodeId).toBeNull();
    expect(() => db!.updateNode(b.id, { foldedIntoNodeId: a.id, revision: getNode(b.id).revision })).toThrow(/环形/);
  });

  it('guards link edits and deletion by revision and mutation header, preserves endpoints and supports undo', async () => {
    db = new BoardDatabase(':memory:');
    app = await buildApp({ ...loadConfig({}), databasePath: ':memory:', demoMode: false }, { db });
    const a = db.createNote(noteInput('a')); const b = db.createNote(noteInput('b'));
    const link = db.createLink(a.id, b.id, 'relation');
    const url = `/api/links/${link.id}`;
    expect((await app.inject({ method: 'PATCH', url, payload: { bend: null, revision: 0 } })).statusCode).toBe(403);
    const changed = await app.inject({ method: 'PATCH', url, headers, payload: { bend: { along: 0.1, normal: -0.2 }, revision: 0 } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ sourceNodeId: a.id, targetNodeId: b.id, revision: 1, bend: { along: 0.1, normal: -0.2 } });
    expect((await app.inject({ method: 'DELETE', url, headers, payload: { revision: 0 } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PATCH', url, headers, payload: { revision: 1, bend: { along: 8, normal: 0 } } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url, headers, payload: { revision: 1 } })).statusCode).toBe(204);
    db.undo(); expect(db.getBoard().links[0]!.bend).toEqual({ along: 0.1, normal: -0.2 });
    db.undo(); expect(db.getBoard().links[0]!.bend).toBeNull();
  });

  it('fills six editable colors for old settings and rejects unsafe values', () => {
    db = new BoardDatabase(':memory:');
    const preferences = db.getBoard().settings.drawingPreferences;
    const { highlighterColorSlots: ignored, ...legacy } = preferences;
    expect(drawingPreferencesSchema.parse(legacy).highlighterColorSlots).toHaveLength(6);
    const slots = ['#000001', '#000002', '#000003', '#000004', '#000005', '#000006'];
    db.setInteractionSettings({ drawingPreferences: { ...preferences, highlighterColorSlots: slots } });
    expect(db.getBoard().settings.drawingPreferences.highlighterColorSlots).toEqual(slots);
    expect(drawingPreferencesSchema.safeParse({ ...preferences, highlighterColorSlots: ['url(x)'] }).success).toBe(false);
    expect(ignored).toHaveLength(6);
  });
});
