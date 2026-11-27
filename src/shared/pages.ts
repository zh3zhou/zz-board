import { z } from 'zod';
import { wallpaperSchema } from './wallpaper.js';
import type { BoardState } from './schema.js';

export const DEFAULT_PAGE_ID = 'page:default';
export const INITIAL_PAGE_NAME = 'page 1';
export const pageViewportSchema = z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().min(.1).max(4) }).strict();
export const canvasPageSchema = z.object({
  id: z.string().min(1).max(100), name: z.string().trim().min(1).max(100), sortOrder: z.number().int().nonnegative(),
  viewport: pageViewportSchema, backgroundSkinRef: z.string().min(1).max(300).nullable(),
  wallpaper: wallpaperSchema.nullable().optional(),
  archivedAt: z.string().nullable(), autoCheckPaused: z.boolean(), revision: z.number().int().nonnegative(),
  createdAt: z.string(), updatedAt: z.string()
}).strict();
export type CanvasPageRecord = z.infer<typeof canvasPageSchema>;
export const createPageInputSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();
export const updatePageInputSchema = z.object({
  revision: z.number().int().nonnegative(), name: z.string().trim().min(1).max(100).optional(),
  backgroundSkinRef: z.string().min(1).max(300).nullable().optional(), wallpaper: wallpaperSchema.nullable().optional(), autoCheckPaused: z.boolean().optional()
}).strict();
export const archivePageInputSchema = z.object({ archived: z.boolean(), revision: z.number().int().nonnegative(), replacementDefaultPageId: z.string().min(1).max(100).optional() }).strict();
export function pageId(record: { pageId?: string }): string { return record.pageId || DEFAULT_PAGE_ID; }
export function boardPages(board: Pick<BoardState, 'pages' | 'viewport'>): CanvasPageRecord[] {
  const pages = board.pages;
  // Older clients cached the former factory name. Only translate a never-edited initial page.
  return pages?.length ? pages.map(page => page.id === DEFAULT_PAGE_ID && page.name === '默认页' && page.revision === 0
    ? { ...page, name: INITIAL_PAGE_NAME } : page) : [{ id: DEFAULT_PAGE_ID, name: INITIAL_PAGE_NAME, sortOrder: 0,
    viewport: board.viewport, backgroundSkinRef: null, archivedAt: null, autoCheckPaused: false,
    revision: 0, createdAt: '', updatedAt: '' }];
}
