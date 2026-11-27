import { describe, expect, it, vi } from 'vitest';
import { installExportReturnControls } from '../../src/web/ExportRegion.js';

function event(type: string, properties: Record<string, unknown> = {}) {
  return Object.assign(new Event(type, { cancelable: true }), properties);
}

describe('export return controls', () => {
  it('uses one return action for Escape and context menu and never propagates either', () => {
    const target = new EventTarget(), back = vi.fn(), canvasMenu = vi.fn();
    const remove = installExportReturnControls(target, back);
    target.addEventListener('contextmenu', canvasMenu);
    const menu = event('contextmenu'), escape = event('keydown', { key: 'Escape' });
    target.dispatchEvent(menu); target.dispatchEvent(escape);
    expect(back).toHaveBeenCalledTimes(2);
    expect(canvasMenu).not.toHaveBeenCalled();
    expect(menu.defaultPrevented && escape.defaultPrevented).toBe(true);
    remove();
  });

  it('blocks right pointer down/up before canvas gestures without returning twice', () => {
    const target = new EventTarget(), back = vi.fn(), gesture = vi.fn();
    const remove = installExportReturnControls(target, back);
    target.addEventListener('pointerdown', gesture); target.addEventListener('pointerup', gesture);
    target.dispatchEvent(event('pointerdown', { button: 2 }));
    target.dispatchEvent(event('pointerup', { button: 2 }));
    expect(gesture).not.toHaveBeenCalled(); expect(back).not.toHaveBeenCalled();
    target.dispatchEvent(event('contextmenu')); expect(back).toHaveBeenCalledOnce();
    target.dispatchEvent(event('pointerdown', { button: 0 })); expect(gesture).toHaveBeenCalledOnce();
    target.dispatchEvent(event('keydown', { key: ' ' })); expect(back).toHaveBeenCalledOnce();
    remove();
  });

  it('preserves the three-level return contract while a generation cancellation settles', () => {
    const target = new EventTarget(); let stage: 'generating' | 'preview' | 'selecting' = 'generating';
    const controller = new AbortController(), close = vi.fn();
    const remove = installExportReturnControls(target, () => {
      if (stage === 'generating') controller.abort();
      else if (stage === 'preview') stage = 'selecting';
      else close();
    });
    target.dispatchEvent(event('contextmenu')); expect(controller.signal.aborted).toBe(true); expect(close).not.toHaveBeenCalled();
    stage = 'preview'; target.dispatchEvent(event('keydown', { key: 'Escape' })); expect(stage).toBe('selecting');
    target.dispatchEvent(event('contextmenu')); expect(close).toHaveBeenCalledOnce();
    remove();
  });
});
