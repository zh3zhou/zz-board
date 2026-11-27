import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePriorityDate } from '../../src/web/usePriorityDate.js';

const hooks = vi.hoisted(() => ({ changed: vi.fn(), effect: undefined as undefined | (() => () => void) }));
vi.mock('react', () => ({
  useState: (initial: () => string) => [initial(), hooks.changed],
  useEffect: (effect: () => () => void) => { hooks.effect = effect; }
}));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); hooks.changed.mockClear(); });

describe('canvas priority date', () => {
  it('ticks at local midnight and re-evaluates on visibility and focus after sleep', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2028, 1, 28, 23, 59, 59, 990));
    const surface = Object.assign(new EventTarget(), { setTimeout, clearTimeout });
    const page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', surface); vi.stubGlobal('document', page);
    expect(usePriorityDate()).toBe('2028-02-28');
    const dispose = hooks.effect!();
    try {
      vi.advanceTimersByTime(10); expect(hooks.changed).toHaveBeenLastCalledWith('2028-02-29');
      vi.setSystemTime(new Date(2028, 2, 2, 10)); surface.dispatchEvent(new Event('focus'));
      expect(hooks.changed).toHaveBeenLastCalledWith('2028-03-02');
      vi.setSystemTime(new Date(2028, 2, 3, 8)); page.visibilityState = 'hidden'; page.dispatchEvent(new Event('visibilitychange'));
      expect(hooks.changed).toHaveBeenLastCalledWith('2028-03-02');
      page.visibilityState = 'visible'; page.dispatchEvent(new Event('visibilitychange'));
      expect(hooks.changed).toHaveBeenLastCalledWith('2028-03-03'); expect(vi.getTimerCount()).toBe(1);
    } finally { dispose(); }
    expect(vi.getTimerCount()).toBe(0);
    surface.dispatchEvent(new Event('focus')); expect(vi.getTimerCount()).toBe(0);
  });
});
