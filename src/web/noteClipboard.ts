import { createElement, Fragment } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { CanvasNodeRecord } from '../shared/schema.js';
import { canvasPng, mountRasterSurface, rasterElement, readyForRaster, resolvedSurface } from './rasterExport.js';
import { NoteDocumentView, NoteImageView } from './NoteDocumentView.js';
import { saveAndCopyPng } from './imageExport.js';
import { noteForClipboard } from './editorNavigation.js';

/** Preserve at least one output pixel per reading pixel. Never silently crop the end of a note. */
export function completeNoteScale(width: number, height: number) {
  if (![width, height].every(n => Number.isFinite(n) && n > 0) || width > 8192 || height > 8192 || width * height > 32_000_000)
    throw new Error('完整便签超出单张 PNG 上限（单边 8192 像素、总计 3200 万像素），请拆分便签后保存。');
  return Math.min(2, Math.floor(8192 / width), Math.floor(8192 / height), Math.floor(Math.sqrt(32_000_000 / (width * height))));
}

type ExportNote = Pick<CanvasNodeRecord, 'title' | 'body' | 'noteDocument' | 'notePresentation'>;
export function ExpandedNoteContent({ note }: { note: ExportNote }) {
  const image = note.notePresentation === 'image' && note.noteDocument?.content[0];
  return createElement(Fragment, null,
    note.title && createElement('h2', null, note.title),
    image && image.type === 'image' ? createElement(NoteImageView, { id: image.assetId, original: true }) :
      createElement(NoteDocumentView, { body: note.body, document: note.noteDocument, original: true }));
}

export async function noteImage(surface: HTMLElement, note: ExportNote): Promise<Blob> {
  const width = 700;
  const { surface: shell, remove } = mountRasterSurface(width, 1);
  const paper = resolvedSurface(surface), card = document.createElement('div');
  // A canvas Skin may make the entire bubble translucent. Only its paper belongs below the exported content.
  Object.assign(paper.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', minHeight: '0', maxHeight: 'none',
    boxSizing: 'border-box', margin: '0', padding: '0', zIndex: '0' });
  paper.setAttribute('aria-hidden', 'true');
  card.className = 'expanded-note-export';
  Object.assign(card.style, { display: 'flow-root', boxSizing: 'border-box', width: '100%', height: 'auto', minHeight: '64px', maxHeight: 'none',
    padding: note.notePresentation === 'image' ? '0' : '24px 32px', margin: '0', position: 'relative', zIndex: '1', color: paper.style.color, overflow: 'visible' });
  shell.style.height = 'auto';
  shell.append(paper, card);
  const root = createRoot(card);
  let canvas: HTMLCanvasElement | undefined;
  try {
    flushSync(() => root.render(createElement(ExpandedNoteContent, { note })));
    await readyForRaster(shell, 2, undefined, undefined, 8192);
    // The originals have been decoded and inlined. Measure only after their actual aspect ratios enter layout.
    for (const image of shell.querySelectorAll('img')) image.removeAttribute('data-media-id');
    const height = Math.ceil(card.getBoundingClientRect().height);
    const scale = completeNoteScale(width, height);
    shell.style.height = `${height}px`;
    canvas = await rasterElement(shell, width, height, scale);
    return await canvasPng(canvas);
  } finally {
    if (canvas) canvas.width = canvas.height = 1;
    root.unmount(); remove();
  }
}
export async function copyNoteImage(surface: HTMLElement, note: CanvasNodeRecord) {
  const snapshot = noteForClipboard(note);
  return saveAndCopyPng(() => noteImage(surface, snapshot), 'note');
}
export async function copyCurrentNoteText(note: CanvasNodeRecord) { return copyNoteText(noteForClipboard(note).body); }
export async function copyNoteText(body: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('当前窗口无法写入剪贴板。');
  await navigator.clipboard.writeText(body);
}
