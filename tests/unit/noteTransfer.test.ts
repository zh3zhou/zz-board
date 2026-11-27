import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canvasNodeSchema } from '../../src/shared/schema.js';
import { completeNoteScale, copyCurrentNoteText, copyNoteImage, ExpandedNoteContent } from '../../src/web/noteClipboard.js';
import { registerNoteClipboardReader } from '../../src/web/editorNavigation.js';
import { noteClipboardData, pastedNoteCard } from '../../src/web/noteTransfer.js';

const id = 'c'.repeat(64), store = 'store-fixture';
const image = { type: 'image', side: 'left', width: 48, assetId: id };
const tail = '正文。\n'.repeat(300) + '最后有 <标签> & 引号"。';
const note = canvasNodeSchema.parse({
  kind: 'note', id: 'note:synthetic', threadKey: null, title: '完整标题', body: '开头 ' + tail,
  noteDocument: { version: 1, content: [{ type: 'text', text: '开头 ' }, image, { type: 'text', text: tail }, image] },
  x: 600, y: 20, width: 340, height: 80, zIndex: 3, revision: 1, lastViewedAt: null, createdAt: '', updatedAt: ''
});
const clipboard = (items: Record<string, string>) => ({ getData: (format: string) => items[format] || '' });
afterEach(() => vi.unstubAllGlobals());

describe('whole-note transfer and expanded PNG', () => {
  it('restores complete content, repeated images and saved positions through both standard HTML and the custom clipboard flavor', () => {
    const formats = noteClipboardData(note, store);
    for (const formatsOnSystem of [formats, { 'text/plain': formats['text/plain'], 'text/html': '<html><body>' + formats['text/html'] + '</body></html>' }]) {
      const result = pastedNoteCard(clipboard(formatsOnSystem), store);
      expect(result).toMatchObject({ title: note.title, body: note.body, noteDocument: note.noteDocument, width: 340, height: 80 });
      expect(result).not.toHaveProperty('id'); expect(result).not.toHaveProperty('x'); expect(result).not.toHaveProperty('noteSource');
    }
    expect(formats['text/plain']).toBe(note.body);
    expect(formats['text/html']).not.toContain('<标签>');
  });
  it('refuses an unresolved media namespace and ignores unrelated external HTML', () => {
    const formats = noteClipboardData(note, store);
    expect(() => pastedNoteCard(clipboard(formats), 'another-board')).toThrow('图片属于另一份看板');
    expect(() => pastedNoteCard(clipboard(noteClipboardData(note)))).toThrow('图片属于另一份看板');
    expect(pastedNoteCard(clipboard({ 'text/html': '<img src="x">', 'text/plain': '普通文字' }))).toBeNull();
    expect(() => pastedNoteCard(clipboard({ 'text/html': '<pre data-zz-board-note="%">' }))).toThrow('无法识别');
    const plain = { ...note, noteDocument: null };
    expect(pastedNoteCard(clipboard(noteClipboardData(plain, store)), 'different')?.body).toBe(note.body);
  });
  it('reads unpublished editor input for whole-card and plain-text copy and reports a pending image before creating a PNG or changing the clipboard', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const pending = registerNoteClipboardReader(note.id, () => { throw new Error('图片仍在添加，请完成后复制。'); });
    const stale = { ...note, body: '旧的正文', noteDocument: null };
    try {
      expect(() => noteClipboardData(stale, store)).toThrow('图片仍在添加');
      await expect(copyCurrentNoteText(stale)).rejects.toThrow('图片仍在添加');
      await expect(copyNoteImage({} as HTMLElement, stale)).rejects.toThrow('图片仍在添加');
      expect(writeText).not.toHaveBeenCalled();
    } finally { pending(); }
    const fresh = registerNoteClipboardReader(note.id, () => ({ body: note.body, noteDocument: note.noteDocument }));
    try {
      expect(pastedNoteCard(clipboard(noteClipboardData(stale, store)), store)).toMatchObject({ body: note.body, noteDocument: note.noteDocument });
      await copyCurrentNoteText(stale);
      expect(writeText).toHaveBeenCalledExactlyOnceWith(note.body);
    } finally { fresh(); }
    expect(noteClipboardData(stale, store)['text/plain']).toBe('旧的正文');
  });
  it('renders the expanded PNG from the complete rich document independently of the visible bubble', () => {
    const html = renderToStaticMarkup(createElement(ExpandedNoteContent, { note }));
    expect(html).toContain(note.title); expect(html).toContain('最后有 &lt;标签&gt;');
    expect(html.split('data-media-id="' + id + '"')).toHaveLength(3);
    expect(html.indexOf('data-media-id')).toBeLessThan(html.indexOf('最后有')); expect(html.lastIndexOf('data-media-id')).toBeGreaterThan(html.indexOf('最后有'));
    const imageOnly = renderToStaticMarkup(createElement(ExpandedNoteContent, { note: { ...note, title: '', body: '', notePresentation: 'image',
      noteDocument: { version: 1, content: [{ type: 'image', assetId: id, side: 'right', width: 100 }] } } }));
    expect(imageOnly).toMatch(/^<img /); expect(imageOnly).toContain(id);
    expect(completeNoteScale(700, 250)).toBe(2); expect(completeNoteScale(700, 7000)).toBe(1);
    expect(() => completeNoteScale(700, 8193)).toThrow('完整便签超出');
  });
});
