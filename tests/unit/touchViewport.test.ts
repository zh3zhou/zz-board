import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTouchViewport, isCanvasTouchTarget, pinchViewport } from '../../src/web/touchViewport.js';

class Surface extends EventTarget {
  captures = new Set<number>();
  constructor(public selector: string, public parentElement: Surface | null = null) { super(); }
  closest(selectors: string): Surface | null {
    return selectors.split(',').some(selector => selector.trim() === this.selector) ? this : this.parentElement?.closest(selectors) || null;
  }
  contains(target: Surface): boolean { return target === this || !!target.parentElement && this.contains(target.parentElement); }
  hasPointerCapture(id: number) { return this.captures.has(id); }
  setPointerCapture(id: number) { this.captures.add(id); }
  releasePointerCapture(id: number) { this.captures.delete(id); }
  getBoundingClientRect() { return { left: 120, top: 90 }; }
  dispatchEvent(event: Event): boolean {
    if (this.parentElement && event.type === 'pointercancel') {
      // Capture phase before the child's cancellation handler, as in the DOM.
      Object.defineProperty(event, 'target', { value: this });
      let root: Surface = this; while (root.parentElement) root = root.parentElement;
      EventTarget.prototype.dispatchEvent.call(root, event);
      if (event.defaultPrevented) return false;
    }
    return super.dispatchEvent(event);
  }
}

class Pointer extends Event {
  constructor(type: string, fields: Record<string, unknown>) {
    const { bubbles, ...properties } = fields;
    super(type, { bubbles: bubbles !== false, cancelable: true }); Object.assign(this, properties);
  }
}

function harness() {
  const root = new Surface('.board-stage'), pane = new Surface('.react-flow__pane', root);
  const frames = new Map<number, FrameRequestCallback>(); let nextFrame = 0;
  const windowTarget = new EventTarget();
  vi.stubGlobal('window', Object.assign(windowTarget, {
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  }));
  let viewport = { x: -20, y: 30, zoom: 1 };
  const changed = vi.fn(view => { viewport = view; }), ended = vi.fn(), start = vi.fn(), active = vi.fn();
  const controller = installTouchViewport(root as unknown as HTMLElement, { getViewport: () => viewport, onStart: start, onChange: changed, onEnd: ended, onActive: active });
  function fire(type: string, id: number, x = 220, y = 190, target = pane, extra = {}) {
    const event = new Pointer(type, { pointerId: id, clientX: x, clientY: y, pointerType: 'touch', button: 0, ...extra });
    Object.defineProperty(event, 'target', { value: target }); root.dispatchEvent(event); return event;
  }
  function frame() { const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback(0)); }
  const begin = () => { fire('pointerdown', 1, 170, 190); fire('pointerdown', 2, 270, 190); };
  return { root, pane, windowTarget, frames, fire, frame, begin, start, changed, ended, active, controller, viewport: () => viewport };
}

beforeEach(() => { vi.stubGlobal('Element', Surface); vi.stubGlobal('PointerEvent', Pointer); vi.stubGlobal('performance', { now: () => 100 }); });
afterEach(() => vi.unstubAllGlobals());

describe('touchscreen viewport geometry', () => {
  it('anchors the midpoint in world coordinates while panning and pinching', () => {
    expect(pinchViewport({ center: { x: 100, y: 100 }, distance: 100, viewport: { x: -20, y: 30, zoom: 1 } }, { x: 110, y: 120 }, 200)).toEqual({ x: -130, y: -20, zoom: 2 });
  });
  it('clamps zoom without accumulating drift or jumping away from the fingers', () => {
    const start = { center: { x: 100, y: 100 }, distance: 100, viewport: { x: -20, y: 30, zoom: 1 } };
    const zoomed = pinchViewport(start, { x: 140, y: 130 }, 1000);
    expect(zoomed.zoom).toBe(2.2); expect((140 - zoomed.x) / zoomed.zoom).toBeCloseTo(120);
    const out = pinchViewport(start, { x: 140, y: 130 }, 1);
    expect(out.zoom).toBe(.2); expect((130 - out.y) / out.zoom).toBeCloseTo(70);
  });
});

describe('two-touch takeover', () => {
  it('leaves single-touch, pen, mouse and wheel to existing handlers', () => {
    const h = harness();
    expect(h.fire('pointerdown', 1).defaultPrevented).toBe(false);
    expect(h.fire('pointermove', 1).defaultPrevented).toBe(false);
    h.fire('pointerup', 1);
    h.fire('pointerdown', 2, 0, 0, h.pane, { pointerType: 'pen' });
    h.fire('pointerdown', 3, 0, 0, h.pane, { pointerType: 'mouse' });
    expect(h.fire('wheel', 0).defaultPrevented).toBe(false);
    expect(h.start).not.toHaveBeenCalled(); expect(h.changed).not.toHaveBeenCalled(); expect(h.ended).not.toHaveBeenCalled();
  });
  it('cancels the real ancestor capture and child preview before viewport changes', () => {
    const h = harness(), overlay = new Surface('.export-selector', h.root), corner = new Surface('.export-corner', overlay);
    const cancel = vi.fn(); overlay.addEventListener('pointercancel', cancel);
    h.fire('pointerdown', 1, 170, 190, corner); overlay.setPointerCapture(1);
    h.fire('pointerdown', 2, 270, 190, h.pane);
    expect(cancel).toHaveBeenCalledOnce(); expect(overlay.hasPointerCapture(1)).toBe(false);
    expect(h.start).toHaveBeenCalledOnce(); expect(h.changed).not.toHaveBeenCalled();
    expect(h.root.hasPointerCapture(1)).toBe(true); expect(h.root.hasPointerCapture(2)).toBe(true);
  });
  it('keeps uncaptured cancellation inside the canvas, never dispatching to an outside ancestor', () => {
    const h = harness(), outer = new Surface('.app-shell'); h.root.parentElement = outer;
    const cancel = vi.fn(); h.pane.addEventListener('pointercancel', cancel);
    h.begin(); expect(cancel).toHaveBeenCalledTimes(2);
  });
  it('coalesces movement and uses the offset canvas origin, not screen coordinates', () => {
    const h = harness(); h.begin();
    h.fire('pointermove', 1, 130, 210); h.fire('pointermove', 2, 330, 210);
    expect(h.changed).not.toHaveBeenCalled(); expect(h.frames.size).toBe(1);
    h.frame(); expect(h.changed).toHaveBeenCalledOnce(); expect(h.viewport()).toEqual({ x: -130, y: -20, zoom: 2 });
    h.fire('pointerup', 1, 130, 210); h.fire('pointerup', 2, 330, 210);
    expect(h.ended).toHaveBeenCalledOnce(); expect(h.ended).toHaveBeenCalledWith(h.viewport()); expect(h.frames.size).toBe(0);
  });
  it('flushes pending movement before saving and consumes delayed native end events', () => {
    const h = harness(); h.begin(); h.fire('pointermove', 2, 370, 190);
    h.fire('pointerup', 1, 170, 190); h.fire('pointerup', 2, 370, 190);
    const terminal = h.fire('touchend', 2);
    expect(h.controller.isActive()).toBe(false);
    expect(terminal.defaultPrevented).toBe(false); // native D3 still gets cleanup
    expect(h.controller.isConsumed(terminal)).toBe(true);
    expect(h.controller.isConsumed({ nativeEvent: terminal })).toBe(true);
    expect(h.controller.blocksNodeChanges()).toBe(true);
    const nativeSave = vi.fn(); if (!h.controller.isConsumed(terminal)) nativeSave();
    expect(nativeSave).not.toHaveBeenCalled(); expect(h.ended).toHaveBeenCalledOnce(); expect(h.viewport().zoom).toBe(2);
  });
  it('latches the remaining finger rather than turning it into a new edit', () => {
    const h = harness(); h.begin(); h.fire('pointerup', 2, 270, 190);
    expect(h.controller.isActive()).toBe(true);
    expect(h.fire('pointermove', 1, 190, 200).defaultPrevented).toBe(true);
    h.frame(); expect(h.changed).not.toHaveBeenCalled(); expect(h.ended).not.toHaveBeenCalled();
    expect(h.fire('pointerup', 1, 190, 200).defaultPrevented).toBe(true); expect(h.ended).toHaveBeenCalledOnce();
    expect(h.root.captures.size).toBe(0);
    expect(h.fire('pointerdown', 4).defaultPrevented).toBe(false); expect(h.controller.blocksNodeChanges()).toBe(false);
  });
  it('ignores a third contact until the original pair changes, then rebases without jumping', () => {
    const h = harness(); h.begin(); h.fire('pointerdown', 3, 300, 260); h.fire('pointermove', 3, 400, 260); h.frame();
    expect(h.changed).not.toHaveBeenCalled();
    h.fire('pointerup', 1, 170, 190); const before = h.viewport();
    h.fire('pointermove', 2, 270, 190); h.frame(); expect(h.viewport()).toEqual(before);
    h.fire('pointermove', 3, 420, 270); h.frame(); expect(h.viewport()).not.toEqual(before);
  });
  it('does not hijack a canvas touch combined with a button or editor touch', () => {
    const h = harness(); h.fire('pointerdown', 1);
    const button = new Surface('button', h.pane), editor = new Surface('[contenteditable="true"]', h.pane);
    expect(isCanvasTouchTarget(button)).toBe(false); expect(isCanvasTouchTarget(editor)).toBe(false);
    h.fire('pointerdown', 2, 250, 180, button); h.fire('pointerdown', 3, 280, 180, editor);
    expect(h.start).not.toHaveBeenCalled();
  });
  it.each(['.selection-scale-handle', '.selection-move-handle', '.bubble-resize-control', '.zz-link-bend'])('cancels %s in either touch order, rather than committing an edit', selector => {
    for (const handleFirst of [true, false]) {
      const h = harness(), handle = new Surface(selector, new Surface('button', h.pane));
      const cancel = vi.fn(); handle.addEventListener('pointercancel', cancel);
      h.fire('pointerdown', 1, 170, 190, handleFirst ? handle : h.pane);
      h.fire('pointerdown', 2, 270, 190, handleFirst ? h.pane : handle);
      expect(h.start).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce(); expect(h.controller.isActive()).toBe(true);
    }
  });
  it('prevents native touchmove and post-pinch activation, but preserves keyboard/mouse clicks', () => {
    const h = harness(); h.begin();
    expect(h.fire('touchmove', 1).defaultPrevented).toBe(true);
    h.fire('pointerup', 1, 170, 190); h.fire('pointerup', 2, 270, 190);
    expect(h.fire('click', 1, 220, 190, h.pane, { detail: 1 }).defaultPrevented).toBe(true);
    expect(h.fire('click', 0, 220, 190, h.pane, { detail: 0 }).defaultPrevented).toBe(false);
    expect(h.fire('click', 0, 220, 190, h.pane, { detail: 1, pointerType: 'mouse' }).defaultPrevented).toBe(false);
  });
  it('rebases coincident fingers instead of producing a scale spike', () => {
    const h = harness(); h.fire('pointerdown', 1); h.fire('pointerdown', 2);
    h.fire('pointermove', 2, 225, 190); h.frame(); expect(h.viewport().zoom).toBe(1);
    h.fire('pointermove', 2, 230, 190); h.frame(); expect(h.viewport().zoom).toBe(2);
  });
  it('flushes and releases on blur; unmount cancels pending callbacks', () => {
    const h = harness(); h.begin(); h.fire('pointermove', 2, 370, 190);
    h.windowTarget.dispatchEvent(new Event('blur')); expect(h.ended).toHaveBeenCalledOnce(); expect(h.root.captures.size).toBe(0);
    const other = harness(); other.begin(); other.fire('pointermove', 2, 370, 190); other.controller.dispose(); other.frame();
    expect(other.changed).not.toHaveBeenCalled(); expect(other.ended).not.toHaveBeenCalled();
    expect(other.root.captures.size).toBe(0);
    expect(other.fire('pointerdown', 3).defaultPrevented).toBe(false);
  });
});

it('connects touch cleanup guards to native node and delayed viewport callbacks', () => {
  const app = fs.readFileSync(new URL('../../src/web/App.tsx', import.meta.url), 'utf8');
  expect(app).toContain("change.type === 'dimensions' && change.resizing !== undefined");
  expect(app).toContain('touchViewportRef.current?.blocksNodeChanges()');
  expect(app).toMatch(/function persistResize[\s\S]*?isConsumed\(sourceEvent\)\) return/);
  expect(app).toMatch(/const onNodeDragStop[\s\S]*?isConsumed\(_event\)\) return/);
  expect(app).toMatch(/onMoveEnd=\{[\s\S]*?isConsumed\(_event\)\) return/);
  expect(app).toContain('zoomOnDoubleClick={false}');
  expect(app).toContain('autoPanOnNodeDrag={!touchNavigating}');
});
