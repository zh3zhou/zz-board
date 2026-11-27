import { z } from 'zod';
import { createNoteInputSchema, type CanvasNodeRecord } from '../shared/schema.js';
import { documentAssets, documentText } from '../shared/noteDocument.js';
import { noteForClipboard } from './editorNavigation.js';

const cardSchema = createNoteInputSchema.pick({ title: true, body: true, noteDocument: true, notePresentation: true, width: true, height: true });
const transferSchema = z.object({ version: z.literal(1), store: z.string().max(64).nullable(), card: cardSchema }).strict();
export type NoteCardContent = z.output<typeof cardSchema>;
const cardMime = 'application/x-zz-board-note';

function boundedCard(note: CanvasNodeRecord): NoteCardContent {
  const scale = note.contentScale || 1;
  return { title: note.title, body: note.body, noteDocument: note.noteDocument, notePresentation: note.notePresentation,
    width: Math.max(96, Math.min(520, note.width / scale)), height: Math.max(72, Math.min(520, note.height / scale)) };
}

/** Text remains pasteable outside the board. The inert HTML marker carries the saved document through Chromium's clipboard. */
export function noteClipboardData(note: CanvasNodeRecord, store?: string) {
  const card = boundedCard(noteForClipboard(note));
  const payload = JSON.stringify({ version: 1, store: store ?? null, card });
  const text = card.body || card.title;
  const html = '<pre data-zz-board-note="' + encodeURIComponent(payload) + '">' +
    text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') + '</pre>';
  return { [cardMime]: payload, 'text/plain': text, 'text/html': html };
}

export async function copyNoteCard(note: CanvasNodeRecord, store?: string) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('当前窗口无法复制图文便签。');
  const data = noteClipboardData(note, store);
  await navigator.clipboard.write([new ClipboardItem({
    'text/plain': new Blob([data['text/plain']], { type: 'text/plain' }),
    'text/html': new Blob([data['text/html']], { type: 'text/html' })
  })]);
}

export function pastedNoteCard(clipboard: Pick<DataTransfer, 'getData'>, store?: string): NoteCardContent | null {
  let payload = clipboard.getData(cardMime);
  if (!payload) {
    const html = clipboard.getData('text/html');
    const marker = /<pre\s+[^>]*?\bdata-zz-board-note="([^"]*)"/i.exec(html)?.[1];
    if (!marker) return null;
    if (marker.length > 1_200_000) throw new Error('复制的便签过大。');
    try { payload = decodeURIComponent(marker); } catch { throw new Error('复制的便签无法识别。'); }
  }
  if (payload.length > 400_000) throw new Error('复制的便签过大。');
  let raw: unknown;
  try { raw = JSON.parse(payload); } catch { throw new Error('复制的便签无法识别。'); }
  const result = transferSchema.safeParse(raw);
  if (!result.success) throw new Error('复制的便签内容或布局无效。');
  const { card, store: source } = result.data;
  if (card.noteDocument && documentText(card.noteDocument) !== card.body) throw new Error('复制的便签图文与原文不一致。');
  if (card.notePresentation === 'image' && (card.body || card.noteDocument?.content.length !== 1 || card.noteDocument.content[0]?.type !== 'image'))
    throw new Error('复制的独立图片便签缺少有效的图片。');
  if (documentAssets(card.noteDocument).length && (!source || source !== store)) throw new Error('图片属于另一份看板或图片库尚未连接，无法还原这张便签。');
  return card;
}
