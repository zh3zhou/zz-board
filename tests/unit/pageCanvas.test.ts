import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardDatabase } from '../../src/server/database.js';
import { createDemoSnapshot } from '../../src/shared/demo.js';
import { createNoteInputSchema } from '../../src/shared/schema.js';
import { DEFAULT_PAGE_ID } from '../../src/shared/pages.js';
import { pageMovePreview, pageRecords, pageSearch } from '../../src/web/pageCanvas.js';
import { overlayQueuedNotes, flushQueuedNotes, type QueuedNote } from '../../src/web/offlineStore.js';
import { NoteAutosave } from '../../src/web/noteAutosave.js';

let db: BoardDatabase;
afterEach(() => { db?.close(); db = undefined!; });
function setup() { db = new BoardDatabase(':memory:'); db.importSnapshot(createDemoSnapshot()); return db.getBoard(); }

describe('page canvas projection and async ownership', () => {
  it('keeps one canonical project after moving it and preserves global search navigation', () => {
    const before = setup(); const project = before.nodes.find(node => node.kind === 'task' && node.projectKey)!;
    const target = db.createPage('研究');
    db.applySelectionAction({ action: 'movePage', targetPageId: target.id, nodes: [{ id: project.id, revision: project.revision }], ink: [] });
    const board = db.getBoard();
    expect(pageRecords(board, DEFAULT_PAGE_ID).some(node => node.id === project.id)).toBe(false);
    expect(pageRecords(board, target.id).filter(node => node.projectKey === project.projectKey)).toHaveLength(1);
    const page = db.getBoard().pages!.find(page => page.id === target.id)!;
    db.archivePage(target.id, { archived: true, revision: page.revision });
    const found = pageSearch(db.getBoard(), project.title).find(item => item.record.id === project.id);
    expect(found?.page?.id).toBe(target.id); expect(found?.page?.archivedAt).toBeTruthy();
  });
  it('locates same-title conversations on their project page and preserves missing and colliding source identities', () => {
    const before = setup();
    const title = '校验印刷稿';
    const source = { ...before.threads[0]!, title, displayTitle: '摘要：试印进展' };
    const project = before.nodes.find(node => node.projectKey === source.projectKey && !node.threadKey)!;
    const target = db.createPage('排版');
    db.applySelectionAction({ action: 'movePage', targetPageId: target.id, nodes: [{ id: project.id, revision: project.revision }], ink: [] });
    const movedPage = db.getBoard().pages!.find(page => page.id === target.id)!;
    db.archivePage(target.id, { archived: true, revision: movedPage.revision });
    const threads = [
      { ...source, hostId: 'studio', threadId: 'alpha-00000042', threadKey: 'studio:alpha-00000042' },
      { ...source, hostId: 'studio', threadId: 'beta-00000042', threadKey: 'studio:beta-00000042', missingSince: source.observedAt },
      { ...source, hostId: 'lab', threadId: 'alpha-00000042', threadKey: 'lab:alpha-00000042' }
    ];
    const board = { ...db.getBoard(), threads };
    const hits = pageSearch(board, title);
    expect(hits.map(hit => hit.thread?.threadKey)).toEqual(threads.map(thread => thread.threadKey));
    expect(hits.map(hit => hit.identity)).toEqual([threads[0]!.threadKey, threads[1]!.threadKey, 'lab · 00000042']);
    expect(hits.every(hit => hit.record.id === project.id && hit.page?.id === target.id && hit.page.archivedAt)).toBe(true);
    expect(hits[1]?.thread?.missingSince).toBeTruthy();
    expect(pageSearch(board, source.displayTitle)).toHaveLength(0);
  });
  it('places an exact standalone conversation ahead of 60 matching notes without duplicating its old canvas node', () => {
    const board = setup();
    const source = { ...board.threads[0]!, projectKey: undefined, title: '回看套色', displayTitle: '旧标题' };
    const node = { ...board.nodes[0]!, id: 'source-node', projectKey: null, threadKey: source.threadKey, title: source.displayTitle };
    const notes = Array.from({ length: 65 }, (_, i) => ({ ...node, id: `note:${i}`, kind: 'note' as const, threadKey: null, title: i % 2 ? source.title : '', body: source.title }));
    const testBoard = { ...board, projects: [], threads: [source], nodes: [...notes, node] };
    const hits = pageSearch(testBoard, source.title);
    expect(hits).toHaveLength(60);
    expect(hits[0]).toMatchObject({ record: { id: node.id }, thread: { threadKey: source.threadKey } });
    expect(hits.filter(hit => hit.record.id === node.id)).toHaveLength(1);
    expect(pageSearch(testBoard, node.title)).toHaveLength(0);
    expect(pageSearch({ ...testBoard, threads: [] }, node.title)[0]?.record.id).toBe(node.id);
  });
  it('previews only explicitly folded descendants and counts external associations', () => {
    const board = setup(); const project = board.nodes.find(node => node.kind === 'task' && node.projectKey)!;
    const child = db.createNote(createNoteInputSchema.parse({ body: 'inside', x: 5, y: 5 }));
    const outside = db.createNote(createNoteInputSchema.parse({ body: 'outside', x: 15, y: 5 }));
    db.createLink(project.id, child.id, ''); db.createLink(project.id, outside.id, '');
    db.updateNode(child.id, { foldedIntoNodeId: project.id, revision: child.revision });
    const preview = pageMovePreview(db.getBoard(), [project.id], []);
    expect(preview.nodes.map(node => node.id)).toEqual(expect.arrayContaining([project.id, child.id]));
    expect(preview.nodes.some(node => node.id === outside.id)).toBe(false);
    expect(preview.externalLinks).toBe(1);
  });
  it('keeps legacy drafts on the old default page and explicit drafts on their originating page', () => {
    setup(); const page = db.createPage('其他页');
    const queued: QueuedNote[] = [undefined, page.id].map((pageId, i) => ({ id: `q${i}`, tempNodeId: `offline-note:q${i}`, createdAt: '', input: { pageId, title: '', body: 'offline', x: 0, y: 0, width: 200, height: 150 } }));
    const overlaid = overlayQueuedNotes(db.getBoard(), queued);
    expect(overlaid.nodes.find(node => node.id === 'offline-note:q0')?.pageId).toBe(DEFAULT_PAGE_ID);
    expect(overlaid.nodes.find(node => node.id === 'offline-note:q1')?.pageId).toBe(page.id);
  });
  it('retains queued content when its originating page no longer exists', async () => {
    const queued: QueuedNote = { id: 'q', tempNodeId: 'offline-note:q', createdAt: '', input: { pageId: 'page:gone', title: '', body: 'keep', x: 0, y: 0, width: 200, height: 150 } };
    const remove = vi.fn(); const send = vi.fn().mockRejectedValue({ status: 404, message: '原页面不存在' });
    const result = await flushQueuedNotes(send, { list: async () => [queued], remove });
    expect(result.remaining).toBe(1); expect(remove).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledWith(queued.input);
  });
  it('lets another page drain while retaining a blocked original-page draft', async () => {
    const blocked: QueuedNote = { id: 'blocked', tempNodeId: 'offline-note:blocked', createdAt: '', input: { pageId: 'page:gone', title: '', body: 'keep', x: 0, y: 0, width: 200, height: 150 } };
    const writable = { ...blocked, id: 'ready', input: { ...blocked.input, pageId: DEFAULT_PAGE_ID } };
    let items = [blocked, writable];
    const send = vi.fn(async (input: any) => { if (input.pageId === 'page:gone') throw { status: 404 }; });
    const result = await flushQueuedNotes(send, { list: async () => items, remove: async id => { items = items.filter(item => item.id !== id); } });
    expect(result.sent).toBe(1); expect(result.remaining).toBe(1); expect(items).toEqual([blocked]);
  });
  it('binds delayed note creation to its saved page and exposes durable-write failure', async () => {
    setup(); const page = db.createPage('写作'); const create = vi.fn(async (input: any) => db.createNote(createNoteInputSchema.parse(input)));
    const saver = new NoteAutosave({ create, update: async () => { throw Error('unexpected'); }, persist: async () => {}, changed() {}, accepted() {}, online: () => true, storageError() {} });
    const record = { ...db.createNote(createNoteInputSchema.parse({ body: '', x: 0, y: 0 })), id: 'local:draft', pageId: page.id };
    saver.edit(record, 'late write', 'request:page-test');
    await saver.finish(record.id);
    expect(create.mock.calls[0][0].pageId).toBe(page.id);
    const failed = new NoteAutosave({ create, update: async () => record, persist: async () => { throw Error('disk failed'); }, changed() {}, accepted() {}, online: () => false, storageError() {} });
    failed.edit(record, 'keep locally');
    await expect(failed.durable()).rejects.toThrow('disk failed');
    saver.discard(record.id); failed.discard(record.id);
  });
});
