import type { CSSProperties } from 'react';
import type { NoteImage } from '../shared/noteDocument.js';

export type ImageLayout = Pick<NoteImage, 'side' | 'width' | 'placement' | 'wrap'>;
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function centeredImage(width = 60): ImageLayout {
  return { side: 'left', width, placement: { xPercent: (100 - width) / 2, offsetY: 0 }, wrap: 'none' };
}

export function resizedImage(layout: ImageLayout, requestedWidth: number): ImageLayout {
  if (layout.wrap === 'none') return centeredImage(clamp(requestedWidth, 15, 100));
  return { side: layout.side, placement: layout.placement, width: clamp(requestedWidth, 15, 100 - (layout.placement?.xPercent ?? 0)) };
}

export function placedImage(width: number, xPercent: number, offsetY: number): ImageLayout {
  const x = clamp(Math.round(xPercent * 100) / 100, 0, 100 - width);
  return { width, side: x + width / 2 <= 50 ? 'left' : 'right', placement: { xPercent: x, offsetY: clamp(Math.round(offsetY), 0, 10000) } };
}

/** The image floats from the nearer edge. Text above the vertical inset and on the open side stays readable. */
export function imageLayoutStyle({ side, width, placement, wrap }: ImageLayout): CSSProperties {
  if (wrap === 'none') return { float: 'none', clear: 'both', display: 'block', width: `${width}%`, marginTop: 0, marginLeft: 'auto', marginRight: 'auto' };
  const style: CSSProperties = { float: side, clear: side, width: `${width}%` };
  if (!placement) return style;
  const remaining = Math.max(0, 100 - width - placement.xPercent);
  const gap = (space: number) => `min(6px, ${space}%)`;
  return { ...style, marginTop: `${placement.offsetY}px`,
    marginLeft: side === 'left' ? `${placement.xPercent}%` : gap(placement.xPercent),
    marginRight: side === 'right' ? `${remaining}%` : gap(remaining),
    shapeOutside: `inset(${placement.offsetY}px 0 0 0) margin-box` };
}
