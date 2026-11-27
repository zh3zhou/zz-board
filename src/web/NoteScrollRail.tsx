import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

/** The paper contains the native scroller. Only this handle sits outside its clipped edge. */
export function NoteScrollRail({ viewport, viewportId }: { viewport: RefObject<HTMLDivElement | null>; viewportId: string }) {
  const [metrics, setMetrics] = useState({ height: 0, limit: 0, top: 0 });
  const grab = useRef<{ pointer: number; offset: number } | null>(null);
  useLayoutEffect(() => {
    const body = viewport.current;
    if (!body) return;
    const measure = () => {
      const height = body.clientHeight, limit = Math.max(0, body.scrollHeight - height), top = body.scrollTop;
      setMetrics(old => old.height === height && old.limit === limit && old.top === top ? old : { height, limit, top });
    };
    const resize = new ResizeObserver(measure);
    resize.observe(body);
    if (body.firstElementChild) resize.observe(body.firstElementChild);
    body.addEventListener('scroll', measure, { passive: true });
    measure();
    return () => {
      resize.disconnect();
      body.removeEventListener('scroll', measure);
      body.scrollTop = 0;
    };
  }, [viewport]);

  const { height, limit, top } = metrics;
  if (!height || limit < 1) return null;
  const thumbSize = Math.min(0.95, Math.max(18 / height, height / (height + limit)));
  const thumbTop = (1 - thumbSize) * Math.min(1, Math.max(0, top / limit));

  function move(event: PointerEvent<HTMLDivElement>, offset: number) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (viewport.current && rect.height) viewport.current.scrollTop = (event.clientY - rect.top - offset) * limit / (rect.height * (1 - thumbSize));
  }

  function start(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || grab.current) return;
    // Keep focus and live text composition in the editor while dragging.
    event.preventDefault(); event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const position = event.clientY - rect.top - rect.height * thumbTop;
    const length = rect.height * thumbSize;
    const offset = position >= 0 && position <= length ? position : length / 2;
    grab.current = { pointer: event.pointerId, offset };
    event.currentTarget.setPointerCapture(event.pointerId);
    move(event, offset);
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' || event.key === 'Tab') return;
    event.stopPropagation();
    const body = viewport.current;
    if (!body) return;
    const positions: Record<string, number> = { ArrowUp: body.scrollTop - 24, ArrowDown: body.scrollTop + 24,
      PageUp: body.scrollTop - height, PageDown: body.scrollTop + height, Home: 0, End: limit,
      ' ': body.scrollTop + (event.shiftKey ? -height : height) };
    const next = positions[event.key];
    if (typeof next === 'number') { event.preventDefault(); body.scrollTop = next; }
  }

  return <div className="note-scroll-rail nodrag nopan nowheel" role="scrollbar" aria-label="滚动便签正文" aria-controls={viewportId}
    aria-orientation="vertical" aria-valuemin={0} aria-valuemax={Math.round(limit)} aria-valuenow={Math.round(top)}
    tabIndex={0} data-export-exclude onKeyDown={keyDown} onPointerDown={start}
    onPointerMove={event => { if (grab.current?.pointer === event.pointerId) move(event, grab.current.offset); }}
    onLostPointerCapture={() => { grab.current = null; }} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onWheel={event => { event.stopPropagation(); if (viewport.current) viewport.current.scrollTop += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1); }}>
    <span style={{ top: `${thumbTop * 100}%`, height: `${thumbSize * 100}%` }} />
  </div>;
}
