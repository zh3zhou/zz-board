import { describe, expect, it } from 'vitest';
import { BoardDatabase } from '../../src/server/database.js';
import { createDemoSnapshot } from '../../src/shared/demo.js';

const stroke = (id: string) => ({
  id,
  tool: 'pen' as const,
  points: [{ x: 1, y: 2, pressure: 0.4 }, { x: 4, y: 8, pressure: 0.8 }],
  color: '#123456',
  size: 4,
  opacity: 0.9,
  layer: 'background' as const,
  zIndex: 2
});

describe('persistent board history and ink', () => {
  it('keeps undo history across a database restart', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-board-history-'));
    const databasePath = path.join(directory, 'board.sqlite');
    let db: BoardDatabase | undefined;
    try {
      db = new BoardDatabase(databasePath);
      const note = db.createNote({ title: '', body: '重启前', x: 0, y: 0, width: 210, height: 150 });
      db.updateNode(note.id, { body: '等待撤销', revision: note.revision });
      db.close();
      db = new BoardDatabase(databasePath);
      expect(db.getHistoryStatus().undoLabel).toBe('编辑便签');
      db.undo();
      expect(db.getBoard().nodes[0]?.body).toBe('重启前');
    } finally {
      db?.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('stores a gesture as one step and round-trips it through undo and redo', () => {
    const db = new BoardDatabase(':memory:');
    const result = db.applyInkBatch({ creates: [stroke('ink:a'), stroke('ink:b')], updates: [], deletes: [] });
    expect(result.created).toHaveLength(2);
    expect(db.getBoard()).toMatchObject({
      inkStrokes: [{ id: 'ink:a', revision: 0 }, { id: 'ink:b', revision: 0 }],
      historyStatus: { canUndo: true, canRedo: false, undoLabel: '绘制墨迹' }
    });

    db.undo();
    expect(db.getBoard()).toMatchObject({
      inkStrokes: [],
      historyStatus: { canUndo: false, canRedo: true, redoLabel: '绘制墨迹' }
    });
    db.redo();
    expect(db.getBoard().inkStrokes.map((item) => item.id)).toEqual(['ink:a', 'ink:b']);
    db.close();
  });

  it('undoes node edits and active Skin changes while ordinary preferences stay outside history', () => {
    const db = new BoardDatabase(':memory:');
    const initialSkinRef = db.getBoard().settings.activeSkinRef;
    const note = db.createNote({ title: '', body: '原文', x: 0, y: 0, width: 210, height: 150 });
    const moved = db.updateNode(note.id, { x: 42, width: 260, skinRef: 'sample@1/note', revision: note.revision });
    db.setJsonSetting('drawingPreferences', {
      penColor: '#000', penSize: 5, highlighterColor: '#ff0', highlighterSize: 20,
      eraserMode: 'precision', lassoMode: 'all', layer: 'foreground', paletteCollapsed: false
    });
    db.setSkinSettings({ activeSkinRef: 'sample@1/global', components: { note: 'sample@1/note' } });

    expect(db.getBoard().settings.activeSkinRef).toBe('sample@1/global');
    db.undo();
    expect(db.getBoard().settings.activeSkinRef).toBe(initialSkinRef);
    expect(db.getBoard().settings.skinComponents).toEqual({});
    db.undo();
    expect(db.getBoard().nodes.find((item) => item.id === note.id)).toMatchObject({ x: 0, width: 210, skinRef: null });
    expect(moved.revision).toBe(1);
    expect(db.getBoard().settings.drawingPreferences.eraserMode).toBe('precision');
    db.close();
  });

  it('persists aspect locks as an undoable node choice', () => {
    const db = new BoardDatabase(':memory:');
    const note = db.createNote({ title: '', body: '比例', x: 0, y: 0, width: 210, height: 150 });
    expect(note.aspectLocked).toBeNull();
    const locked = db.updateNode(note.id, { aspectLocked: true, revision: note.revision });
    expect(locked.aspectLocked).toBe(true);
    expect(db.getBoard().historyStatus.undoLabel).toBe('锁定气泡比例');
    db.undo();
    expect(db.getBoard().nodes.find((item) => item.id === note.id)?.aspectLocked).toBeNull();
    db.redo();
    expect(db.getBoard().nodes.find((item) => item.id === note.id)?.aspectLocked).toBe(true);
    db.close();
  });

  it('undoes annotations, links and batched priorities in dependency-safe order', () => {
    const db = new BoardDatabase(':memory:');
    const first = db.createNote({ title: '', body: '一', x: 0, y: 0, width: 210, height: 150 });
    const second = db.createNote({ title: '', body: '二', x: 20, y: 20, width: 210, height: 150 });
    db.setNodePriorities([
      { id: first.id, revision: first.revision, manualPriority: 'p1' },
      { id: second.id, revision: second.revision, manualPriority: 'p2' }
    ]);
    db.createAnnotation(first.id, '保留在本地的批注');
    db.createLink(first.id, second.id, '关联');
    expect(db.getBoard()).toMatchObject({ annotations: [{ targetNodeId: first.id }], links: [{ sourceNodeId: first.id, targetNodeId: second.id }] });
    db.undo();
    expect(db.getBoard().links).toEqual([]);
    db.undo();
    expect(db.getBoard().annotations).toEqual([]);
    db.undo();
    expect(db.getBoard().nodes.map((item) => item.manualPriority)).toEqual([null, null]);
    db.close();
  });

  it('clears redo after a new operation and never crosses a snapshot barrier', () => {
    const db = new BoardDatabase(':memory:');
    const note = db.createNote({ title: '', body: '先创建', x: 0, y: 0, width: 210, height: 150 });
    db.updateNode(note.id, { body: '已编辑', revision: note.revision });
    db.undo();
    expect(db.getHistoryStatus().canRedo).toBe(true);
    const current = db.getBoard().nodes.find((item) => item.id === note.id)!;
    db.updateNode(note.id, { x: 12, revision: current.revision });
    expect(db.getHistoryStatus().canRedo).toBe(false);

    db.importSnapshot(createDemoSnapshot(1));
    expect(db.getHistoryStatus()).toEqual({ canUndo: false, canRedo: false, undoLabel: null, redoLabel: null });
    db.close();
  });

  it('makes permanent note deletion non-undoable and purges only that note history', () => {
    const db = new BoardDatabase(':memory:');
    const kept = db.createNote({ title: '', body: '保留', x: 0, y: 0, width: 210, height: 150 });
    const removed = db.createNote({ title: '', body: '删除', x: 30, y: 30, width: 210, height: 150 });
    const archived = db.setNoteArchived(removed.id, true, removed.revision);
    db.deleteNote(removed.id, archived.revision);
    expect(db.getBoard().nodes.map((item) => item.id)).toEqual([kept.id]);
    db.undo();
    expect(db.getBoard().nodes).toHaveLength(0);
    expect(db.getBoard().nodes.some((item) => item.id === removed.id)).toBe(false);
    db.close();
  });

  it('retains at most the latest 200 operations', () => {
    const db = new BoardDatabase(':memory:');
    let note = db.createNote({ title: '', body: '0', x: 0, y: 0, width: 210, height: 150 });
    for (let index = 1; index <= 205; index += 1) {
      note = db.updateNode(note.id, { body: String(index), revision: note.revision });
    }
    let undone = 0;
    while (db.getHistoryStatus().canUndo) {
      db.undo();
      undone += 1;
    }
    expect(undone).toBe(200);
    expect(db.getBoard().nodes[0]?.body).toBe('5');
    db.close();
  });
});
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
