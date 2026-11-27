import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getStroke } from 'perfect-freehand';
import type { InkPoint, InkStrokeRecord } from '../../src/shared/schema.js';
import { cachedStrokeSvgPath, strokeSvgPath, transformInkStroke } from '../../src/web/inkGeometry.js';

vi.mock('perfect-freehand', async (importOriginal) => {
  const actual = await importOriginal<typeof import('perfect-freehand')>();
  return { ...actual, getStroke: vi.fn(actual.getStroke) };
});

function stroke(id = 'ink:cached'): InkStrokeRecord {
  return {
    id, tool: 'pen', points: Array.from({ length: 100 }, (_, index) => ({
      x: index * 2, y: Math.sin(index / 6) * 10, pressure: .2 + (index % 8) / 10
    })), color: '#222222', size: 8, opacity: 1, layer: 'background', zIndex: 0,
    revision: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01'
  };
}

beforeEach(() => { vi.mocked(getStroke).mockClear(); });

describe('ink rendering cache', () => {
  it('reuses unchanged geometry through hover, selection, color and pan redraws', () => {
    const value = stroke();
    const original = structuredClone(value);
    const first = cachedStrokeSvgPath(value, .2);
    for (let render = 0; render < 20; render += 1) {
      const styled: InkStrokeRecord = { ...value, color: '#abcdef', opacity: .3, zIndex: render };
      expect(cachedStrokeSvgPath(styled, .2)).toBe(first);
    }
    expect(getStroke).toHaveBeenCalledTimes(1);
    expect(value).toEqual(original);
    expect(first).toBe(strokeSvgPath(value, .2));
  });

  it('preserves exact pen and highlighter paths at broad and neighboring zoom values', () => {
    const value = stroke();
    for (const tool of ['pen', 'highlighter'] as const) {
      for (const zoom of [.1, .20001, .20002, 1, 4]) {
        const shaped = { ...value, tool };
        expect(cachedStrokeSvgPath(shaped, zoom)).toBe(strokeSvgPath(shaped, zoom));
      }
    }
    // Every distinct zoom is rendered separately, even when paths happen to coincide.
    expect(getStroke).toHaveBeenCalledTimes(20);
  });

  it('rebuilds after tool, size, pressure, erasure and coordinate changes', () => {
    const value = stroke();
    const original = structuredClone(value);
    const initial = cachedStrokeSvgPath(value);
    const variants: InkStrokeRecord[] = [
      { ...value, tool: 'highlighter' },
      { ...value, size: 16 },
      { ...value, points: value.points.map(point => ({ ...point, pressure: 1 })) },
      { ...value, points: value.points.slice(30) },
      transformInkStroke(value, { translateX: 40, translateY: 20 }),
      transformInkStroke(value, { scaleX: 2, scaleY: 2 })
    ];
    const rendered = variants.map(changed => cachedStrokeSvgPath(changed));
    expect(getStroke).toHaveBeenCalledTimes(7);
    variants.forEach((changed, index) => {
      expect(rendered[index]).toBe(strokeSvgPath(changed));
      expect(rendered[index]).not.toBe(initial);
    });
    expect(value).toEqual(original);
    expect(cachedStrokeSvgPath(value)).toBe(initial);
  });

  it('keeps at most four recent geometry/zoom variants per point array', () => {
    const value = stroke();
    for (const zoom of [1, 2, 3, 4]) cachedStrokeSvgPath(value, zoom);
    expect(getStroke).toHaveBeenCalledTimes(4);
    cachedStrokeSvgPath(value, 1); // Keep the most recently read zoom.
    cachedStrokeSvgPath(value, .5);
    expect(getStroke).toHaveBeenCalledTimes(5);
    cachedStrokeSvgPath(value, 1);
    expect(getStroke).toHaveBeenCalledTimes(5);
    cachedStrokeSvgPath(value, 2); // Oldest variant was evicted.
    expect(getStroke).toHaveBeenCalledTimes(6);
  });

  it('does not retain old geometry after a point array is replaced with equal or changed content', () => {
    const value = stroke();
    const first = cachedStrokeSvgPath(value);
    const equal = { ...value, points: value.points.map(point => ({ ...point })) };
    expect(cachedStrokeSvgPath(equal)).toBe(first);
    const changed = { ...value, points: value.points.map(point => ({ ...point, y: point.y + 10 })) };
    expect(cachedStrokeSvgPath(changed)).not.toBe(first);
    expect(getStroke).toHaveBeenCalledTimes(3);
  });

  it('avoids recomputing a thousand unchanged strokes without simplifying stored points', () => {
    const strokes = Array.from({ length: 1000 }, (_, index) => stroke(`ink:${index}`));
    const baseline = strokes.map(value => strokeSvgPath(value, .1));
    expect(strokes.map(value => strokeSvgPath(value, .1))).toEqual(baseline);
    expect(getStroke).toHaveBeenCalledTimes(2000);
    vi.mocked(getStroke).mockClear();
    const first = strokes.map(value => cachedStrokeSvgPath(value, .1));
    const second = strokes.map(value => cachedStrokeSvgPath(value, .1));
    expect(first).toEqual(baseline);
    expect(second).toEqual(first);
    expect(getStroke).toHaveBeenCalledTimes(1000);
    expect(strokes.every(value => value.points.length === 100)).toBe(true);
  });

  it('handles empty paths and frozen persisted point arrays without modifying them', () => {
    const points: InkPoint[] = [];
    const empty = { ...stroke(), points };
    expect(cachedStrokeSvgPath(empty)).toBe('');
    expect(cachedStrokeSvgPath(empty)).toBe('');
    expect(getStroke).toHaveBeenCalledTimes(1);
    const value = stroke();
    value.points.forEach(point => Object.freeze(point));
    Object.freeze(value.points);
    expect(cachedStrokeSvgPath(value, .1)).toBe(strokeSvgPath(value, .1));
    expect(value.points).toHaveLength(100);
  });
});
