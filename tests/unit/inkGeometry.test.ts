import { describe, expect, it } from 'vitest';
import type { InkPoint, InkStrokeRecord } from '../../src/shared/schema.js';
import {
  cullInkStrokes, lassoSelectStrokes, normalizePointerPressure, precisionErase, simplifyInkPoints,
  stableSvgPath, strokeBounds, strokeOutline, strokeSvgPath, transformInkStroke, wholeEraserHit
} from '../../src/web/inkGeometry.js';

const now = '2026-09-04T00:00:00.000Z';

function stroke(id: string, points: InkPoint[], patch: Partial<InkStrokeRecord> = {}): InkStrokeRecord {
  return {
    id, tool: 'pen', points, color: '#222222', size: 8, opacity: 1, layer: 'background', zIndex: 0,
    revision: 0, createdAt: now, updatedAt: now, ...patch
  };
}

describe('ink geometry', () => {
  it('normalizes mouse pressure while retaining physical pen pressure', () => {
    expect(normalizePointerPressure('mouse', 0)).toBe(0.5);
    expect(normalizePointerPressure('pen', 0)).toBe(0.01);
    expect(normalizePointerPressure('pen', 0.72)).toBe(0.72);
    expect(normalizePointerPressure('pen', 2)).toBe(1);
  });

  it('makes a deterministic closed SVG outline and responds to pressure', () => {
    const low = stroke('low', [{ x: 0, y: 0, pressure: 0.1 }, { x: 40, y: 0, pressure: 0.1 }], { size: 20 });
    const high = stroke('high', [{ x: 0, y: 0, pressure: 1 }, { x: 40, y: 0, pressure: 1 }], { size: 20 });
    const path = strokeSvgPath(low);
    expect(path).toBe(strokeSvgPath(low));
    expect(path).toMatch(/^M /);
    expect(path).toMatch(/ Z$/);
    const lowHeight = outlineHeight(strokeOutline(low));
    const highHeight = outlineHeight(strokeOutline(high));
    expect(highHeight).toBeGreaterThan(lowHeight);
    expect(stableSvgPath([[0, -0], [1.23456, 2.34567]])).toBe('M 0 0 L 1.235 2.346 Z');
  });

  it('detects whole eraser crossings and splits a precision erase', () => {
    const value = stroke('line', [
      { x: 0, y: 0, pressure: 0.5 }, { x: 10, y: 0, pressure: 0.5 }, { x: 20, y: 0, pressure: 0.5 },
      { x: 30, y: 0, pressure: 0.5 }, { x: 40, y: 0, pressure: 0.5 }
    ], { size: 2 });
    const eraser = [{ x: 20, y: -8, pressure: 0.5 }, { x: 20, y: 8, pressure: 0.5 }];
    expect(wholeEraserHit(value, eraser, 2)).toBe(true);
    expect(wholeEraserHit(value, [{ x: 20, y: 30, pressure: 0.5 }], 2)).toBe(false);
    const result = precisionErase(value, eraser, 2);
    expect(result.hit).toBe(true);
    expect(result.remaining).toHaveLength(2);
    expect(result.remaining.flat().some((point) => point.x === 20)).toBe(false);
  });

  it('selects strokes crossing or enclosed by a lasso', () => {
    const strokes = [
      stroke('inside', [{ x: 5, y: 5, pressure: 0.5 }, { x: 6, y: 6, pressure: 0.5 }]),
      stroke('crosses', [{ x: -5, y: 5, pressure: 0.5 }, { x: 15, y: 5, pressure: 0.5 }]),
      stroke('outside', [{ x: 25, y: 25, pressure: 0.5 }])
    ];
    const polygon = [
      { x: 0, y: 0, pressure: 0.5 }, { x: 10, y: 0, pressure: 0.5 },
      { x: 10, y: 10, pressure: 0.5 }, { x: 0, y: 10, pressure: 0.5 }
    ];
    expect(lassoSelectStrokes(strokes, polygon)).toEqual(['inside', 'crosses']);
  });

  it('moves and scales coordinates without mutating the persisted source', () => {
    const original = stroke('scale', [{ x: 10, y: 20, pressure: 0.4 }, { x: 20, y: 30, pressure: 0.8 }], { size: 10 });
    const transformed = transformInkStroke(original, { originX: 10, originY: 20, scaleX: 2, scaleY: 3, translateX: 5, translateY: -5 });
    expect(transformed.points).toEqual([
      { x: 15, y: 15, pressure: 0.4 }, { x: 35, y: 45, pressure: 0.8 }
    ]);
    expect(transformed.size).toBeCloseTo(10 * Math.sqrt(6));
    expect(original.points[0]).toEqual({ x: 10, y: 20, pressure: 0.4 });
  });

  it('culls against world bounds and only simplifies a render copy', () => {
    const points = Array.from({ length: 100 }, (_, index) => ({ x: index, y: Math.sin(index / 12), pressure: 0.5 }));
    const original = stroke('visible', points);
    const far = stroke('far', [{ x: 10_000, y: 10_000, pressure: 0.5 }]);
    expect(cullInkStrokes([original, far], { x: -20, y: -20, width: 200, height: 200 }, 1).map((item) => item.id)).toEqual(['visible']);
    const simplified = simplifyInkPoints(points, 0.2);
    expect(simplified.length).toBeLessThan(points.length);
    expect(original.points).toHaveLength(100);
    expect(strokeBounds(original).width).toBeGreaterThan(99);
  });

  it('remains deterministic with one thousand strokes at broad zoom', () => {
    const strokes = Array.from({ length: 1_000 }, (_, index) => stroke(`s-${index}`, [
      { x: index * 7, y: index % 47, pressure: 0.2 + (index % 8) / 10 },
      { x: index * 7 + 20, y: index % 47 + 4, pressure: 0.5 }
    ]));
    const viewport = { x: 0, y: 0, width: 900, height: 500 };
    const first = cullInkStrokes(strokes, viewport, 0.2).map((item) => `${item.id}:${strokeSvgPath(item, 0.2)}`);
    const second = cullInkStrokes(strokes, viewport, 0.2).map((item) => `${item.id}:${strokeSvgPath(item, 0.2)}`);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(100);
    expect(first.length).toBeLessThan(1_000);
  });
});

function outlineHeight(points: Array<[number, number]>): number {
  return Math.max(...points.map((point) => point[1])) - Math.min(...points.map((point) => point[1]));
}
