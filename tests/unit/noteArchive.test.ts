import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { CanvasNodeRecord } from '../../src/shared/schema.js';
import { archivedNotes, shouldArchiveNote } from '../../src/web/noteArchive.js';
import { ArchivePanel } from '../../src/web/ArchivePanel.js';

const note: CanvasNodeRecord = { id: 'note:sample', kind: 'note', threadKey: null, x: 1, y: 2, width: 200, height: 160, zIndex: 10, title: '', body: '只有我的输入', lastViewedAt: null, revision: 0, createdAt: '2026-08-01', updatedAt: '2026-08-01' };
const key = { key: 'Backspace', defaultPrevented: false, repeat: false, isComposing: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };

describe('note archive interaction policy', () => {
  it('archives only a selected saved note on an unmodified Backspace or Delete', () => {
    expect(shouldArchiveNote(key, note, false, false)).toBe(true);
    for (const selected of [null, { ...note, kind: 'task' as const }, { ...note, archivedAt: '2026-08-02' }, { ...note, id: 'draft-note:new' }]) {
      expect(shouldArchiveNote(key, selected, false, false)).toBe(false);
    }
    expect(shouldArchiveNote({ ...key, key: 'Delete' }, note, false, false)).toBe(true);
    expect(shouldArchiveNote({ ...key, key: 'Delete' }, note, true, false)).toBe(false);
  });
  it('does not intercept editing, dialogs, composition, key repeat, or modifier shortcuts', () => {
    expect(shouldArchiveNote(key, note, true, false)).toBe(false);
    expect(shouldArchiveNote(key, note, false, true)).toBe(false);
    for (const flag of ['defaultPrevented', 'repeat', 'isComposing', 'ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
      expect(shouldArchiveNote({ ...key, [flag]: true }, note, false, false)).toBe(false);
    }
  });
  it('keeps only archived notes and orders most recently archived first without mutating input', () => {
    const old = { ...note, id: 'note:old', archivedAt: '2026-08-01' };
    const recent = { ...note, id: 'note:recent', archivedAt: '2026-08-10' };
    const nodes = [old, note, { ...note, kind: 'task' as const, archivedAt: '2026-08-30' }, recent];
    expect(archivedNotes(nodes).map((item) => item.id)).toEqual(['note:recent', 'note:old']);
    expect(nodes[0]).toBe(old);
  });
  it('renders archived input safely with restore and explicit permanent-delete entry', () => {
    const archived = { ...note, body: '<script>not executable</script>', archivedAt: '2026-08-10' };
    const html = renderToStaticMarkup(createElement(ArchivePanel, { relations: [{ note: archived, related: [], linkCount: 0 }], online: true, onClose() {}, async onRestore() {}, async onDelete() {} }));
    expect(html).toContain('恢复到画布');
    expect(html).toContain('永久删除…');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('确认永久删除');
  });
  it('places the empty archive on the current page and explains offline limits', () => {
    const html = renderToStaticMarkup(createElement(ArchivePanel, { relations: [], online: false, onClose() {}, async onRestore() {}, async onDelete() {} }));
    expect(html).toContain('本页还没有归档的便签');
    expect(html).toContain('恢复后会回到原位置');
    expect(html).toContain('重新连接后可以恢复或永久删除便签');
  });
});
