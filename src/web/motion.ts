export interface BubbleMotion {
  durationSeconds: number;
  delaySeconds: number;
  xPixels: number;
  yPixels: number;
  shadowSeconds: number;
}

/**
 * Stable, inexpensive motion parameters derived from the persisted node id.
 * The canvas position remains the source of truth; animation is visual only.
 */
export function bubbleMotion(id: string, kind: 'task' | 'note'): BubbleMotion {
  const first = hash(id);
  const second = hash(`${id}:shadow`);
  const taskScale = kind === 'task' ? 1 : 0.46;
  const durationSeconds = round(8 + (first % 801) / 100);
  const xPixels = round((6 + ((first >>> 8) % 801) / 100) * taskScale);
  const yPixels = round((6 + ((first >>> 16) % 801) / 100) * taskScale);

  return {
    durationSeconds,
    delaySeconds: -round(((second % 10_000) / 10_000) * durationSeconds),
    xPixels,
    yPixels,
    shadowSeconds: round(7 + ((second >>> 12) % 600) / 100)
  };
}

function hash(value: string): number {
  let result = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16_777_619);
  }
  return result >>> 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
