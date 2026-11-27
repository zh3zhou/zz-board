import { afterEach, describe, expect, it } from 'vitest';
import { BoardDatabase } from '../../src/server/database.js';
import { buildApp } from '../../src/server/app.js';
import { loadConfig } from '../../src/server/config.js';
import { createDemoSnapshot } from '../../src/shared/demo.js';
import { createNoteInputSchema, selectionActionSchema } from '../../src/shared/schema.js';

let db: BoardDatabase;
afterEach(() => db?.close());
function setup() {
  db = new BoardDatabase(':memory:'); db.importSnapshot(createDemoSnapshot());
  const project = db.getBoard().nodes.find((node) => node.kind === 'task')!;
  const note = db.createNote(createNoteInputSchema.parse({ body: '  本文\n', x: 10, y: 20 }));
  const stroke = db.applyInkBatch({ creates: [{ id: 'ink:selection', tool: 'highlighter', points: [{ x: 1, y: 2, pressure: .25 }, { x: 3, y: 4, pressure: .8 }], color: '#e7c95c', opacity: .3, size: 18, layer: 'background', zIndex: 1 }], updates: [], deletes: [] }).created[0]!;
  const nodes = [project, note].map(({ id, revision }) => ({ id, revision }));
  const ink = [{ id: stroke.id, revision: stroke.revision }];
  return { project, note, stroke, nodes, ink };
}

describe('atomic selection actions', () => {
  it('scales all selected objects as one history entry and preserves local content through sync', () => {
    const { nodes, ink, note, stroke } = setup();
    const before = db.getBoard();
    db.applySelectionAction({ action: 'scale', nodes, ink, origin: { x: 0, y: 0 }, factor: 2 });
    const after = db.getBoard();
    expect(after.nodes.find(n => n.id === note.id)).toMatchObject({ x: 20, y: 40, width: note.width * 2, height: note.height * 2, contentScale: 2, body: note.body });
    expect(after.inkStrokes[0]).toMatchObject({ size: stroke.size * 2, points: stroke.points.map(p => ({ ...p, x: p.x * 2, y: p.y * 2 })) });
    expect(after.historyStatus.undoLabel).toBe('整体缩放选区');
    db.undo(); expect(db.getBoard().nodes).toEqual(before.nodes); expect(db.getBoard().inkStrokes).toEqual(before.inkStrokes);
    db.redo(); expect(db.getBoard().nodes).toEqual(after.nodes);
    db.importSnapshot(createDemoSnapshot()); expect(db.getBoard().nodes.find(n => n.id === note.id)).toEqual(after.nodes.find(n => n.id === note.id));
  });
  it('refuses a partial scale on size limits, stale references, hidden nodes or invalid input', () => {
    const { nodes, ink, note } = setup(); const before = db.getBoard();
    expect(() => db.applySelectionAction({ action: 'scale', nodes, ink, origin: { x: 0, y: 0 }, factor: 9 })).toThrow();
    expect(db.getBoard()).toEqual(before);
    expect(() => db.applySelectionAction({ action: 'scale', nodes, ink: [{ ...ink[0]!, revision: 99 }], origin: { x: 0, y: 0 }, factor: 2 })).toThrow();
    expect(db.getBoard()).toEqual(before);
    expect(selectionActionSchema.safeParse({ action: 'scale', nodes, ink, origin: { x: NaN, y: 0 }, factor: 2 }).success).toBe(false);
    const archived = db.setNoteArchived(note.id, true, note.revision);
    expect(() => db.applySelectionAction({ action: 'scale', nodes: [{ id: archived.id, revision: archived.revision }], ink, origin: { x: 0, y: 0 }, factor: 2 })).toThrow();
  });
  it('moves nodes and ink together and undoes/redoes once with content and pressure intact', () => {
    const { nodes, ink, note, stroke, project } = setup();
    const before = db.getBoard();
    db.applySelectionAction({ action: 'translate', nodes, ink, delta: { x: 70, y: -20 } });
    const moved = db.getBoard();
    expect(moved.nodes.find((n) => n.id === note.id)).toMatchObject({ x: 80, y: 0, body: note.body });
    expect(moved.nodes.find((n) => n.id === project.id)?.x).toBe(project.x + 70);
    expect(moved.inkStrokes[0]?.points).toEqual(stroke.points.map((p) => ({ ...p, x: p.x + 70, y: p.y - 20 })));
    db.undo(); expect(db.getBoard().nodes).toEqual(before.nodes); expect(db.getBoard().inkStrokes).toEqual(before.inkStrokes);
    db.redo(); expect(db.getBoard().nodes).toEqual(moved.nodes); expect(db.getBoard().inkStrokes).toEqual(moved.inkStrokes);
  });
  it('deletes ink, archives notes and protects projects and their real associations', () => {
    const { nodes, ink, note, project } = setup();
    const link = db.createLink(project.id, note.id, ''); const annotation = db.createAnnotation(note.id, '保留批注');
    const before = db.getBoard();
    const result = db.applySelectionAction({ action: 'delete', nodes, ink });
    expect(result).toMatchObject({ archivedNoteIds: [note.id], deletedInkIds: [ink[0]!.id], keptNodeIds: [project.id] });
    expect(db.getBoard().nodes.find((n) => n.id === project.id)).toEqual(project);
    expect(db.getBoard().links).toContainEqual(link); expect(db.getBoard().annotations).toContainEqual(annotation);
    expect(db.getBoard().nodes.find((n) => n.id === note.id)?.archivedAt).toBeTruthy();
    db.undo(); expect(db.getBoard().nodes).toEqual(before.nodes); expect(db.getBoard().inkStrokes).toEqual(before.inkStrokes);
    db.redo(); expect(db.getBoard().inkStrokes).toEqual([]);
  });
  it('rolls back an entire batch on a stale final reference', () => {
    const { nodes, ink } = setup(); const before = db.getBoard();
    expect(() => db.applySelectionAction({ action: 'delete', nodes, ink: [{ ...ink[0]!, revision: 99 }] })).toThrow();
    expect(db.getBoard()).toEqual(before);
  });
  it('unfolds descendants of an archived host and restores their prior fold on undo', () => {
    const { project, note, ink } = setup();
    const child = db.createNote(createNoteInputSchema.parse({ body: '收纳正文', x: 60, y: 70 }));
    db.createLink(project.id, note.id, ''); db.createLink(note.id, child.id, '');
    db.updateNode(child.id, { foldedIntoNodeId: note.id, revision: child.revision });
    const before = db.getBoard();
    db.applySelectionAction({ action: 'delete', nodes: [{ id: note.id, revision: note.revision }], ink });
    expect(db.getBoard().nodes.find((n) => n.id === child.id)).toMatchObject({ foldedIntoNodeId: null, x: 60, y: 70 });
    db.undo(); expect(db.getBoard().nodes).toEqual(before.nodes);
    db.redo(); expect(db.getBoard().nodes.find((n) => n.id === child.id)?.foldedIntoNodeId).toBeNull();
  });
  it('does not journal a protected-project delete or zero translation', () => {
    const { project, nodes, ink } = setup(); const before = db.getBoard();
    db.applySelectionAction({ action: 'delete', nodes: [{ id: project.id, revision: project.revision }], ink: [] });
    db.applySelectionAction({ action: 'translate', nodes, ink, delta: { x: 0, y: 0 } });
    expect(db.getBoard()).toEqual(before);
  });
  it('validates input and preserves the mutation-header boundary', async () => {
    const { nodes, ink } = setup();
    for (const input of [
      { action: 'delete', nodes: [], ink: [] },
      { action: 'delete', nodes: [nodes[0], nodes[0]], ink },
      { action: 'translate', nodes, ink, delta: { x: Infinity, y: 0 } },
      { action: 'delete', nodes, ink, body: 'injected' }
    ]) expect(selectionActionSchema.safeParse(input).success).toBe(false);
    const app = await buildApp({ ...loadConfig({}), databasePath: ':memory:', demoMode: false }, { db });
    try {
      expect((await app.inject({ method: 'POST', url: '/api/selection', payload: { action: 'delete', nodes, ink } })).statusCode).toBe(403);
      const headers = { 'x-zz-board-mutation': '1' };
      expect((await app.inject({ method: 'POST', url: '/api/selection', headers, payload: { action: 'delete', nodes: [{ id: 'missing', revision: 0 }], ink: [] } })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: '/api/selection', headers, payload: { action: 'translate', nodes, ink, delta: { x: 2, y: 3 } } })).statusCode).toBe(200);
    } finally { await app.close(); db = undefined!; }
  });
});
