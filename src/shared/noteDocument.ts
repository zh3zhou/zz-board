import { z } from 'zod';

export const mediaIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const noteImageSchema = z.object({
  type: z.literal('image'), assetId: mediaIdSchema,
  side: z.enum(['left', 'right']).default('right'), width: z.number().min(15).max(100).default(45),
  // The occurrence stays anchored in the text. Zoom and the current viewport are never persisted.
  placement: z.object({ xPercent: z.number().min(0).max(85), offsetY: z.number().min(0).max(10000) }).strict().optional(),
  wrap: z.literal('none').optional()
}).strict().refine(image => !image.placement || image.placement.xPercent + image.width <= 100.000001, '图片超出便签正文。')
  .refine(image => image.wrap !== 'none' || (image.side === 'left' && image.placement?.offsetY === 0 &&
    Math.abs(image.placement.xPercent - (100 - image.width) / 2) < 0.000001), '独占一行的图片需要居中的位置。');
export const noteDocumentSchema = z.object({
  version: z.literal(1), content: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string().max(20_000) }).strict(), noteImageSchema
  ])).max(2000)
}).strict().superRefine((doc, ctx) => {
  if (documentText(doc).length > 20_000) ctx.addIssue({ code: 'custom', message: '便签文字最多 20000 字符。' });
  if (doc.content.filter(item => item.type === 'image').length > 16) ctx.addIssue({ code: 'custom', message: '每张便签最多 16 张图片。' });
});
export type NoteDocument = z.infer<typeof noteDocumentSchema>;
export type NoteImage = z.infer<typeof noteImageSchema>;
export interface NoteContent { body: string; noteDocument?: NoteDocument | null }
/** One provable content-save time per retained, currently applied journal operation, newest operation first. */
export interface NoteContentHistory { noteId: string; boardRevision: number; retainedEditTimes: string[] }
export function documentText(doc: { content: Array<{ type: string; text?: string }> }): string {
  return doc.content.map(item => item.type === 'text' ? item.text || '' : '').join('');
}
export function textDocument(body: string): NoteDocument { return { version: 1, content: body ? [{ type: 'text', text: body }] : [] }; }
export function sameNoteContent(a: NoteContent, b: NoteContent): boolean {
  return a.body === b.body && JSON.stringify(a.noteDocument ?? null) === JSON.stringify(b.noteDocument ?? null);
}
/** Plain text and its equivalent rich-text serialization have the same visible content. */
export function sameDisplayedContent(a: NoteContent, b: NoteContent): boolean {
  if (a.body !== b.body) return false;
  if (a.noteDocument === b.noteDocument) return true;
  const images = (doc: NoteContent['noteDocument']) => {
    let offset = 0;
    return doc?.content.flatMap(part => {
      if (part.type === 'text') { offset += part.text.length; return []; }
      return [[offset, part.assetId, part.side, part.width, part.placement?.xPercent, part.placement?.offsetY, part.wrap]];
    }) ?? [];
  };
  return JSON.stringify(images(a.noteDocument)) === JSON.stringify(images(b.noteDocument));
}

export function documentAssets(doc: NoteDocument | null | undefined): string[] {
  return [...new Set(doc?.content.flatMap(item => item.type === 'image' ? [item.assetId] : []) || [])];
}
export function validateNoteContent(body: string, doc: NoteDocument | null | undefined): void {
  if (doc && documentText(noteDocumentSchema.parse(doc)) !== body) throw new Error('图文内容与文字不一致，请重新保存。');
}

export interface MediaAsset { id: string; mime: string; width: number; height: number; bytes: number; previewBytes: number }
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
