import { useEffect, useRef } from 'react';
import { ViewportPortal } from '@xyflow/react';
import type { InkRect } from './inkGeometry.js';
import { cornerScale, type SelectionScale } from '../shared/selectionScale.js';

/** World-space outline; only the small move handle captures input. */
export function SelectionOverlay({ bounds, zoom, count, onBegin, onPreview, onEnd, onCancel, onDelete, toWorld, scaleFactor, onBeginScale, onScalePreview, onScaleEnd }: {
  bounds: InkRect; zoom: number; count: number; toWorld(point: { x: number; y: number }): { x: number; y: number };
  onBegin(): boolean; onPreview(delta: { x: number; y: number }): void; onEnd(delta: { x: number; y: number }): void;
  onCancel(): void; onDelete(): void;
  scaleFactor?: number; onBeginScale(): { min: number; max: number } | null;
  onScalePreview(transform: SelectionScale): void; onScaleEnd(transform: SelectionScale): void;
}) {
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const scaling = useRef<{ id: number; origin: { x: number; y: number }; corner: { x: number; y: number }; limits: { min: number; max: number } } | null>(null);
  const cancel = useRef(onCancel); cancel.current = onCancel;
  useEffect(() => {
    const stop = () => { if (drag.current || scaling.current) { drag.current = null; scaling.current = null; cancel.current(); } };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') stop(); };
    window.addEventListener('keydown', key); window.addEventListener('blur', stop);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('blur', stop); stop(); };
  }, []);
  return <ViewportPortal><div className="selection-outline" style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height, borderWidth: 1 / zoom }}>
    {(['nw', 'ne', 'sw', 'se'] as const).map(corner => <button key={corner} className={`selection-scale-handle ${corner} nodrag nopan`} aria-label="等比例缩放整个选区" title="拖动角落，整体等比例缩放" style={{ transform: `translate(-50%, -50%) scale(${1 / zoom})` }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        const limits = onBeginScale(); if (!limits) return;
        event.preventDefault(); event.stopPropagation();
        const point = { x: bounds.x + (corner.includes('e') ? bounds.width : 0), y: bounds.y + (corner.includes('s') ? bounds.height : 0) };
        scaling.current = { id: event.pointerId, corner: point, origin: { x: bounds.x * 2 + bounds.width - point.x, y: bounds.y * 2 + bounds.height - point.y }, limits };
        event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={event => {
        const state = scaling.current; if (!state || state.id !== event.pointerId) return;
        onScalePreview(cornerScale(state.origin, state.corner, toWorld({ x: event.clientX, y: event.clientY }), state.limits));
      }} onPointerUp={event => {
        const state = scaling.current; if (!state || state.id !== event.pointerId) return;
        scaling.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        onScaleEnd(cornerScale(state.origin, state.corner, toWorld({ x: event.clientX, y: event.clientY }), state.limits));
      }} onPointerCancel={() => { if (scaling.current) { scaling.current = null; onCancel(); } }} onLostPointerCapture={() => { if (scaling.current) { scaling.current = null; onCancel(); } }} />)}
    <div className="selection-actions nodrag nopan" style={{ transform: `scale(${1 / zoom})` }}>
      <button className="selection-move-handle" aria-label={`移动选区，共 ${count} 项`} onPointerDown={(event) => {
        if (event.button !== 0 || !onBegin()) return;
        event.preventDefault(); event.stopPropagation();
        const point = toWorld({ x: event.clientX, y: event.clientY });
        drag.current = { id: event.pointerId, ...point }; event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={(event) => {
        if (drag.current?.id !== event.pointerId) return;
        const point = toWorld({ x: event.clientX, y: event.clientY }); onPreview({ x: point.x - drag.current.x, y: point.y - drag.current.y });
      }} onPointerUp={(event) => {
        if (drag.current?.id !== event.pointerId) return;
        const point = toWorld({ x: event.clientX, y: event.clientY }); const delta = { x: point.x - drag.current.x, y: point.y - drag.current.y };
        drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); onEnd(delta);
      }} onPointerCancel={() => { if (drag.current) { drag.current = null; onCancel(); } }}
      onLostPointerCapture={() => { if (drag.current) { drag.current = null; onCancel(); } }}>移动 · {count}</button>
      <button aria-label="删除墨迹并归档选中便签" title="项目气泡会保留；可撤销" onClick={onDelete}>×</button>
      {scaleFactor !== undefined && <span className="selection-scale-value" role="status">{Math.round(scaleFactor * 100)}%</span>}
    </div>
  </div></ViewportPortal>;
}
