import { z } from 'zod';
import { mediaIdSchema } from './noteDocument.js';

export const MAX_WALLPAPER_IMAGES = 6;
export const MAX_WALLPAPER_STROKES = 64;
export const MAX_STROKE_POINTS = 4096;
export const MAX_WALLPAPER_POINTS = 16_384;
export const MAX_WALLPAPER_PRESETS = 24;

// Offsets are percentages of the viewport, independent of the board's pan and zoom.
const placementSchema = z.object({
  x: z.number().int().min(-100).max(100), y: z.number().int().min(-100).max(100),
  scale: z.number().int().min(10).max(300)
}).strict();
export const centeredPlacement = { x: 0, y: 0, scale: 100 };
const imageSchema = z.object({
  assetId: mediaIdSchema,
  fit: z.enum(['cover', 'contain', 'tile']),
  opacity: z.number().finite().min(0).max(1), placement: placementSchema.optional()
}).strict();
const coordinate = z.number().int().min(0).max(1000);
const strokeSchema = z.object({
  points: z.array(z.tuple([coordinate, coordinate])).min(1).max(MAX_STROKE_POINTS),
  color: z.string().regex(/^#[0-9a-f]{6}$/i), size: z.number().int().min(1).max(20)
}).strict();
/** The first image retains the original wallpaper format. Later layers paint above it, then the ink. */
export const wallpaperSchema = imageSchema.extend({
  assetId: mediaIdSchema.nullable(), layers: z.array(imageSchema).max(MAX_WALLPAPER_IMAGES - 1).optional(),
  strokes: z.array(strokeSchema).max(MAX_WALLPAPER_STROKES).optional()
}).strict().refine(w => !!w.assetId || (!w.layers?.length && !!w.strokes?.length), '请先选择图片或绘制背景。')
  .refine(w => (w.strokes ?? []).reduce((count, stroke) => count + stroke.points.length, 0) <= MAX_WALLPAPER_POINTS, '背景笔迹点数已满。');
export type WallpaperImage = z.infer<typeof imageSchema>;
export type WallpaperStroke = z.infer<typeof strokeSchema>;
export type Wallpaper = z.infer<typeof wallpaperSchema>;
export const wallpaperPresetId = z.uuid();
export const wallpaperPresetSchema = z.object({
  id: wallpaperPresetId, name: z.string().trim().min(1).max(60), wallpaper: wallpaperSchema
}).strict();
export type WallpaperPreset = z.infer<typeof wallpaperPresetSchema>;
export type WallpaperPresetSummary = Pick<WallpaperPreset, 'id' | 'name'>;
export const changeWallpaperSchema = z.object({
  previous: wallpaperSchema.nullable(),
  value: wallpaperSchema.nullable()
}).strict();
export type ChangeWallpaper = z.infer<typeof changeWallpaperSchema>;

export function wallpaperImages(value: Wallpaper): WallpaperImage[] {
  const { assetId, fit, opacity, placement } = value;
  return [...(assetId ? [{ assetId, fit, opacity, ...(placement ? { placement } : {}) }] : []), ...value.layers ?? []];
}
export function withWallpaperImages(value: Wallpaper, images: WallpaperImage[]): Wallpaper {
  const [first, ...layers] = images;
  return { ...(first ?? { assetId: null, fit: 'cover', opacity: .65 }), ...(layers.length ? { layers } : {}),
    ...(value.strokes?.length ? { strokes: value.strokes } : {}) };
}
export function sameWallpaper(a: Wallpaper | null | undefined, b: Wallpaper | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  const aImages = wallpaperImages(a), bImages = wallpaperImages(b);
  const aStrokes = a.strokes ?? [], bStrokes = b.strokes ?? [];
  return aImages.length === bImages.length && aImages.every((image, i) => {
    const other = bImages[i]!, at = image.placement ?? centeredPlacement, bt = other.placement ?? centeredPlacement;
    return image.assetId === other.assetId && image.opacity === other.opacity && image.fit === other.fit &&
      at.x === bt.x && at.y === bt.y && at.scale === bt.scale;
  }) && aStrokes.length === bStrokes.length && aStrokes.every((stroke, i) => {
    const other = bStrokes[i]!;
    return stroke.color === other.color && stroke.size === other.size && JSON.stringify(stroke.points) === JSON.stringify(other.points);
  });
}

export function visibleWallpaper(global: Wallpaper | null | undefined, page?: { wallpaper?: Wallpaper | null; backgroundSkinRef: string | null }): Wallpaper | null {
  return page?.wallpaper ?? (page?.backgroundSkinRef ? null : global ?? null);
}
