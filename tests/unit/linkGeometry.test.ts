import { describe, expect, it } from 'vitest';
import { floatingLinkGeometry, linkBendFromPoint } from '../../src/web/linkGeometry.js';

describe('floating link geometry', () => {
  const left = { x: 0, y: 0, width: 160, height: 160, kind: 'task' as const };
  const right = { x: 460, y: 60, width: 160, height: 160, kind: 'task' as const };
  it('keeps the default curve monotone even across tiny gaps and overlaps', () => {
    const cases = [
      [left, { ...right, x: 170, y: 0 }],
      [left, { ...right, x: 120, y: 120 }],
      [{ ...left, width: 345, height: 305 }, { ...right, x: 15, y: 175, width: 603, height: 172 }],
      [left, left], [left, { ...left, width: 50, height: 50, x: 55, y: 55 }]
    ];
    for (const [a, b] of cases) {
      const curve = floatingLinkGeometry(a!, b!);
      const dx = curve.target.x - curve.source.x, dy = curve.target.y - curve.source.y;
      const length2 = dx * dx + dy * dy;
      expect(length2).toBeGreaterThan(0);
      const projection = (p: { x: number; y: number }) => ((p.x - curve.source.x) * dx + (p.y - curve.source.y) * dy) / length2;
      expect(projection(curve.control1)).toBeCloseTo(1 / 3);
      expect(projection(curve.control2)).toBeCloseTo(2 / 3);
      expect(curve.path).not.toMatch(/NaN|Infinity/);
      const requested = { x: curve.midpoint.x + 20, y: curve.midpoint.y - 10 };
      const edited = floatingLinkGeometry(a!, b!, linkBendFromPoint(curve.source, curve.target, requested));
      expect(edited.midpoint.x).toBeCloseTo(requested.x); expect(edited.midpoint.y).toBeCloseTo(requested.y);
    }
    expect(floatingLinkGeometry(left, { ...right, x: 120, y: 120 }).overlapping).toBe(false);
  });
  it('places the drag handle exactly on its requested curve midpoint and retains endpoints', () => {
    const initial = floatingLinkGeometry(left, right);
    const requested = { x: initial.midpoint.x + 38, y: initial.midpoint.y + 77 };
    const bent = floatingLinkGeometry(left, right, linkBendFromPoint(initial.source, initial.target, requested));
    expect(bent.midpoint.x).toBeCloseTo(requested.x, 8);
    expect(bent.midpoint.y).toBeCloseTo(requested.y, 8);
    expect(bent.source).toEqual(initial.source);
    expect(bent.target).toEqual(initial.target);
    expect(floatingLinkGeometry(left, right, null)).toEqual(initial);
  });

  it('scales short manual bends and their editing frame with the whole composition', () => {
    const near = { ...right, x: 170, y: 0 };
    const bend = { along: .1, normal: .5 };
    const original = floatingLinkGeometry(left, near, bend);
    for (const scale of [.25, 2, 4]) {
      const resize = (rect: typeof left) => ({ ...rect, x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale, contentScale: scale });
      const next = floatingLinkGeometry(resize(left), resize(near), bend);
      expect(next.midpoint.x).toBeCloseTo(original.midpoint.x * scale);
      expect(next.midpoint.y).toBeCloseTo(original.midpoint.y * scale);
      expect(linkBendFromPoint(next.source, next.target, next.midpoint, next.frameScale)).toEqual({ along: expect.closeTo(bend.along), normal: expect.closeTo(bend.normal) });
    }
  });

  it('preserves relative bend when endpoints translate or scale and safely bounds invalid input', () => {
    const bend = { along: 0.12, normal: -0.3 };
    const original = floatingLinkGeometry(left, right, bend);
    const moved = floatingLinkGeometry({ ...left, x: left.x + 140, y: left.y - 90 }, { ...right, x: right.x + 140, y: right.y - 90 }, bend);
    expect(moved.midpoint.x).toBeCloseTo(original.midpoint.x + 140);
    expect(moved.midpoint.y).toBeCloseTo(original.midpoint.y - 90);
    expect(linkBendFromPoint(moved.source, moved.target, moved.midpoint)).toEqual(expect.objectContaining({ along: expect.closeTo(bend.along), normal: expect.closeTo(bend.normal) }));
    expect(floatingLinkGeometry(left, right, { along: Infinity, normal: NaN }).path).not.toMatch(/NaN|Infinity/);
    expect(linkBendFromPoint({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1e8, y: -1e8 })).toEqual({ along: 4, normal: -4 });
  });

  it('uses the actual default soft-blob contour and CSS asymmetric radius normalization', () => {
    const defaultBlob = floatingLinkGeometry({ ...left, shape: 'softBlob' }, right);
    const explicitBlob = floatingLinkGeometry({ ...left, shape: 'softBlob', cornerRadii: [42, 58, 52, 48, 50, 44, 56, 50] }, right);
    expect(defaultBlob).toEqual(explicitBlob);
    const asymmetric = floatingLinkGeometry({ x: 0, y: 0, width: 200, height: 200, kind: 'task', shape: 'softBlob', cornerRadii: [80, 20, 20, 20, 80, 20, 20, 20] }, { ...right, x: -400, y: -400 });
    // Top-left corner radius is 160px, not an incorrectly half-width-clamped 100px.
    expect(asymmetric.source.x).toBeCloseTo(160 - 160 / Math.sqrt(2), 5);
    expect(asymmetric.source.y).toBeCloseTo(asymmetric.source.x, 5);
  });
  it('meets task ellipses and note rectangles at their boundaries', () => {
    const link = floatingLinkGeometry(
      { x: 0, y: 0, width: 200, height: 160, kind: 'task' },
      { x: 420, y: 40, width: 180, height: 120, kind: 'note' }
    );
    expect(link.overlapping).toBe(false);
    expect(link.source.x).toBeGreaterThan(100);
    expect(link.source.x).toBeLessThanOrEqual(200);
    expect(link.target.x).toBe(420);
    expect(link.path).toMatch(/^M .* C /);
  });

  it('draws an external arc when bubbles overlap instead of hiding the relationship', () => {
    const link = floatingLinkGeometry(
      { x: 100, y: 100, width: 180, height: 180, kind: 'task' },
      { x: 150, y: 130, width: 210, height: 150, kind: 'note' }
    );
    expect(link.overlapping).toBe(true);
    const coordinates = [...link.path.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
    expect(Math.min(...coordinates)).toBeLessThan(100);
    expect(link.source).not.toEqual(link.target);
  });

  it('uses the declared shape when choosing visible link endpoints', () => {
    const ellipse = floatingLinkGeometry(
      { x: 0, y: 0, width: 200, height: 120, kind: 'task', shape: 'ellipse' },
      { x: 400, y: 150, width: 160, height: 120, kind: 'task', shape: 'circle' }
    );
    const rectangle = floatingLinkGeometry(
      { x: 0, y: 0, width: 200, height: 120, kind: 'task', shape: 'roundedRect' },
      { x: 400, y: 150, width: 160, height: 120, kind: 'task', shape: 'circle' }
    );
    const blob = floatingLinkGeometry(
      { x: 0, y: 0, width: 200, height: 120, kind: 'task', shape: 'softBlob' },
      { x: 400, y: 150, width: 160, height: 120, kind: 'task', shape: 'circle' }
    );
    expect(rectangle.source.x).toBe(200);
    expect(ellipse.source.x).toBeLessThan(rectangle.source.x);
    expect(blob.source.x).not.toBeCloseTo(ellipse.source.x);
    expect(blob.source.x).toBeGreaterThan(100);
    expect(blob.source.x).toBeLessThanOrEqual(rectangle.source.x);
  });

  it('uses custom safe soft-blob corner radii instead of a generic bounding box', () => {
    const target = { x: 400, y: 150, width: 160, height: 120, kind: 'task' as const, shape: 'circle' as const };
    const squareCorner = floatingLinkGeometry(
      { x: 0, y: 0, width: 200, height: 120, kind: 'task', shape: 'softBlob', cornerRadii: [8, 8, 8, 8, 8, 8, 8, 8] }, target
    );
    const roundCorner = floatingLinkGeometry(
      { x: 0, y: 0, width: 200, height: 120, kind: 'task', shape: 'softBlob', cornerRadii: [60, 60, 60, 60, 60, 60, 60, 60] }, target
    );
    expect(roundCorner.source.x).toBeLessThan(squareCorner.source.x);
    expect(roundCorner.source.y).toBeLessThan(squareCorner.source.y);
  });
});
