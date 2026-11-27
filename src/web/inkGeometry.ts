import { getStroke } from 'perfect-freehand';
import type { InkPoint, InkStrokeRecord } from '../shared/schema.js';

export interface InkRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InkTransform {
  translateX?: number;
  translateY?: number;
  scaleX?: number;
  scaleY?: number;
  originX?: number;
  originY?: number;
}

export interface EraseResult {
  hit: boolean;
  remaining: InkPoint[][];
}

const EPSILON = 1e-9;
const MAX_CACHED_PATHS_PER_POINTS = 4;
const renderedPaths = new WeakMap<readonly InkPoint[], Map<string, string>>();

export function normalizePointerPressure(pointerType: string, pressure: number): number {
  if (Number.isFinite(pressure) && pressure > 0) return Math.min(1, pressure);
  return pointerType === 'mouse' ? 0.5 : 0.01;
}

export function simplifyInkPoints(points: readonly InkPoint[], zoom: number): InkPoint[] {
  if (points.length <= 2) return points.map(copyPoint);
  const tolerance = Math.max(0.08, Math.min(3.5, 0.7 / Math.max(zoom, 0.05)));
  const first = points[0]!;
  const last = points[points.length - 1]!;
  let index = -1;
  let furthest = tolerance;

  for (let cursor = 1; cursor < points.length - 1; cursor += 1) {
    const distance = pointToSegmentDistance(points[cursor]!, first, last);
    if (distance > furthest) {
      index = cursor;
      furthest = distance;
    }
  }

  if (index < 0) return [copyPoint(first), copyPoint(last)];
  const left = simplifyInkPoints(points.slice(0, index + 1), zoom);
  const right = simplifyInkPoints(points.slice(index), zoom);
  return [...left.slice(0, -1), ...right];
}

export function strokeOutline(stroke: Pick<InkStrokeRecord, 'points' | 'size' | 'tool'>, zoom = 1): Array<[number, number]> {
  const points = simplifyInkPoints(stroke.points, zoom);
  return getStroke(points, {
    size: stroke.size,
    thinning: stroke.tool === 'highlighter' ? 0.12 : 0.58,
    smoothing: stroke.tool === 'highlighter' ? 0.65 : 0.56,
    streamline: stroke.tool === 'highlighter' ? 0.46 : 0.34,
    simulatePressure: false,
    last: true,
    start: { cap: true, taper: false },
    end: { cap: true, taper: false }
  });
}

export function stableSvgPath(points: ReadonlyArray<readonly [number, number]>): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const [x, y] = points[0]!;
    return `M ${stableNumber(x)} ${stableNumber(y)} Z`;
  }
  const first = points[0]!;
  let path = `M ${stableNumber(first[0])} ${stableNumber(first[1])}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index]!;
    const next = points[index + 1]!;
    path += ` Q ${stableNumber(point[0])} ${stableNumber(point[1])} ${stableNumber((point[0] + next[0]) / 2)} ${stableNumber((point[1] + next[1]) / 2)}`;
  }
  const last = points[points.length - 1]!;
  return `${path} L ${stableNumber(last[0])} ${stableNumber(last[1])} Z`;
}

export function strokeSvgPath(stroke: Pick<InkStrokeRecord, 'points' | 'size' | 'tool'>, zoom = 1): string {
  return stableSvgPath(strokeOutline(stroke, zoom));
}

/** Rendering/transform producers replace points arrays; never mutate an array passed here. */
export function cachedStrokeSvgPath(stroke: Pick<InkStrokeRecord, 'points' | 'size' | 'tool'>, zoom = 1): string {
  let paths = renderedPaths.get(stroke.points);
  if (!paths) {
    paths = new Map();
    renderedPaths.set(stroke.points, paths);
  }
  // Preserve the exact zoom-dependent outline, without rounding or bucketing zoom.
  const key = `${zoom}:${stroke.size}:${stroke.tool}`;
  const cached = paths.get(key);
  if (cached !== undefined) {
    paths.delete(key);
    paths.set(key, cached);
    return cached;
  }
  const path = strokeSvgPath(stroke, zoom);
  paths.set(key, path);
  if (paths.size > MAX_CACHED_PATHS_PER_POINTS) paths.delete(paths.keys().next().value!);
  return path;
}

export function pointsBounds(points: readonly InkPoint[], padding = 0): InkRect {
  if (points.length === 0) return { x: -padding, y: -padding, width: padding * 2, height: padding * 2 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX - padding, y: minY - padding, width: maxX - minX + padding * 2, height: maxY - minY + padding * 2 };
}

export function strokeBounds(stroke: Pick<InkStrokeRecord, 'points' | 'size'>): InkRect {
  return pointsBounds(stroke.points, stroke.size / 2 + 1);
}

export function selectionBounds(strokes: readonly Pick<InkStrokeRecord, 'points' | 'size'>[]): InkRect | null {
  if (strokes.length === 0) return null;
  const rects = strokes.map(strokeBounds);
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function rectsIntersect(left: InkRect, right: InkRect, padding = 0): boolean {
  return left.x <= right.x + right.width + padding && left.x + left.width >= right.x - padding
    && left.y <= right.y + right.height + padding && left.y + left.height >= right.y - padding;
}

export function cullInkStrokes(strokes: readonly InkStrokeRecord[], viewport: InkRect, zoom: number): InkStrokeRecord[] {
  const padding = Math.max(24, 96 / Math.max(zoom, 0.05));
  return strokes.filter((stroke) => rectsIntersect(strokeBounds(stroke), viewport, padding));
}

export function pointToSegmentDistance(point: Pick<InkPoint, 'x' | 'y'>, start: Pick<InkPoint, 'x' | 'y'>, end: Pick<InkPoint, 'x' | 'y'>): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON) return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (start.x + projection * dx), point.y - (start.y + projection * dy));
}

export function pointToPolylineDistance(point: Pick<InkPoint, 'x' | 'y'>, line: readonly Pick<InkPoint, 'x' | 'y'>[]): number {
  if (line.length === 0) return Number.POSITIVE_INFINITY;
  if (line.length === 1) return Math.hypot(point.x - line[0]!.x, point.y - line[0]!.y);
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < line.length; index += 1) {
    nearest = Math.min(nearest, pointToSegmentDistance(point, line[index - 1]!, line[index]!));
  }
  return nearest;
}

export function wholeEraserHit(stroke: Pick<InkStrokeRecord, 'points' | 'size'>, eraserPath: readonly InkPoint[], radius: number): boolean {
  if (stroke.points.length === 0 || eraserPath.length === 0) return false;
  const threshold = Math.max(0, radius) + stroke.size / 2;
  if (stroke.points.length === 1) return pointToPolylineDistance(stroke.points[0]!, eraserPath) <= threshold;
  if (eraserPath.length === 1) return pointToPolylineDistance(eraserPath[0]!, stroke.points) <= threshold;
  for (let strokeIndex = 1; strokeIndex < stroke.points.length; strokeIndex += 1) {
    for (let eraserIndex = 1; eraserIndex < eraserPath.length; eraserIndex += 1) {
      if (segmentDistance(stroke.points[strokeIndex - 1]!, stroke.points[strokeIndex]!, eraserPath[eraserIndex - 1]!, eraserPath[eraserIndex]!) <= threshold) return true;
    }
  }
  return false;
}

export function precisionErase(stroke: Pick<InkStrokeRecord, 'points' | 'size'>, eraserPath: readonly InkPoint[], radius: number): EraseResult {
  if (!wholeEraserHit(stroke, eraserPath, radius)) return { hit: false, remaining: [stroke.points.map(copyPoint)] };
  const threshold = Math.max(0, radius) + stroke.size / 2;
  const removed = stroke.points.map((point, index) => {
    if (pointToPolylineDistance(point, eraserPath) <= threshold) return true;
    const previous = index > 0 ? stroke.points[index - 1] : undefined;
    return Boolean(previous && polylineSegmentHit(previous, point, eraserPath, threshold));
  });
  const remaining: InkPoint[][] = [];
  let run: InkPoint[] = [];
  for (let index = 0; index < stroke.points.length; index += 1) {
    if (!removed[index]) {
      run.push(copyPoint(stroke.points[index]!));
      continue;
    }
    if (run.length > 0) remaining.push(run);
    run = [];
  }
  if (run.length > 0) remaining.push(run);
  return { hit: true, remaining };
}

export function pointInPolygon(point: Pick<InkPoint, 'x' | 'y'>, polygon: readonly Pick<InkPoint, 'x' | 'y'>[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index]!;
    const previousPoint = polygon[previous]!;
    const crosses = (currentPoint.y > point.y) !== (previousPoint.y > point.y)
      && point.x < ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) / ((previousPoint.y - currentPoint.y) || EPSILON) + currentPoint.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function strokeIntersectsPolygon(stroke: Pick<InkStrokeRecord, 'points'>, polygon: readonly InkPoint[]): boolean {
  if (polygon.length < 3 || stroke.points.length === 0) return false;
  if (stroke.points.some((point) => pointInPolygon(point, polygon))) return true;
  for (let strokeIndex = 1; strokeIndex < stroke.points.length; strokeIndex += 1) {
    for (let edge = 0; edge < polygon.length; edge += 1) {
      if (segmentsIntersect(stroke.points[strokeIndex - 1]!, stroke.points[strokeIndex]!, polygon[edge]!, polygon[(edge + 1) % polygon.length]!)) return true;
    }
  }
  return false;
}

export function lassoSelectStrokes(strokes: readonly InkStrokeRecord[], polygon: readonly InkPoint[]): string[] {
  return strokes.filter((stroke) => strokeIntersectsPolygon(stroke, polygon)).map((stroke) => stroke.id);
}

export function rectIntersectsPolygon(rect: InkRect, polygon: readonly InkPoint[]): boolean {
  const corners: InkPoint[] = [
    { x: rect.x, y: rect.y, pressure: 0.5 },
    { x: rect.x + rect.width, y: rect.y, pressure: 0.5 },
    { x: rect.x + rect.width, y: rect.y + rect.height, pressure: 0.5 },
    { x: rect.x, y: rect.y + rect.height, pressure: 0.5 }
  ];
  if (corners.some((point) => pointInPolygon(point, polygon))) return true;
  if (polygon.some((point) => point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height)) return true;
  for (let rectEdge = 0; rectEdge < corners.length; rectEdge += 1) {
    for (let polygonEdge = 0; polygonEdge < polygon.length; polygonEdge += 1) {
      if (segmentsIntersect(corners[rectEdge]!, corners[(rectEdge + 1) % corners.length]!, polygon[polygonEdge]!, polygon[(polygonEdge + 1) % polygon.length]!)) return true;
    }
  }
  return false;
}

export function transformInkPoints(points: readonly InkPoint[], transform: InkTransform): InkPoint[] {
  const originX = transform.originX ?? 0;
  const originY = transform.originY ?? 0;
  const scaleX = transform.scaleX ?? 1;
  const scaleY = transform.scaleY ?? 1;
  const translateX = transform.translateX ?? 0;
  const translateY = transform.translateY ?? 0;
  return points.map((point) => ({
    x: originX + (point.x - originX) * scaleX + translateX,
    y: originY + (point.y - originY) * scaleY + translateY,
    pressure: point.pressure
  }));
}

export function transformInkStroke(stroke: InkStrokeRecord, transform: InkTransform): InkStrokeRecord {
  const scale = Math.sqrt(Math.abs((transform.scaleX ?? 1) * (transform.scaleY ?? 1)));
  return {
    ...stroke,
    points: transformInkPoints(stroke.points, transform),
    size: Math.max(0.25, Math.min(256, stroke.size * scale))
  };
}

function stableNumber(value: number): string {
  const rounded = Math.round(value * 1_000) / 1_000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function copyPoint(point: InkPoint): InkPoint {
  return { x: point.x, y: point.y, pressure: point.pressure };
}

function polylineSegmentHit(start: InkPoint, end: InkPoint, line: readonly InkPoint[], threshold: number): boolean {
  if (line.length === 1) return pointToSegmentDistance(line[0]!, start, end) <= threshold;
  for (let index = 1; index < line.length; index += 1) {
    if (segmentDistance(start, end, line[index - 1]!, line[index]!) <= threshold) return true;
  }
  return false;
}

function segmentDistance(a: InkPoint, b: InkPoint, c: InkPoint, d: InkPoint): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointToSegmentDistance(a, c, d),
    pointToSegmentDistance(b, c, d),
    pointToSegmentDistance(c, a, b),
    pointToSegmentDistance(d, a, b)
  );
}

function segmentsIntersect(a: Pick<InkPoint, 'x' | 'y'>, b: Pick<InkPoint, 'x' | 'y'>, c: Pick<InkPoint, 'x' | 'y'>, d: Pick<InkPoint, 'x' | 'y'>): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (abC * abD < 0 && cdA * cdB < 0) return true;
  return Math.abs(abC) < EPSILON && onSegment(a, b, c)
    || Math.abs(abD) < EPSILON && onSegment(a, b, d)
    || Math.abs(cdA) < EPSILON && onSegment(c, d, a)
    || Math.abs(cdB) < EPSILON && onSegment(c, d, b);
}

function orientation(a: Pick<InkPoint, 'x' | 'y'>, b: Pick<InkPoint, 'x' | 'y'>, c: Pick<InkPoint, 'x' | 'y'>): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: Pick<InkPoint, 'x' | 'y'>, b: Pick<InkPoint, 'x' | 'y'>, point: Pick<InkPoint, 'x' | 'y'>): boolean {
  return point.x >= Math.min(a.x, b.x) - EPSILON && point.x <= Math.max(a.x, b.x) + EPSILON
    && point.y >= Math.min(a.y, b.y) - EPSILON && point.y <= Math.max(a.y, b.y) + EPSILON;
}
