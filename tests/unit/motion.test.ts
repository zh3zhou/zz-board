import { describe, expect, it } from 'vitest';
import { bubbleMotion } from '../../src/web/motion.js';

describe('bubble motion', () => {
  it('is stable and stays inside the requested task ranges', () => {
    const first = bubbleMotion('task:stable-id', 'task');
    expect(bubbleMotion('task:stable-id', 'task')).toEqual(first);
    expect(first.durationSeconds).toBeGreaterThanOrEqual(8);
    expect(first.durationSeconds).toBeLessThanOrEqual(16);
    expect(first.xPixels).toBeGreaterThanOrEqual(6);
    expect(first.xPixels).toBeLessThanOrEqual(14);
    expect(first.yPixels).toBeGreaterThanOrEqual(6);
    expect(first.yPixels).toBeLessThanOrEqual(14);
    expect(first.delaySeconds).toBeLessThanOrEqual(0);
    expect(first.delaySeconds).toBeGreaterThanOrEqual(-first.durationSeconds);
  });

  it('gives notes a quieter drift than tasks', () => {
    const task = bubbleMotion('shared-id', 'task');
    const note = bubbleMotion('shared-id', 'note');
    expect(note.xPixels).toBeLessThan(task.xPixels);
    expect(note.yPixels).toBeLessThan(task.yPixels);
  });

  it('varies timing and direction inputs across ids', () => {
    expect(bubbleMotion('task:one', 'task')).not.toEqual(bubbleMotion('task:two', 'task'));
  });
});
