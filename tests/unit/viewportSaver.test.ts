import { afterEach, describe, expect, it, vi } from 'vitest';
import { createViewportSaver } from '../../src/web/viewportSaver.js';

afterEach(() => vi.useRealTimers());
const viewport = { x: 20, y: 30, zoom: 1.2 };
describe('viewport persistence lifecycle', () => {
  it('debounces and captures only the latest viewport', async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const saver = createViewportSaver({ online: () => true, save, failed: vi.fn() });
    saver.queue(viewport); await vi.advanceTimersByTimeAsync(300);
    const last = { ...viewport, x: 42 }; saver.queue(last); last.x = 999;
    await vi.advanceTimersByTimeAsync(499); expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(save).toHaveBeenCalledExactlyOnceWith({ ...viewport, x: 42 });
  });
  it.each(['offline', 'version-incompatible'])('does not write after the connection becomes %s', async state => {
    vi.useFakeTimers(); let connection = 'online'; const save = vi.fn();
    const saver = createViewportSaver({ online: () => connection === 'online', save, failed: vi.fn() });
    saver.queue(viewport); connection = state;
    await vi.advanceTimersByTimeAsync(500); expect(save).not.toHaveBeenCalled();
    saver.queue(viewport); await vi.advanceTimersByTimeAsync(500); expect(save).not.toHaveBeenCalled();
  });
  it.each(['cancel', 'dispose'] as const)('clears the timer on %s', async action => {
    vi.useFakeTimers(); const save = vi.fn();
    const saver = createViewportSaver({ online: () => true, save, failed: vi.fn() });
    saver.queue(viewport); saver[action]();
    expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(500); expect(save).not.toHaveBeenCalled();
  });
  it('survives effect cleanup/setup without reporting the old instance late error', async () => {
    vi.useFakeTimers(); let reject!: (error: Error) => void;
    const failed = vi.fn(), old = createViewportSaver({ online: () => true, failed, save: () => new Promise((_, fail) => { reject = fail; }) });
    old.queue(viewport); await vi.advanceTimersByTimeAsync(500); old.dispose();
    const save = vi.fn().mockResolvedValue(undefined), fresh = createViewportSaver({ online: () => true, save, failed });
    fresh.queue(viewport); reject(new Error('old request')); await vi.advanceTimersByTimeAsync(500);
    expect(failed).not.toHaveBeenCalled(); expect(save).toHaveBeenCalledExactlyOnceWith(viewport);
    old.queue(viewport); expect(vi.getTimerCount()).toBe(0);
  });
  it('reports current failures but ignores a cancelled in-flight failure', async () => {
    vi.useFakeTimers(); const error = new Error('write failed'), failed = vi.fn();
    const saver = createViewportSaver({ online: () => true, failed, save: async () => { throw error; } });
    saver.queue(viewport); await vi.advanceTimersByTimeAsync(500); expect(failed).toHaveBeenCalledExactlyOnceWith(error);
    let reject!: (error: Error) => void;
    const next = createViewportSaver({ online: () => true, failed, save: () => new Promise((_, fail) => { reject = fail; }) });
    next.queue(viewport); await vi.advanceTimersByTimeAsync(500); next.cancel(); reject(error);
    await vi.advanceTimersByTimeAsync(0); expect(failed).toHaveBeenCalledTimes(1);
  });
});
