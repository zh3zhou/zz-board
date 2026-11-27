import { describe, expect, it } from 'vitest';
import { findInboxPosition, initialTaskPosition } from '../../src/shared/layout.js';

describe('spatial layout', () => {
  it('is deterministic and spreads task bubbles', () => {
    expect(initialTaskPosition(12)).toEqual(initialTaskPosition(12));
    expect(new Set(Array.from({ length: 40 }, (_, index) => JSON.stringify(initialTaskPosition(index)))).size).toBe(40);
  });

  it('places a new note outside occupied rectangles', () => {
    const occupied = [{ x: -720, y: -360, width: 180, height: 180 }];
    expect(findInboxPosition(occupied)).not.toEqual({ x: -720, y: -360 });
  });
});
