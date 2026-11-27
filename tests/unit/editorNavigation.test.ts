import { describe, expect, it, vi } from 'vitest';
import { finishCanvasEditors, registerEditorExit } from '../../src/web/editorNavigation.js';

describe('page navigation editor barrier', () => {
  it('waits for an in-flight editor upload before allowing navigation', async () => {
    let finish!: () => void;
    const upload = new Promise<void>(resolve => { finish = resolve; });
    const exit = vi.fn(async () => { await upload; return true; });
    const unregister = registerEditorExit(exit);
    let complete = false;
    const task = finishCanvasEditors().then(value => { complete = value; });
    await Promise.resolve(); expect(complete).toBe(false);
    finish(); await task; expect(complete).toBe(true); unregister();
  });
  it('does not navigate when an editor is composing or has failed recovery', async () => {
    const unregister = registerEditorExit(async () => false);
    expect(await finishCanvasEditors()).toBe(false);
    unregister(); expect(await finishCanvasEditors()).toBe(true);
  });
});
