import { describe, expect, it } from 'vitest';
import { BoardDatabase, RevisionConflictError } from '../../src/server/database.js';
import { NoteAutosave } from '../../src/web/noteAutosave.js';

describe('note autosave and board history', () => {
  it('keeps redo after an unchanged editor blur and allows a real edit to replace it', async () => {
    const db = new BoardDatabase(':memory:');
    const saver = new NoteAutosave({
      create: async input => db.createNote(input),
      update: async (id, input) => db.updateNode(id, input as { revision: number }),
      persist: async () => {}, changed() {}, accepted() {}, online: () => true, storageError() {}
    });
    try {
      const note = db.createNote({ title: '', body: '原文', x: 0, y: 0, width: 220, height: 160 });
      db.updateNode(note.id, { body: '第二版', revision: note.revision }); db.undo();
      const restored = db.getBoard().nodes.find(n => n.id === note.id)!;
      const revision = db.getBoard().boardRevision;
      saver.edit(restored, restored.body); await saver.finishEditing(note.id, restored.body);
      expect(db.getBoard().boardRevision).toBe(revision);
      expect(db.getHistoryStatus().canRedo).toBe(true);
      db.redo(); expect(db.getBoard().nodes[0].body).toBe('第二版'); db.undo();
      saver.edit(restored, '第三版'); expect((await saver.flushAll()).every(Boolean)).toBe(true);
      expect(db.getHistoryStatus().canRedo).toBe(false);
      db.undo(); expect(db.getBoard().nodes[0].body).toBe('原文');
    } finally { for (const id of saver.entries.keys()) saver.discard(id); db.close(); }
  });

  it('recovers a committed save with a lost response without adding a second undo step', async () => {
    const db = new BoardDatabase(':memory:'); let loseResponse = true;
    const saver = new NoteAutosave({
      create: async input => db.createNote(input),
      update: async (id, input) => {
        try {
          const updated = db.updateNode(id, input as { revision: number });
          if (loseResponse) { loseResponse = false; throw new TypeError('response lost'); }
          return updated;
        } catch (error) {
          if (error instanceof RevisionConflictError) throw { status: 409, current: error.current };
          throw error;
        }
      },
      persist: async () => {}, changed() {}, accepted() {}, online: () => true, storageError() {}
    });
    try {
      const note = db.createNote({ title: '', body: '原文', x: 0, y: 0, width: 220, height: 160 });
      saver.edit(note, '新内容'); expect(await saver.flush(note.id)).toBe(false);
      const revision = db.getBoard().boardRevision;
      expect((await saver.flushAll()).every(Boolean)).toBe(true);
      expect(db.getBoard().boardRevision).toBe(revision);
      db.undo(); expect(db.getBoard().nodes[0].body).toBe('原文');
      db.redo(); expect(db.getBoard().nodes[0].body).toBe('新内容');
    } finally { for (const id of saver.entries.keys()) saver.discard(id); db.close(); }
  });
});
