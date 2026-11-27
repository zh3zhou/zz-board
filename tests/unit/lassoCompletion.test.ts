import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { InkCanvas, type InkCanvasProps } from '../../src/web/InkCanvas.js';

// Exercise the real pointer handlers without a browser or a new DOM dependency.
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => [initial, vi.fn()],
  useRef: (current: unknown) => ({ current }),
  useMemo: (factory: () => unknown) => factory(),
  useEffect: () => undefined,
}));

function harness(patch: Partial<InkCanvasProps> = {}) {
  const calls: unknown[][] = [];
  const props: InkCanvasProps = {
    strokes: [{ id: 'ink:test', tool: 'pen', points: [{ x: 10, y: 10, pressure: .5 }, { x: 20, y: 20, pressure: .5 }], color: '#23201d', size: 2, opacity: 1, layer: 'foreground', zIndex: 1, revision: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01' }],
    tool: 'lasso', preset: { color: '#23201d', size: 2, opacity: 1, layer: 'foreground' },
    zoom: 1, selectedInkIds: [], eraserMode: 'whole', lassoMode: 'inkOnly',
    objectBounds: [{ id: 'note:test', bounds: { x: 10, y: 10, width: 10, height: 10 } }],
    screenToWorld: (point) => point,
    onCreateStroke: vi.fn(), onErase: vi.fn(),
    onSelectInk: (ids, mode) => calls.push(['ink', ids, mode]),
    onSelectObjects: (ids, mode) => calls.push(['objects', ids, mode]),
    onLassoComplete: () => calls.push(['select-tool']),
    ...patch,
  };
  const tree = InkCanvas(props) as ReactElement<{ children: ReactElement[] }>;
  const surface = tree.props.children.find((child) => child?.props && (child.props as { className?: string }).className?.startsWith('zz-ink-input'))!;
  const handlers = surface.props as Record<string, (event: unknown) => void>;
  const target = { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() };
  function fire(name: string, x: number, y: number, shiftKey = false, patch = {}) {
    handlers[name]({ button: 0, pointerId: 1, shiftKey, currentTarget: target,
      nativeEvent: { clientX: x, clientY: y, pointerType: 'mouse', pressure: .5 },
      preventDefault: vi.fn(), stopPropagation: vi.fn(), ...patch });
  }
  function circle(shiftKey = false) {
    fire('onPointerDown', 0, 0);
    fire('onPointerMove', 40, 0);
    fire('onPointerMove', 40, 40);
    fire('onPointerMove', 0, 40);
    fire('onPointerUp', 0, 0, shiftKey);
  }
  const portal = tree.props.children[0] as ReactElement<{ children: ReactElement }>;
  return { calls, fire, circle, target, layer: portal.props.children.props as Record<string, (...args: any[]) => void>, stroke: props.strokes[0] };
}

describe('lasso completion', () => {
  it('delivers ink selection before enabling select-tool controls', () => {
    const h = harness(); h.circle();
    expect(h.calls).toEqual([['ink', ['ink:test'], 'replace'], ['select-tool']]);
  });

  it('preserves Shift additive mode for both ink and objects before switching', () => {
    const h = harness({ lassoMode: 'includeObjects' }); h.circle(true);
    expect(h.calls).toEqual([['ink', ['ink:test'], 'add'], ['objects', ['note:test'], 'add'], ['select-tool']]);
  });

  it('returns to select even when a completed lasso hits nothing', () => {
    const h = harness({ strokes: [], objectBounds: [] }); h.circle();
    expect(h.calls).toEqual([['ink', [], 'replace'], ['select-tool']]);
  });

  it('does not switch or alter selection on cancel or an incomplete gesture', () => {
    const h = harness();
    h.fire('onPointerDown', 0, 0); h.fire('onPointerCancel', 0, 0); h.fire('onPointerUp', 0, 0);
    h.fire('onPointerDown', 0, 0); h.fire('onPointerUp', 1, 1);
    expect(h.calls).toEqual([]);
  });

  it('does not complete lasso while Space panning or using the pen', () => {
    const pan = harness({ panActive: true }); pan.circle();
    const pen = harness({ tool: 'pen' }); pen.circle();
    expect(pan.calls).toEqual([]);
    expect(pen.calls).toEqual([]);
  });

  it.each(['pen', 'highlighter', 'eraser', 'lasso'] as const)('does not overwrite or commit %s with a second touch', tool => {
    const create = vi.fn(), erase = vi.fn();
    const h = harness({ tool, onCreateStroke: create, onErase: erase });
    h.fire('onPointerDown', 10, 10, false, { pointerType: 'touch' });
    h.fire('onPointerDown', 20, 20, false, { pointerId: 2, pointerType: 'touch' });
    h.fire('onPointerUp', 20, 20, false, { pointerId: 2, pointerType: 'touch' });
    h.fire('onPointerCancel', 10, 10, false, { pointerType: 'touch' });
    h.fire('onPointerUp', 10, 10, false, { pointerType: 'touch' });
    expect(h.target.setPointerCapture).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled(); expect(erase).not.toHaveBeenCalled(); expect(h.calls).toEqual([]);
  });
});

describe('selection gesture guards', () => {
  const event = () => ({ button: 0, pointerId: 3, clientX: 10, clientY: 10, shiftKey: false,
    preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() } });
  it('does not start moving ink while panning or when the parent rejects the operation', () => {
    const onMoveStart = vi.fn(() => false); const onMoveEnd = vi.fn();
    const panning = harness({ tool: 'select', panActive: true, onMoveStart, onMoveEnd, onTransformSelected: vi.fn() });
    panning.layer.onPointerDown!(event(), panning.stroke); expect(onMoveStart).not.toHaveBeenCalled();
    const blocked = harness({ tool: 'select', onMoveStart, onMoveEnd, onTransformSelected: vi.fn() });
    const e = event(); blocked.layer.onPointerDown!(e, blocked.stroke); blocked.layer.onPointerUp!(e);
    expect(e.currentTarget.setPointerCapture).not.toHaveBeenCalled(); expect(onMoveEnd).not.toHaveBeenCalled();
  });
  it('clears a canceled move once and does not commit on a subsequent pointerup', () => {
    const onMoveCancel = vi.fn(); const onMoveEnd = vi.fn();
    const h = harness({ tool: 'select', onMoveStart: () => true, onMoveCancel, onMoveEnd, onTransformSelected: vi.fn() });
    h.layer.onPointerDown!(event(), h.stroke); h.layer.onPointerCancel!(); h.layer.onPointerCancel!(); h.layer.onPointerUp!(event());
    expect(onMoveCancel).toHaveBeenCalledTimes(1); expect(onMoveEnd).not.toHaveBeenCalled();
  });
});
