import type { CanvasNodeRecord, InkStrokeRecord } from './schema.js';

export interface SelectionScale { origin: { x: number; y: number }; factor: number }
export const NODE_SCALE_MIN = .125;
export const NODE_SCALE_MAX = 8;

/** One common factor: never clamp individual objects and distort the arrangement. */
export function selectionScaleLimits(nodes: CanvasNodeRecord[], ink: InkStrokeRecord[]) {
  let min = .001, max = 1000;
  for (const node of nodes) {
    const scale = node.contentScale ?? 1;
    min = Math.max(min, NODE_SCALE_MIN / scale, 12 / node.width, 9 / node.height);
    max = Math.min(max, NODE_SCALE_MAX / scale, 4160 / node.width, 4160 / node.height);
  }
  for (const stroke of ink) { min = Math.max(min, .25 / stroke.size); max = Math.min(max, 256 / stroke.size); }
  return { min, max };
}
export function scaledPoint(point: { x: number; y: number }, transform: SelectionScale) {
  return { x: transform.origin.x + (point.x - transform.origin.x) * transform.factor, y: transform.origin.y + (point.y - transform.origin.y) * transform.factor };
}
export function scaledNode(node: CanvasNodeRecord, transform: SelectionScale): CanvasNodeRecord {
  return { ...node, ...scaledPoint(node, transform), width: node.width * transform.factor, height: node.height * transform.factor, contentScale: (node.contentScale ?? 1) * transform.factor };
}
/** Geometry is frozen at pointer-down; autosave overlays remain the content source. */
export function scaledNodePreview(original: CanvasNodeRecord, current: CanvasNodeRecord, transform: SelectionScale): CanvasNodeRecord {
  const { x, y, width, height, contentScale } = scaledNode(original, transform);
  return { ...current, x, y, width, height, contentScale };
}
export function scaledInk(stroke: InkStrokeRecord, transform: SelectionScale): InkStrokeRecord {
  return { ...stroke, size: stroke.size * transform.factor, points: stroke.points.map(p => ({ ...p, ...scaledPoint(p, transform) })) };
}
export function cornerScale(origin: { x: number; y: number }, corner: { x: number; y: number }, pointer: { x: number; y: number }, limits: { min: number; max: number }): SelectionScale {
  const dx = corner.x - origin.x, dy = corner.y - origin.y;
  const factor = ((pointer.x - origin.x) * dx + (pointer.y - origin.y) * dy) / Math.max(1e-9, dx * dx + dy * dy);
  return { origin, factor: Math.max(limits.min, Math.min(limits.max, factor)) };
}
