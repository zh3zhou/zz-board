import { describe, expect, it } from 'vitest';
import { mergePendingInk } from '../../src/web/InkCanvas.js';
import type { InkStrokeRecord } from '../../src/shared/schema.js';

function stroke(id: string): InkStrokeRecord {
  return { id, tool: 'highlighter', points: [{ x: 0, y: 0, pressure: 0.5 }, { x: 80, y: 20, pressure: 0.5 }], color: '#e7c95c', size: 18, opacity: 0.3, layer: 'background', zIndex: 1, revision: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
}

describe('pending ink handoff', () => {
  it('retains a stroke across delayed or failed saves and unrelated event updates', () => {
    const pending = stroke('ink:pending');
    expect(mergePendingInk([], [pending])).toEqual([pending]);
    expect(mergePendingInk([stroke('ink:other')], [pending])).toHaveLength(2);
  });
  it('replaces by ID in the same render without duplicate highlighter opacity', () => {
    const pending = stroke('ink:pending');
    const saved = { ...pending, revision: 1 };
    expect(mergePendingInk([saved], [pending])).toEqual([saved]);
  });
  it('handles reverse acknowledgement order without removing unsaved strokes', () => {
    const first = stroke('ink:first');
    const second = stroke('ink:second');
    expect(mergePendingInk([second], [first, second]).map((item) => item.id)).toEqual(['ink:second', 'ink:first']);
    expect(mergePendingInk([first, second], [first, second])).toHaveLength(2);
  });
});
