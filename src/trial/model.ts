import { z } from 'zod';
import { imageInfo, InvalidImageError } from '../shared/imageFormat.js';
import { inkStrokeSchema } from '../shared/schema.js';

export const BOOK_FAIR_ID = 'project:book-fair';
export const MAX_TRIAL_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_TRIAL_IMAGE_PIXELS = 16_000_000;
export const MAX_TRIAL_NOTE_LENGTH = 20_000;
export const MAX_TRIAL_IMAGES_PER_NOTE = 16;

const positionSchema = z.object({ x: z.number().finite(), y: z.number().finite() });
const idSchema = z.string().min(1).max(100);
const noteSchema = z.object({
  id: idSchema,
  position: positionSchema,
  tone: z.enum(['paper', 'green', 'rose']),
  body: z.string().max(MAX_TRIAL_NOTE_LENGTH),
  images: z.array(idSchema).max(MAX_TRIAL_IMAGES_PER_NOTE)
});
const linkSchema = z.object({ id: idSchema, source: idSchema, target: idSchema });
const viewportSchema = positionSchema.extend({ zoom: z.number().finite().min(0.2).max(2.5) });

export const trialBoardSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  projectPosition: positionSchema,
  notes: z.array(noteSchema),
  links: z.array(linkSchema),
  strokes: z.array(inkStrokeSchema.extend({ color: z.string().regex(/^#[\da-f]{6}$/i) })),
  viewport: viewportSchema.nullable()
}).superRefine((board, context) => {
  const nodes = new Set([BOOK_FAIR_ID]);
  const images = new Set<string>();
  for (const note of board.notes) {
    if (nodes.has(note.id)) context.addIssue({ code: 'custom', message: '便签编号重复。' });
    nodes.add(note.id);
    for (const id of note.images) {
      if (images.has(id)) context.addIssue({ code: 'custom', message: '图片编号重复。' });
      images.add(id);
    }
  }
  const links = new Set<string>();
  const endpoints = new Set<string>();
  for (const link of board.links) {
    const pair = JSON.stringify([link.source, link.target].sort());
    if (link.source === link.target || !nodes.has(link.source) || !nodes.has(link.target) || endpoints.has(pair) || links.has(link.id)) {
      context.addIssue({ code: 'custom', message: '连线端点无效或重复。' });
    }
    links.add(link.id);
    endpoints.add(pair);
  }
  if (new Set(board.strokes.map(({ id }) => id)).size !== board.strokes.length) {
    context.addIssue({ code: 'custom', message: '笔迹编号重复。' });
  }
});

export type TrialBoard = z.infer<typeof trialBoardSchema>;
export type TrialNote = z.infer<typeof noteSchema>;
export type TrialPosition = z.infer<typeof positionSchema>;
export type MediaChanges = ReadonlyMap<string, Blob | null>;

export const BOOK_FAIR_SOURCES = [
  {
    title: '导览册怎么折',
    time: '11 月 25 日',
    result: '内页按入口、展位、书单的顺序排，读者一打开就能先找到位置。',
    excerpt: '如果入口图放在第一折，第一次来的读者不必翻到最后。先按「入口 → 展位 → 书单」做一份折页小样。'
  },
  {
    title: '封面纸样的取舍',
    time: '11 月 26 日',
    result: '保留一浅一深两张纸样，等自然光下比完再决定印哪张。',
    excerpt: '先留墨绿和米白两版。明早把它们带到窗边，让一个没看过方案的人找书展名称，再定主封面。'
  }
];

export function seedTrialBoard(): TrialBoard {
  return {
    version: 1, revision: 0, projectPosition: { x: 302, y: 146 }, viewport: null,
    notes: [
      { id: 'sample:paper', position: { x: 0, y: 30 }, tone: 'paper', body: '在窗边比一比两张封面。\n\n记下哪张纸更容易读清书展名字。', images: [] },
      { id: 'sample:fold', position: { x: 601, y: 12 }, tone: 'green', body: '折页顺序\n\n先给读者一张入口图，再翻到展位和书单。', images: [] },
      { id: 'sample:tomorrow', position: { x: 561, y: 318 }, tone: 'rose', body: '明天要带\n\n两张纸样、一把尺，以及上次圈出来的展位图。', images: [] }
    ],
    links: [
      { id: 'sample:link-paper', source: BOOK_FAIR_ID, target: 'sample:paper' },
      { id: 'sample:link-fold', source: BOOK_FAIR_ID, target: 'sample:fold' },
      { id: 'sample:link-tomorrow', source: BOOK_FAIR_ID, target: 'sample:tomorrow' }
    ],
    strokes: []
  };
}

export function connectTrialNodes(board: TrialBoard, id: string, source: string, target: string): TrialBoard {
  const hasNode = (node: string) => node === BOOK_FAIR_ID || board.notes.some((note) => note.id === node);
  if (source === target || !hasNode(source) || !hasNode(target)) return board;
  if (board.links.some((link) => (link.source === source && link.target === target) || (link.source === target && link.target === source))) return board;
  return { ...board, links: [...board.links, { id, source, target }] };
}

export function removeTrialNote(board: TrialBoard, id: string): TrialBoard {
  if (!board.notes.some((note) => note.id === id)) return board;
  return {
    ...board,
    notes: board.notes.filter((note) => note.id !== id),
    links: board.links.filter((link) => link.source !== id && link.target !== id)
  };
}

export interface TrialImageDecoder {
  (blob: Blob): Promise<{ width: number; height: number; close(): void }>;
}

export async function prepareTrialImage(file: Blob, decode: TrialImageDecoder = createImageBitmap): Promise<Blob> {
  if (file.size > MAX_TRIAL_IMAGE_BYTES) throw new InvalidImageError('单张图片不能超过 8 MiB。');
  const bytes = await file.arrayBuffer();
  const info = imageInfo(new Uint8Array(bytes), MAX_TRIAL_IMAGE_BYTES, MAX_TRIAL_IMAGE_PIXELS);
  const blob = new Blob([bytes], { type: info.mime });
  let image: Awaited<ReturnType<TrialImageDecoder>>;
  try { image = await decode(blob); }
  catch { throw new InvalidImageError('这张图片无法解码，请换一张 PNG、JPEG 或 WebP 图片。'); }
  try {
    if (image.width < 1 || image.height < 1 || image.width * image.height > MAX_TRIAL_IMAGE_PIXELS) {
      throw new InvalidImageError('图片尺寸超出试用版的支持范围。');
    }
    return blob;
  } finally { image.close(); }
}

export function pastedImage(data: DataTransfer): File | undefined {
  const files = Array.from(data.files);
  if (files.length) return files[0];
  return Array.from(data.items)
    .find((item) => item.kind === 'file')?.getAsFile() ?? undefined;
}
