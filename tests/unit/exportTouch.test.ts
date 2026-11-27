import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ExportRegion } from '../../src/web/ExportRegion.js';

const initialRect = { x: 10, y: 20, width: 200, height: 100 };
const setRect = vi.fn(); let stateIndex = 0;
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(), useRef: (current: unknown) => ({ current }), useEffect: () => {},
  useState: (initial: unknown) => [stateIndex++ === 0 ? initialRect : initial, stateIndex === 1 ? setRect : vi.fn()],
}));

function harness() {
  stateIndex = 0; setRect.mockClear();
  const tree = ExportRegion({ nodes: [], edges: [], strokes: [], viewport: { x: 0, y: 0, zoom: 1 }, panActive: false, toWorld: point => point, onClose: vi.fn(), onNotice: vi.fn(), onViewport: vi.fn() }) as ReactElement<{ children: ReactElement[] }>;
  const handlers = tree.props.children[0].props as Record<string, (event: unknown) => void>;
  const target = { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() };
  const fire = (name: string, id: number, x = 20, y = 30) => handlers[name]({ button: 0, pointerId: id, pointerType: 'touch', clientX: x, clientY: y,
    target: { dataset: { handle: 'move' } }, currentTarget: target, stopPropagation: vi.fn(), preventDefault: vi.fn() });
  return { fire, target };
}

describe('export selection touch identity', () => {
  it('does not let a second finger overwrite, move or finish the first drag', () => {
    const h = harness(); h.fire('onPointerDown', 1); h.fire('onPointerDown', 2);
    h.fire('onPointerMove', 2, 50, 60); h.fire('onPointerUp', 2);
    expect(setRect).not.toHaveBeenCalled(); expect(h.target.setPointerCapture).toHaveBeenCalledOnce();
    h.fire('onPointerMove', 1, 30, 40); expect(setRect).toHaveBeenLastCalledWith({ ...initialRect, x: 20, y: 30 });
  });
  it('restores the saved range and releases capture when pinch cancels the draft', () => {
    const h = harness(); h.fire('onPointerDown', 1); h.fire('onPointerMove', 1, 30, 40);
    h.fire('onPointerCancel', 1); expect(setRect).toHaveBeenLastCalledWith(initialRect);
    expect(h.target.releasePointerCapture).toHaveBeenCalledWith(1);
    setRect.mockClear(); h.fire('onPointerMove', 1, 40, 50); h.fire('onPointerUp', 1); expect(setRect).not.toHaveBeenCalled();
  });
});
