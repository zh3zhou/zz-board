import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { BoardDatabase } from '../../src/server/database.js';
import { createDemoSnapshot } from '../../src/shared/demo.js';
import { DEFAULT_PAGE_ID } from '../../src/shared/pages.js';
import { createNoteInputSchema } from '../../src/shared/schema.js';
import { buildApp } from '../../src/server/app.js';
import { loadConfig } from '../../src/server/config.js';

let db: BoardDatabase;
const roots: string[] = [];
afterEach(async () => { db?.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const note = (body: string, pageId = DEFAULT_PAGE_ID) => db.createNote(createNoteInputSchema.parse({ body, pageId, x: 40, y: 60 }));
const node = (id: string) => db.getBoard().nodes.find(item => item.id === id)!;
const refs = (...ids: string[]) => ids.map(id => ({ id, revision: node(id).revision }));

describe('page storage and atomic canvas operations', () => {
  it('keeps the default canvas, source identity and folded descendants through move and reimport', () => {
    db = new BoardDatabase(':memory:'); db.importSnapshot(createDemoSnapshot());
    const project = db.getBoard().nodes.find(item => item.projectKey)!;
    const child = note('明确收纳'), linked = note('只有连线');
    const link = db.createLink(project.id, child.id, ''); db.createLink(project.id, linked.id, '');
    db.updateNode(child.id, { foldedIntoNodeId: project.id, revision: child.revision });
    const target = db.createPage('研究页');
    db.applySelectionAction({ action: 'movePage', nodes: refs(project.id), ink: [], targetPageId: target.id, delta: { x: 300, y: 100 } });
    expect(node(project.id).pageId).toBe(target.id); expect(node(child.id).pageId).toBe(target.id);
    expect(node(child.id)).toMatchObject({ foldedIntoNodeId: project.id, body: child.body, x: 340, y: 160 });
    expect(node(linked.id).pageId).toBe(DEFAULT_PAGE_ID); expect(db.getBoard().links).toContainEqual(link);
    expect(db.undo().focusPageId).toBe(DEFAULT_PAGE_ID); expect(node(child.id).pageId).toBe(DEFAULT_PAGE_ID);
    expect(db.redo().focusPageId).toBe(target.id); expect(node(child.id).pageId).toBe(target.id);
    db.importSnapshot(createDemoSnapshot());
    expect(node(project.id).pageId).toBe(target.id);
    expect(db.getBoard().nodes.filter(item => item.projectKey === project.projectKey)).toHaveLength(1);
  });

  it('sends newly discovered project bubbles only to the fixed intake page', () => {
    db = new BoardDatabase(':memory:');
    const intake = db.createPage('项目入口'); db.setDefaultPage(intake.id);
    const editing = db.createPage('私人笔记'); db.setActivePage(editing.id);
    db.importSnapshot(createDemoSnapshot());
    expect(db.getBoard().nodes.filter(item => item.kind === 'task').every(item => item.pageId === intake.id)).toBe(true);
  });

  it('folds and expands an eligible project tree once without rewriting positions', () => {
    db = new BoardDatabase(':memory:'); db.importSnapshot(createDemoSnapshot());
    const project = db.getBoard().nodes.find(item => item.projectKey)!;
    const a = note('A'), b = note('B');
    db.createLink(project.id, a.id, ''); db.createLink(a.id, b.id, '');
    db.foldAll(project.id, true, project.revision);
    expect(node(a.id).foldedIntoNodeId).toBe(project.id); expect(node(b.id).foldedIntoNodeId).toBe(a.id);
    db.undo(); expect(node(a.id).foldedIntoNodeId).toBeNull(); expect(node(b.id).foldedIntoNodeId).toBeNull();
    db.redo(); db.foldAll(project.id, false, project.revision);
    expect(node(a.id)).toMatchObject({ foldedIntoNodeId: null, x: a.x, y: a.y });
    expect(node(b.id)).toMatchObject({ foldedIntoNodeId: null, x: b.x, y: b.y });
  });

  it('guards every canvas mutation on archived pages and restores with automatic checks paused', () => {
    db = new BoardDatabase(':memory:');
    const page = db.createPage('可归档'); const a = note('A', page.id), b = note('B', page.id);
    const link = db.createLink(a.id, b.id, '');
    const stroke = db.applyInkBatch({ creates: [{ pageId: page.id, tool: 'pen', points: [{ x: 1, y: 2, pressure: .5 }], color: '#333333', size: 2, opacity: 1, layer: 'foreground', zIndex: 0 }], updates: [], deletes: [] }).created[0]!;
    const archived = db.archivePage(page.id, { archived: true, revision: page.revision });
    expect(() => note('late', page.id)).toThrow(/归档/);
    expect(() => db.updateNode(a.id, { body: '错误改写', revision: a.revision })).toThrow(/归档/);
    expect(() => db.updateNodes({ updates: [{ id: a.id, patch: { x: 9, revision: a.revision } }] })).toThrow(/归档/);
    expect(() => db.setNodePriorities([{ id: a.id, revision: a.revision, manualPriority: 'p1' }])).toThrow(/归档/);
    expect(() => db.createAnnotation(a.id, 'later')).toThrow(/归档/);
    expect(() => db.deleteLink(link.id, link.revision)).toThrow(/归档/);
    expect(() => db.applyInkBatch({ creates: [], updates: [], deletes: [{ id: stroke.id, revision: stroke.revision }] })).toThrow(/归档/);
    expect(() => db.setNoteArchived(a.id, true, a.revision)).toThrow(/归档/);
    const restored = db.archivePage(page.id, { archived: false, revision: archived.revision });
    expect(restored.autoCheckPaused).toBe(true);
    expect(db.updatePage(page.id, { revision: restored.revision, autoCheckPaused: false }).autoCheckPaused).toBe(false);
  });

  it('requires an active intake replacement and preserves at least one activity page', () => {
    db = new BoardDatabase(':memory:');
    expect(() => db.archivePage(DEFAULT_PAGE_ID, { archived: true, revision: 0 })).toThrow(/至少/);
    const replacement = db.createPage('接收页');
    expect(() => db.archivePage(DEFAULT_PAGE_ID, { archived: true, revision: 0 })).toThrow(/接收/);
    db.archivePage(DEFAULT_PAGE_ID, { archived: true, revision: 0, replacementDefaultPageId: replacement.id });
    expect(db.getBoard().settings.defaultPageId).toBe(replacement.id);
    expect(db.undo().focusPageId).toBe(DEFAULT_PAGE_ID);
    expect(db.getPage(DEFAULT_PAGE_ID)).toMatchObject({ archivedAt: null, autoCheckPaused: true });
  });

  it('never deletes hidden or note-archived content as an empty page', () => {
    db = new BoardDatabase(':memory:');
    const page = db.createPage('非空'); const a = note('历史', page.id); db.setNoteArchived(a.id, true, a.revision);
    expect(() => db.deletePage(page.id, page.revision)).toThrow(/内容/);
    const empty = db.createPage('可删除'); db.deletePage(empty.id, empty.revision);
    expect(db.getBoard().pages!.some(item => item.id === empty.id)).toBe(false);
    db.undo(); expect(db.getPage(empty.id).name).toBe('可删除');
  });

  it('rolls a stale final selection back and rejects raw page patches', () => {
    db = new BoardDatabase(':memory:');
    const a = note('A'), b = note('B'), target = db.createPage('目标');
    const before = db.getBoard();
    expect(() => db.applySelectionAction({ action: 'movePage', nodes: [{ id: a.id, revision: 0 }, { id: b.id, revision: 99 }], ink: [], targetPageId: target.id })).toThrow();
    expect(db.getBoard()).toEqual(before);
    expect(() => db.updateNode(a.id, { revision: 0, pageId: target.id })).toThrow(/跨页/);
  });

  it('locates the affected page when undo removes a newly created object', () => {
    db = new BoardDatabase(':memory:');
    const page = db.createPage('写作'); const a = note('新内容', page.id);
    db.setActivePage(DEFAULT_PAGE_ID);
    expect(db.undo().focusPageId).toBe(page.id);
    expect(db.getBoard().nodes.some(item => item.id === a.id)).toBe(false);
    expect(db.redo().focusPageId).toBe(page.id);
  });

  it('retains pre-page journal rows and the original viewport through a synthetic old database upgrade', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zz-pages-')); roots.push(root); const file = path.join(root, 'old.sqlite');
    db = new BoardDatabase(file); const a = note('before'); db.updateNode(a.id, { body: 'after', revision: a.revision });
    db.savePageViewport(DEFAULT_PAGE_ID, { x: 13, y: -28, zoom: .6 }); db.close();
    const raw = new DatabaseSync(file);
    for (const row of raw.prepare('SELECT sequence,patch_json FROM operation_journal').all()) {
      const changes = JSON.parse(String(row.patch_json));
      for (const change of changes) for (const key of ['before', 'after']) if (change[key]) delete change[key].page_id;
      raw.prepare('UPDATE operation_journal SET patch_json=? WHERE sequence=?').run(JSON.stringify(changes), row.sequence as number);
    }
    raw.exec("DROP INDEX idx_canvas_nodes_page; DROP INDEX idx_ink_strokes_page; ALTER TABLE canvas_nodes DROP COLUMN page_id; ALTER TABLE ink_strokes DROP COLUMN page_id; DROP TABLE canvas_pages; DELETE FROM settings WHERE key IN ('activePageId','defaultPageId')"); raw.close();
    db = new BoardDatabase(file);
    expect(db.getBoard().viewport).toEqual({ x: 13, y: -28, zoom: .6 });
    db.undo(); expect(node(a.id)).toMatchObject({ body: 'before', pageId: DEFAULT_PAGE_ID });
    db.redo(); expect(node(a.id)).toMatchObject({ body: 'after', pageId: DEFAULT_PAGE_ID });
  });

  it('does not recreate a deleted former default page or retarget a late draft', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zz-pages-')); roots.push(root); const file = path.join(root, 'board.sqlite');
    db = new BoardDatabase(file);
    const intake = db.createPage('新接收'); db.setDefaultPage(intake.id);
    db.deletePage(DEFAULT_PAGE_ID, db.getPage(DEFAULT_PAGE_ID).revision); db.close();
    db = new BoardDatabase(file);
    expect(db.getPages().map(page => page.id)).toEqual([intake.id]);
    expect(() => note('迟到草稿', DEFAULT_PAGE_ID)).toThrow(/找不到/);
    expect(db.getBoard().nodes).toHaveLength(0);
    db.undo(); expect(db.getPage(DEFAULT_PAGE_ID).name).toBe('page 1');
  });

  it('protects page routes with the mutation header and validates installed background components', async () => {
    db = new BoardDatabase(':memory:');
    const app = await buildApp({ ...loadConfig({}), databasePath: ':memory:', demoMode: false }, { db });
    const headers = { 'x-zz-board-mutation': '1' };
    try {
      expect((await app.inject({ method: 'POST', url: '/api/pages', payload: { name: 'bad' } })).statusCode).toBe(403);
      const created = await app.inject({ method: 'POST', url: '/api/pages', headers, payload: { name: '新页' } }); expect(created.statusCode).toBe(201);
      const page = created.json();
      expect((await app.inject({ method: 'PATCH', url: `/api/pages/${page.id}`, headers, payload: { revision: page.revision, backgroundSkinRef: 'ink-constellation@2.0.0#note' } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'POST', url: `/api/pages/${page.id}/viewport`, headers, payload: { x: 1, y: 2, zoom: .5 } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: `/api/pages/${page.id}/archive`, headers, payload: { archived: true, revision: page.revision } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: `/api/pages/${page.id}/viewport`, headers, payload: { x: 90, y: 80, zoom: 2 } })).statusCode).toBe(409);
      expect(db.getPage(page.id).viewport).toEqual({ x: 1, y: 2, zoom: .5 });
    } finally { await app.close(); db = undefined!; }
  });
});
