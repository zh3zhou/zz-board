import { afterEach, expect, it, vi } from 'vitest';
import { BOARD_NOTICE_DURATION, useBoardNotice } from '../../src/web/boardNotice.js';

type Entry = { text:string; key:number; transient:boolean };
const hooks = vi.hoisted(() => ({ entry:undefined as Entry | undefined, sequence:{ current:0 },
  effect:() => undefined as undefined | (() => void) }));
vi.mock('react', () => ({
  useState(initial: Entry) {
    hooks.entry ??= initial;
    return [hooks.entry, (next: Entry | ((old: Entry) => Entry)) => {
      hooks.entry = typeof next === 'function' ? next(hooks.entry!) : next;
    }];
  },
  useRef:() => hooks.sequence, useCallback:(fn: unknown) => fn,
  useEffect:(effect: typeof hooks.effect) => { hooks.effect = effect; }
}));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); hooks.entry = undefined; hooks.sequence.current = 0; });

it('expires a successful receipt and never lets an older timer dismiss a later notice', () => {
  vi.useFakeTimers(); vi.stubGlobal('window', { setTimeout, clearTimeout });
  useBoardNotice().flashNotice('成功');
  const first = useBoardNotice(); hooks.effect();
  vi.advanceTimersByTime(800);
  first.flashNotice('成功');
  expect(useBoardNotice().noticeKey).toBeGreaterThan(first.noticeKey); hooks.effect();
  vi.advanceTimersByTime(BOARD_NOTICE_DURATION - 800);
  expect(useBoardNotice().notice).toBe('成功');
  vi.advanceTimersByTime(800);
  expect(useBoardNotice().notice).toBe('');
  useBoardNotice().flashNotice('位置已保存');
  useBoardNotice(); hooks.effect();
  useBoardNotice().setNotice('保存失败，请重试');
  expect(useBoardNotice().transient).toBe(false); hooks.effect();
  vi.advanceTimersByTime(BOARD_NOTICE_DURATION * 2);
  expect(useBoardNotice().notice).toBe('保存失败，请重试');
});
