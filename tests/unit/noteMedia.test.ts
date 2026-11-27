import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BoardDatabase } from '../../src/server/database.js';
import { NoteAutosave } from '../../src/web/noteAutosave.js';
import { documentText, noteDocumentSchema, sameDisplayedContent, sameNoteContent, textDocument, type NoteDocument } from '../../src/shared/noteDocument.js';
import { exportDimensions, exportTiles, rectIntersects } from '../../src/web/exportGeometry.js';
import { createDemoSnapshot } from '../../src/shared/demo.js';
import { toEditor, fromEditor } from '../../src/web/NoteRichEditor.js';
import { centeredImage, imageLayoutStyle, placedImage, resizedImage } from '../../src/web/noteImageLayout.js';
import { relocateImage } from '../../src/web/noteImageNodeView.js';
import { NoteDocumentView } from '../../src/web/NoteDocumentView.js';
import { ExpandedNoteContent } from '../../src/web/noteClipboard.js';
import { EditorState } from 'prosemirror-state';
import { history, undo } from 'prosemirror-history';

const id = 'a'.repeat(64);
const image = { type: 'image' as const, assetId: id, side: 'right' as const, width: 45 };
const body = '中文  连续空格\n\n第二行\n  ';
const doc: NoteDocument = { version: 1, content: [{ type: 'text', text: body }, image] };
const dbs: BoardDatabase[] = [];
const savers: NoteAutosave[] = [];
function database() { const db = new BoardDatabase(':memory:'); dbs.push(db); db.registerMedia({ id, mime: 'image/png', width: 4, height: 2, bytes: 70, previewBytes: 70 }); return db; }
function create(db: BoardDatabase) { return db.createNote({ body, title: '', x: 0, y: 0, width: 220, height: 150 }); }
function getNode(db: BoardDatabase, id: string) { return db.getBoard().nodes.find(n => n.id === id)!; }
function saver(db: BoardDatabase) {
  const update = vi.fn(async (id: string, patch: Record<string, unknown>) => db.updateNode(id, patch as { revision: number }));
  const value = new NoteAutosave({ create: async input => db.createNote(input), update, online: () => true, persist: async () => {}, changed() {}, accepted() {}, storageError() {} }); savers.push(value); return { value, update };
}
afterEach(() => { for (const s of savers.splice(0)) for (const id of s.entries.keys()) s.discard(id); dbs.splice(0).forEach(db => db.close()); });
describe('V0.8 restricted note document', () => {
  it('round-trips literal text, cursor-anchored images and editor-local undo', () => {
    const content = { version: 1 as const, content: [{ type: 'text' as const, text: '中  文\n\n' }, image, { type: 'text' as const, text: '\n <b>不是HTML</b>  ' }] };
    expect(fromEditor(toEditor(content))).toEqual(content);
    let state = EditorState.create({ doc: toEditor(content), plugins: [history()] });
    state = state.apply(state.tr.insertText('你好', 1));
    expect(documentText(fromEditor(state.doc))).toBe('你好' + documentText(content));
    undo(state, tr => { state = state.apply(tr); }); expect(fromEditor(state.doc)).toEqual(content);
  });
  it('moves just one repeated image to another text anchor with an undoable, zoom-independent placement', () => {
    const text = (text: string) => ({ type: 'text' as const, text });
    const before: NoteDocument = { version: 1, content: [text('甲'), image, text('乙丙'), {...image,...centeredImage()}, text('丁')] };
    let state = EditorState.create({ doc: toEditor(before), plugins: [history()] });
    const layout = placedImage(30, 54.132, 29.8);
    const transaction = relocateImage(state, 5, 1, layout);
    state = state.apply(transaction!);
    const after = fromEditor(state.doc);
    expect(after.content).toEqual([{ ...image, ...layout }, text('甲'), image, text('乙丙丁')]);
    expect(layout).toEqual({ width: 30, side: 'right', placement: { xPercent: 54.13, offsetY: 30 } });
    expect(fromEditor(toEditor(after))).toEqual(after);
    expect(imageLayoutStyle(layout)).toMatchObject({ float: 'right', width: '30%', marginTop: '30px', shapeOutside: 'inset(30px 0 0 0) margin-box' });
    expect(placedImage(40, 98, -5).placement).toEqual({ xPercent: 60, offsetY: 0 });
    expect(noteDocumentSchema.safeParse({ version: 1, content: [{ ...image, placement: { xPercent: 84, offsetY: 0 } }] }).success).toBe(false);
    expect(sameDisplayedContent({ body: '甲乙丙丁', noteDocument: after }, { body: '甲乙丙丁', noteDocument: { ...after, content: [{ ...image, ...placedImage(30, 48, 30) }, ...after.content.slice(1)] } })).toBe(false);
    undo(state, tr => { state = state.apply(tr); }); expect(fromEditor(state.doc)).toEqual(before);
  });
  it('keeps centered rows and free floats distinct at the same coordinates, including after resizing', () => {
    const centered = centeredImage();
    expect(centered).toEqual({ side:'left', width:60, placement:{xPercent:20,offsetY:0}, wrap:'none' });
    expect(imageLayoutStyle(centered)).toMatchObject({ display:'block', float:'none', clear:'both', width:'60%', marginLeft:'auto', marginRight:'auto' });
    const wider = resizedImage(centered, 86);
    expect(wider).toEqual({side:'left',width:86,placement:{xPercent:7,offsetY:0},wrap:'none'});
    expect(resizedImage(centered, 102)).toEqual(centeredImage(100));
    const free = placedImage(60,20,0);
    expect(imageLayoutStyle(free).float).toBe('left');
    expect(resizedImage(free, 102)).toMatchObject({width:80,placement:{xPercent:20,offsetY:0}});
    expect(noteDocumentSchema.safeParse({version:1,content:[{...image,...wider}]}).success).toBe(true);
    expect(noteDocumentSchema.safeParse({version:1,content:[{...image,...centered,placement:{xPercent:19,offsetY:0}}]}).success).toBe(false);
  });
  it('renders the same full-row layout and text anchor in the canvas and whole-note PNG source', () => {
    const noteDocument: NoteDocument = {version:1,content:[{type:'text',text:'甲'},{...image,...centeredImage()},{type:'text',text:'乙'}]};
    const note = {title:'',body:'甲乙',noteDocument,notePresentation:'note' as const};
    for (const html of [renderToStaticMarkup(createElement(NoteDocumentView, {body:note.body, document:noteDocument})),
      renderToStaticMarkup(createElement(ExpandedNoteContent,{note}))]) {
      expect(html).toMatch(/甲<span[^>]+class="note-image"[^>]+float:none[^>]+clear:both[^>]+width:60%[^>]*>.*?<\/span>乙/u);
    }
    expect(renderToStaticMarkup(createElement(ExpandedNoteContent,{note:{...note,notePresentation:'image',noteDocument:{version:1,content:[image]}}}))).not.toContain('class="note-image"');
  });
  it('preserves every legacy character and never interprets markup', () => {
    expect(documentText(textDocument(body))).toBe(body);
    expect(documentText(textDocument('<img src="https://bad"> & 中文'))).toBe('<img src="https://bad"> & 中文');
    const db = database(); const note = create(db);
    expect(note.noteDocument).toBeNull(); expect(note.body).toBe(body);
    db.updateNode(note.id, { noteDocument: doc, revision: note.revision });
    db.undo(); expect(getNode(db, note.id).noteDocument).toBeNull(); expect(getNode(db, note.id).body).toBe(body);
    db.redo(); expect(getNode(db, note.id).noteDocument).toEqual(doc);
  });
  it('rejects executable/remote data, over-limit content, and inconsistent compatibility text', () => {
    expect(noteDocumentSchema.safeParse({ ...doc, content: [{ ...image, src: 'https://evil' }] }).success).toBe(false);
    expect(noteDocumentSchema.safeParse({ ...doc, content: Array(17).fill(image) }).success).toBe(false);
    expect(noteDocumentSchema.safeParse(textDocument('a'.repeat(20001))).success).toBe(false);
    const db = database(), note = create(db);
    expect(() => db.updateNode(note.id, { body: 'different', noteDocument: doc, revision: note.revision })).toThrow(/不一致/);
    expect(() => db.updateNode(note.id, { noteDocument: { ...doc, content: [{ ...image, assetId: 'b'.repeat(64) }] }, body: '', revision: note.revision })).toThrow(/图片尚未保存/);
  });
  it('keeps image cards in existing links, archive, undo and snapshot preservation', () => {
    const db = database(); const card = db.createNote({ title: '', body: '', x: 5, y: 10, width: 200, height: 100, notePresentation: 'image', noteDocument: { version: 1, content: [image] } });
    const note = create(db); const link = db.createLink(card.id, note.id, '');
    expect(card.aspectLocked).toBe(true);
    const archived = db.setNoteArchived(card.id, true, card.revision);
    expect(db.getBoard().links.map(l => l.id)).toContain(link.id);
    db.undo(); expect(getNode(db, card.id).archivedAt).toBeNull();
    expect(getNode(db, card.id).noteDocument).toEqual(card.noteDocument);
    db.importSnapshot(createDemoSnapshot(1));
    expect(getNode(db, card.id)).toMatchObject({ notePresentation: 'image', noteDocument: card.noteDocument, x: 5, y: 10 });
    expect(archived.archivedAt).toBeTruthy();
  });
  it('saves image-only changes and does not accept same text with different images as acknowledgement', async () => {
    const db = database(), note = create(db), { value, update } = saver(db);
    value.edit(note, body, undefined, doc); expect(await value.flush(note.id)).toBe(true);
    const next = { ...doc, content: [{ type: 'text' as const, text: body }, { ...image, side: 'left' as const, width: 62, placement: {xPercent: 10, offsetY: 8} }] };
    const current = getNode(db, note.id); value.edit(current, body, undefined, next);
    update.mockRejectedValueOnce({ status: 409, current: { ...current, revision: current.revision + 1, noteDocument: { ...doc, content: [{ type: 'text', text: body }, { ...next.content[1], placement: {xPercent: 10, offsetY: 18} }] } } });
    expect(await value.flush(note.id)).toBe(false); expect(value.dirty(note.id)).toBe(true);
    expect(sameNoteContent({ body, noteDocument: next }, { body, noteDocument: doc })).toBe(false);
  });
  it('preserves an explicit cleared document in recovery and subsequent edits', async () => {
    const db = database(), legacy = create(db); const note = db.updateNode(legacy.id, { noteDocument: doc, revision: legacy.revision });
    const { value } = saver(db);
    value.restore([{ record: note, body, noteDocument: null, sessionId: 'clear', sequence: 1, savedSequence: 0, status: 'pending' }]);
    value.edit(note, body + '新字'); expect(value.entries.get(note.id)?.noteDocument).toBeNull();
    expect(await value.flush(note.id)).toBe(true); expect(getNode(db, note.id).noteDocument).toBeNull();
  });
});
describe('bounded world-coordinate export', () => {
  it('calculates exact pixels independent of viewport scale and tiles without gaps', () => {
    const region = { x: -1000, y: 700, width: 2100.5, height: 802.5 };
    expect(exportDimensions(region, 2)).toEqual({ width: 4201, height: 1605 });
    const tiles = exportTiles(region, 2);
    expect(tiles).toHaveLength(3); expect(tiles[2].pixelX).toBe(4096);
    expect(tiles.reduce((sum, t) => sum + t.pixelWidth * t.pixelHeight, 0)).toBe(4201 * 1605);
    expect(tiles[2].x).toBe(1048);
  });
  it('refuses silent downscaling and accepts crossing-boundary objects', () => {
    expect(() => exportDimensions({ x: 0, y: 0, width: 5000, height: 2000 }, 2)).toThrow(/8192/);
    expect(() => exportDimensions({ x: 0, y: 0, width: 4000, height: 3000 }, 2)).toThrow(/3200/);
    expect(rectIntersects({ x: -30, y: -30, width: 50, height: 50 }, { x: 0, y: 0, width: 10, height: 10 })).toBe(true);
  });
});
