import { describe, expect, it } from 'vitest';
import { BoardDatabase } from '../../src/server/database.js';
import { defaultPriorityIcons, priorityIconsSchema, type PriorityIcons } from '../../src/shared/priorityIcons.js';

describe('shared board priority icon preferences', () => {
  it('requires stored raster references, retains custom choices across style changes, and supports undo without a note mutation', () => {
    const db = new BoardDatabase(':memory:');
    try {
      const attentionImage = 'a'.repeat(64), highImage = 'b'.repeat(64);
      const custom: PriorityIcons = { style: 'custom', attentionImage, highImage };
      const change = (previous: PriorityIcons, value: PriorityIcons) => db.setSkinSettings({ priorityIcons: { previous, value } });
      const board = db.getBoard();
      expect(board.settings.priorityIcons).toEqual(defaultPriorityIcons);
      expect(priorityIconsSchema.safeParse({ ...custom, highImage: null }).success).toBe(false);
      expect(() => change(defaultPriorityIcons, custom)).toThrow('找不到自定义图标');
      for (const id of [attentionImage, highImage]) db.registerMedia({ id, mime: 'image/png', width: 10, height: 10, bytes: 500, previewBytes: 400 });
      change(defaultPriorityIcons, custom);
      const revision = db.getBoard().boardRevision;
      change(defaultPriorityIcons, custom);
      expect(db.getBoard().boardRevision).toBe(revision);
      const stripes: PriorityIcons = { ...custom, style: 'ginger-cat' };
      expect(() => change(defaultPriorityIcons, stripes)).toThrow('另一处');
      change(custom, stripes);
      expect(db.getBoard().settings.priorityIcons).toEqual(stripes);
      db.undo();
      expect(db.getBoard().settings.priorityIcons).toEqual(custom);
      db.undo();
      expect(db.getBoard().settings.priorityIcons).toEqual(defaultPriorityIcons);
      expect(db.getBoard().nodes).toEqual(board.nodes);
    } finally { db.close(); }
  });
});
