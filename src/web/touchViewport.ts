import type { Viewport } from '@xyflow/react';

type Point = { x: number; y: number };
type Contact = Point & { target: Element };
type Pinch = { ids: [number, number]; center: Point; distance: number; viewport: Viewport };

/** Absolute, midpoint-anchored transform: no accumulated deltas at the zoom limits. */
export function pinchViewport(start: { center: Point; distance: number; viewport: Viewport }, center: Point, distance: number): Viewport {
  const zoom = Math.max(.2, Math.min(2.2, start.viewport.zoom * distance / Math.max(start.distance, 4)));
  return {
    x: center.x - (start.center.x - start.viewport.x) / start.viewport.zoom * zoom,
    y: center.y - (start.center.y - start.viewport.y) / start.viewport.zoom * zoom,
    zoom,
  };
}

export function isCanvasTouchTarget(target: EventTarget | null): target is Element {
  if (!(target instanceof Element)) return false;
  if (target.closest('.selection-scale-handle, .selection-move-handle, .bubble-resize-control, .zz-link-bend')) return true;
  return !target.closest('button, input, textarea, select, [contenteditable="true"], .note-tools, .note-scroll-rail, .note-scroll-viewport.is-scrollable, .zz-tool-palette, .export-toolbar, .react-flow__controls, .react-flow__minimap')
    && !!target.closest('.react-flow__pane, .react-flow__node, .zz-ink-input, .zz-ink-world, .selection-outline, .export-selector');
}

/** Two fingers own the viewport, not a note/ink/export edit. One finger, mouse,
 * pen and wheel continue through their existing handlers. Touch events are also
 * gated because ReactFlow's D3 listeners use them alongside Pointer Events. */
export function installTouchViewport(root: HTMLElement, callbacks: {
  getViewport(): Viewport;
  onStart(): void;
  onChange(viewport: Viewport): void;
  onEnd(viewport: Viewport): void;
  onActive(active: boolean): void;
}) {
  const contacts = new Map<number, Contact>();
  const consumed = new WeakSet<object>();
  let active = false, cancelling = false, pending: Viewport | null = null, frame: number | null = null;
  let pinch: Pinch | null = null, last: Viewport | null = null, cleanupUntil = 0;

  function consume(event: Event) { consumed.add(event); event.preventDefault(); event.stopImmediatePropagation(); }
  function flush() {
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    if (pending) { last = pending; pending = null; callbacks.onChange(last); }
  }
  function rebase() {
    flush();
    const ids = [...contacts.keys()].slice(0, 2) as [number, number];
    if (ids.length < 2) { pinch = null; return; }
    const geometry = points(ids);
    pinch = { ids, ...geometry, viewport: last || callbacks.getViewport() };
  }
  function points(ids: [number, number]) {
    const [a, b] = ids.map(id => contacts.get(id)!);
    const bounds = root.getBoundingClientRect();
    return { center: { x: (a.x + b.x) / 2 - bounds.left, y: (a.y + b.y) / 2 - bounds.top }, distance: Math.hypot(a.x - b.x, a.y - b.y) };
  }
  function cancelChild(id: number, contact: Contact) {
    let owner: Element | null = contact.target;
    while (owner && root.contains(owner) && !owner.hasPointerCapture?.(id)) owner = owner.parentElement;
    if (owner && !root.contains(owner)) owner = null;
    const target = owner || contact.target;
    // The injected cancellation must reach React handlers before the takeover
    // gate blocks subsequent real pointer events. Captures can belong to an ancestor.
    cancelling = true;
    try {
      target.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: id, pointerType: 'touch', clientX: contact.x, clientY: contact.y }));
      if (owner?.hasPointerCapture(id)) owner.releasePointerCapture(id);
    } finally { cancelling = false; }
  }
  function down(event: PointerEvent) {
    if (event.pointerType !== 'touch') { cleanupUntil = 0; return; }
    if (!isCanvasTouchTarget(event.target)) return;
    if (!active && contacts.size === 0) cleanupUntil = 0;
    contacts.set(event.pointerId, { x: event.clientX, y: event.clientY, target: event.target });
    if (contacts.size < 2 && !active) return;
    if (!active) {
      last = callbacks.getViewport();
      for (const [id, contact] of contacts) cancelChild(id, contact);
      callbacks.onStart();
      active = true; callbacks.onActive(true); rebase();
    }
    for (const id of contacts.keys()) if (!root.hasPointerCapture(id)) root.setPointerCapture(id);
    consume(event);
  }
  function move(event: PointerEvent) {
    const contact = contacts.get(event.pointerId);
    if (!contact || cancelling) return;
    contact.x = event.clientX; contact.y = event.clientY;
    if (!active) return;
    consume(event);
    if (!pinch || !pinch.ids.includes(event.pointerId)) return;
    const geometry = points(pinch.ids);
    // Coincident starting contacts need a new baseline, not an enormous ratio.
    if (pinch.distance < 4) { if (geometry.distance >= 4) rebase(); return; }
    const next = pinchViewport(pinch, geometry.center, geometry.distance);
    const previous = pending || last;
    if (previous && next.x === previous.x && next.y === previous.y && next.zoom === previous.zoom) return;
    pending = next;
    if (frame === null) frame = window.requestAnimationFrame(() => { frame = null; flush(); });
  }
  function end(event: PointerEvent) {
    if (cancelling || !contacts.has(event.pointerId)) return;
    if (active) {
      if (event.type === 'pointerup') move(event);
      consume(event);
    }
    if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
    contacts.delete(event.pointerId);
    if (!active) return;
    if (pinch?.ids.includes(event.pointerId)) rebase();
    if (contacts.size === 0) finish();
  }
  function finish() {
    flush(); pinch = null;
    for (const id of contacts.keys()) if (root.hasPointerCapture(id)) root.releasePointerCapture(id);
    contacts.clear();
    if (active) {
      active = false; cleanupUntil = performance.now() + 500;
      callbacks.onActive(false);
      if (last) callbacks.onEnd(last);
    }
    last = null;
  }
  function touch(event: TouchEvent) {
    if (active || performance.now() < cleanupUntil && isCanvasTouchTarget(event.target)) {
      consumed.add(event);
      // Let terminal touch events reach D3 so it releases its own gesture.
      // Their identities remain consumed for delayed drag/viewport callbacks.
      if (event.type === 'touchstart' || event.type === 'touchmove') consume(event);
    }
  }
  function click(event: MouseEvent) {
    if (performance.now() >= cleanupUntil || event.detail === 0 || !isCanvasTouchTarget(event.target)) return;
    const type = (event as PointerEvent).pointerType;
    if (!type || type === 'touch') consume(event);
  }
  const listeners: [string, EventListener][] = [
    ['pointerdown', down as EventListener], ['pointermove', move as EventListener],
    ['pointerup', end as EventListener], ['pointercancel', end as EventListener],
    ['touchstart', touch as EventListener], ['touchmove', touch as EventListener],
    ['touchend', touch as EventListener], ['touchcancel', touch as EventListener],
    ['click', click as EventListener], ['dblclick', click as EventListener],
  ];
  for (const [name, handler] of listeners) root.addEventListener(name, handler, { capture: true, passive: false });
  window.addEventListener('blur', finish);
  return {
    isActive: () => active,
    blocksNodeChanges: () => active || performance.now() < cleanupUntil,
    isConsumed(event: unknown) {
      if (!event || typeof event !== 'object') return false;
      const native = 'nativeEvent' in event ? event.nativeEvent : event;
      return !!native && typeof native === 'object' && consumed.has(native);
    },
    dispose() {
      for (const [name, handler] of listeners) root.removeEventListener(name, handler, true);
      window.removeEventListener('blur', finish);
      // Unmount cancels scheduled work; never call into the removed scene.
      if (frame !== null) window.cancelAnimationFrame(frame);
      for (const id of contacts.keys()) if (root.hasPointerCapture(id)) root.releasePointerCapture(id);
      frame = null; pending = null; contacts.clear(); active = false;
    },
  };
}
