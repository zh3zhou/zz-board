import type { SkinShapeKind } from '../shared/skin.js';

export interface NodeRect { x: number; y: number; width: number; height: number; kind: 'task' | 'note'; shape?: SkinShapeKind; cornerRadii?: readonly number[]; contentScale?: number }

export interface LinkBend { along: number; normal: number }
type Point = { x: number; y: number };
export interface FloatingLinkGeometry { path: string; source: Point; target: Point; control1: Point; control2: Point; midpoint: Point; overlapping: boolean; frameScale: number }

export function floatingLinkGeometry(source: NodeRect, target: NodeRect, bend?: LinkBend | null): FloatingLinkGeometry {
  const frameScale = Math.sqrt((source.contentScale ?? 1) * (target.contentScale ?? 1));
  const sourceCenter = center(source);
  const targetCenter = center(target);
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  const distance = Math.hypot(dx, dy);
  const direction = distance > 1e-8 ? { x: dx / distance, y: dy / distance } : { x: 1, y: 0 };
  const facingSource = boundaryPoint(source, direction.x, direction.y);
  const facingTarget = boundaryPoint(target, -direction.x, -direction.y);
  // Test the real contour gap, not overlapping bounding boxes of diagonal circles.
  const gap = (facingTarget.x - facingSource.x) * direction.x + (facingTarget.y - facingSource.y) * direction.y;
  const overlapping = gap <= 1e-6 || distance < 1e-8;
  if (overlapping) {
    // Defaults use one common outward side and a monotone chord. Authored bend
    // parameters remain relative to these same endpoints, including while dragging.
    const n = upwardNormal(direction.x, direction.y);
    const first = boundaryPoint(source, n.x - direction.x * .45, n.y - direction.y * .45);
    const last = boundaryPoint(target, n.x + direction.x * .45, n.y + direction.y * .45);
    return shallowCurve(first, last, Math.max(source.width, source.height, target.width, target.height) * .65, true, frameScale, bend);
  }
  return shallowCurve(facingSource, facingTarget, Math.min(28 * frameScale, Math.hypot(facingTarget.x - facingSource.x, facingTarget.y - facingSource.y) * .1), false, frameScale, bend);
}

function upwardNormal(dx: number, dy: number) {
  const length = Math.max(1e-9, Math.hypot(dx, dy));
  const sign = dx > 0 || dx === 0 && dy < 0 ? -1 : 1;
  return { x: -dy / length * sign, y: dx / length * sign };
}
function shallowCurve(source: Point, target: Point, offset: number, overlapping: boolean, frameScale: number, bend?: LinkBend | null) {
  const dx = target.x - source.x, dy = target.y - source.y, n = upwardNormal(dx, dy);
  return curve(source, target,
    { x: source.x + dx / 3 + n.x * offset, y: source.y + dy / 3 + n.y * offset },
    { x: source.x + dx * 2 / 3 + n.x * offset, y: source.y + dy * 2 / 3 + n.y * offset }, overlapping, frameScale, bend);
}

/** The editable handle is the actual curve midpoint, in an endpoint-relative frame. */
export function linkBendFromPoint(source: Point, target: Point, point: Point, frameScale = 1): LinkBend {
  const { ux, uy, scale } = bendFrame(source, target, frameScale);
  const dx = point.x - (source.x + target.x) / 2;
  const dy = point.y - (source.y + target.y) / 2;
  return { along: clamp((dx * ux + dy * uy) / scale), normal: clamp((-dx * uy + dy * ux) / scale) };
}

function bendFrame(source: Point, target: Point, frameScale: number) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.hypot(dx, dy);
  return { ux: distance > 1e-9 ? dx / distance : 1, uy: distance > 1e-9 ? dy / distance : 0, scale: Math.max(32 * frameScale, distance) };
}
function clamp(value: number) { return Number.isFinite(value) ? Math.max(-4, Math.min(4, value)) : 0; }
function curve(source: Point, target: Point, first: Point, second: Point, overlapping: boolean, frameScale: number, bend?: LinkBend | null): FloatingLinkGeometry {
  let c1 = first;
  let c2 = second;
  if (bend) {
    const { ux, uy, scale } = bendFrame(source, target, frameScale);
    const ox = (ux * clamp(bend.along) - uy * clamp(bend.normal)) * scale / 0.75;
    const oy = (uy * clamp(bend.along) + ux * clamp(bend.normal)) * scale / 0.75;
    c1 = { x: source.x + (target.x - source.x) / 3 + ox, y: source.y + (target.y - source.y) / 3 + oy };
    c2 = { x: source.x + (target.x - source.x) * 2 / 3 + ox, y: source.y + (target.y - source.y) * 2 / 3 + oy };
  }
  return { source, target, control1: c1, control2: c2, overlapping, frameScale,
    midpoint: { x: (source.x + 3 * c1.x + 3 * c2.x + target.x) / 8, y: (source.y + 3 * c1.y + 3 * c2.y + target.y) / 8 },
    path: `M ${source.x} ${source.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${target.x} ${target.y}` };
}

function center(rect: NodeRect) { return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; }

function boundaryPoint(rect: NodeRect, dx: number, dy: number): { x: number; y: number } {
  const c = center(rect);
  const halfWidth = Math.max(1, rect.width / 2);
  const halfHeight = Math.max(1, rect.height / 2);
  const shape = rect.shape || (rect.kind === 'task' ? 'circle' : 'roundedRect');
  if (shape === 'circle' || shape === 'ellipse') {
    const exponent = 2;
    const denominator = (Math.abs(dx / halfWidth) ** exponent + Math.abs(dy / halfHeight) ** exponent) ** (1 / exponent);
    const scale = 1 / Math.max(denominator, Number.EPSILON);
    return { x: c.x + dx * scale, y: c.y + dy * scale };
  }
  return roundedBoundaryPoint(rect, dx, dy, shape === 'softBlob' ? (rect.cornerRadii ?? [42, 58, 52, 48, 50, 44, 56, 50]) : undefined);
}

function roundedBoundaryPoint(rect: NodeRect, dx: number, dy: number, percentages?: readonly number[]): { x: number; y: number } {
  const c = center(rect);
  const halfWidth = Math.max(1, rect.width / 2);
  const halfHeight = Math.max(1, rect.height / 2);
  const outerScale = Math.min(Math.abs(dx) > 0 ? halfWidth / Math.abs(dx) : Number.POSITIVE_INFINITY, Math.abs(dy) > 0 ? halfHeight / Math.abs(dy) : Number.POSITIVE_INFINITY);
  const radii = normalizedRadii(rect.width, rect.height, percentages, rect.contentScale ?? 1);
  const outer = { x: c.x + dx * outerScale, y: c.y + dy * outerScale };
  if (insideRoundedRect(outer.x - rect.x, outer.y - rect.y, rect.width, rect.height, radii)) return outer;
  let low = 0;
  let high = outerScale;
  for (let index = 0; index < 34; index += 1) {
    const mid = (low + high) / 2;
    const x = c.x + dx * mid;
    const y = c.y + dy * mid;
    if (insideRoundedRect(x - rect.x, y - rect.y, rect.width, rect.height, radii)) low = mid;
    else high = mid;
  }
  return { x: c.x + dx * low, y: c.y + dy * low };
}

function normalizedRadii(width: number, height: number, percentages?: readonly number[], scale = 1): readonly number[] {
  const source = percentages?.length === 8 ? percentages : undefined;
  const horizontal = source ? source.slice(0, 4).map((value) => width * value / 100) : [18, 18, 18, 18].map(value => value * scale);
  const vertical = source ? source.slice(4).map((value) => height * value / 100) : [18, 18, 18, 18].map(value => value * scale);
  const factor = Math.min(1,
    width / Math.max(horizontal[0]! + horizontal[1]!, 1),
    width / Math.max(horizontal[3]! + horizontal[2]!, 1),
    height / Math.max(vertical[0]! + vertical[3]!, 1),
    height / Math.max(vertical[1]! + vertical[2]!, 1));
  // CSS scales all radii together when opposite sums exceed an edge; an individual
  // asymmetric radius may exceed half the width/height and must not be clamped.
  return [...horizontal.map((value) => value * factor), ...vertical.map((value) => value * factor)];
}

function insideRoundedRect(x: number, y: number, width: number, height: number, radii: readonly number[]): boolean {
  if (x < 0 || y < 0 || x > width || y > height) return false;
  const [htl, htr, hbr, hbl, vtl, vtr, vbr, vbl] = radii;
  if (x < htl! && y < vtl!) return ellipseContains(x, y, htl!, vtl!, htl!, vtl!);
  if (x > width - htr! && y < vtr!) return ellipseContains(x, y, width - htr!, vtr!, htr!, vtr!);
  if (x > width - hbr! && y > height - vbr!) return ellipseContains(x, y, width - hbr!, height - vbr!, hbr!, vbr!);
  if (x < hbl! && y > height - vbl!) return ellipseContains(x, y, hbl!, height - vbl!, hbl!, vbl!);
  return true;
}

function ellipseContains(x: number, y: number, cx: number, cy: number, rx: number, ry: number): boolean {
  if (rx <= 0 || ry <= 0) return true;
  return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1 + 1e-9;
}
