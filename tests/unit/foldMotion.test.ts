import { describe, expect, it } from 'vitest';
import { foldMotionFrames } from '../../src/web/foldMotion.js';
import { floatingLinkGeometry, type NodeRect } from '../../src/web/linkGeometry.js';

const note: NodeRect = { x: 400, y: 120, width: 220, height: 160, kind: 'note' };
const host: NodeRect = { x: 20, y: 30, width: 180, height: 180, kind: 'task' };
function translation(frame: Keyframe) {
  const values = [...String(frame.transform).matchAll(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)].map((match) => Number(match[0]));
  return { x: values[0], y: values[1], scale: values[2] };
}

describe('fold motion follows the real connection', () => {
  it('starts at the note center, traverses boundaries and curve, and ends inside host', () => {
    const link = floatingLinkGeometry(note, host, { along: 0.15, normal: 0.6 });
    const frames = foldMotionFrames(note, host, link, true);
    expect(frames).toHaveLength(19);
    expect(translation(frames[0]!)).toEqual({ x: 0, y: 0, scale: 1 });
    expect(frames[0]!.opacity).toBe(1);
    expect(translation(frames[1]!).x).toBeCloseTo(link.source.x - 510);
    expect(translation(frames[9]!).x).toBeCloseTo(link.midpoint.x - 510);
    expect(translation(frames[9]!).y).toBeCloseTo(link.midpoint.y - 200);
    expect(translation(frames[17]!).x).toBeCloseTo(link.target.x - 510);
    expect(translation(frames[18]!).x).toBeCloseTo(-400);
    expect(translation(frames[18]!).y).toBeCloseTo(-80);
    expect(translation(frames[18]!).scale).toBeCloseTo(0.06);
    expect(frames[18]!.opacity).toBe(0);
    expect(frames.map((f) => f.offset)).toEqual([...frames.map((f) => f.offset)].sort((a, b) => Number(a) - Number(b)));
    expect(frames[18]!.offset).toBe(1);
  });

  it('traverses a stored host-to-note curve in reverse without mirroring its bend', () => {
    const link = floatingLinkGeometry(host, note, { along: -0.2, normal: 0.4 });
    const frames = foldMotionFrames(note, host, link, false);
    expect(translation(frames[1]!).x).toBeCloseTo(link.target.x - 510);
    expect(translation(frames[9]!).x).toBeCloseTo(link.midpoint.x - 510);
    expect(translation(frames[9]!).y).toBeCloseTo(link.midpoint.y - 200);
    expect(translation(frames[17]!).x).toBeCloseTo(link.source.x - 510);
  });

  it('handles overlapping nodes without NaN and never changes layout or control records', () => {
    const overlap = { ...host, x: note.x + 20, y: note.y + 20 };
    const link = floatingLinkGeometry(note, overlap);
    const before = structuredClone({ note, overlap, link });
    const frames = foldMotionFrames(note, overlap, link, true);
    expect(link.overlapping).toBe(true);
    expect(JSON.stringify(frames)).not.toMatch(/NaN|Infinity/);
    expect({ note, overlap, link }).toEqual(before);
  });
});
