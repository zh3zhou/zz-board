import { describe, expect, it } from 'vitest';
import {
  BROAD_SCALE_ENTER_ZOOM,
  BROAD_SCALE_EXIT_ZOOM,
  dragRect,
  intersectsRect,
  isBroadScale,
  selectionAfterClick,
  selectionAfterMarquee
} from '../../src/web/canvasInteraction.js';

describe('canvas selection', () => {
  it('uses a normal click as a single selection and Shift-click as a stable toggle', () => {
    expect(selectionAfterClick(['one', 'two'], 'three', false)).toEqual(['three']);
    expect(selectionAfterClick(['one'], 'two', true)).toEqual(['one', 'two']);
    expect(selectionAfterClick(['one', 'two'], 'one', true)).toEqual(['two']);
  });

  it('replaces selection with a right-drag marquee or adds to it while Shift is held', () => {
    expect(selectionAfterMarquee(['old'], ['two', 'three', 'two'], false)).toEqual(['two', 'three']);
    expect(selectionAfterMarquee(['one', 'two'], ['two', 'three'], true)).toEqual(['one', 'two', 'three']);
  });

  it('selects bubbles that are even partially inside a rectangle', () => {
    const marquee = dragRect(200, 160, 100, 80);
    expect(marquee).toEqual({ left: 100, top: 80, right: 200, bottom: 160 });
    expect(intersectsRect(marquee, { left: 190, top: 150, right: 240, bottom: 220 })).toBe(true);
    expect(intersectsRect(marquee, { left: 201, top: 161, right: 240, bottom: 220 })).toBe(false);
  });
});

describe('broad-scale rendering mode', () => {
  it('uses hysteresis so animation layers do not flap near the threshold', () => {
    expect(isBroadScale(BROAD_SCALE_ENTER_ZOOM, false)).toBe(true);
    expect(isBroadScale(BROAD_SCALE_ENTER_ZOOM + 0.02, false)).toBe(false);
    expect(isBroadScale(BROAD_SCALE_EXIT_ZOOM - 0.01, true)).toBe(true);
    expect(isBroadScale(BROAD_SCALE_EXIT_ZOOM, true)).toBe(false);
  });
});
