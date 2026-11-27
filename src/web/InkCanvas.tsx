import { ViewportPortal } from '@xyflow/react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { InkPoint, InkStrokeRecord } from '../shared/schema.js';
import {
  cachedStrokeSvgPath, cullInkStrokes, lassoSelectStrokes, normalizePointerPressure, precisionErase,
  rectIntersectsPolygon, selectionBounds, strokeSvgPath, transformInkStroke, wholeEraserHit,
  type InkRect, type InkTransform
} from './inkGeometry.js';
import './ink.css';
import { ColorPalette } from './ColorPalette.js';

export type InkCanvasTool = 'select' | 'pen' | 'highlighter' | 'eraser' | 'lasso';
export type InkEraserMode = 'whole' | 'precision';
export type InkLassoMode = 'inkOnly' | 'includeObjects';

export interface InkPreset {
  color: string;
  size: number;
  opacity: number;
  layer: 'background' | 'foreground';
}

export interface NewInkStroke {
  id: string;
  tool: 'pen' | 'highlighter';
  points: InkPoint[];
  color: string;
  size: number;
  opacity: number;
  layer: 'background' | 'foreground';
  zIndex: number;
}

export interface InkEraseAction {
  strokeId: string;
  revision: number;
  mode: InkEraserMode;
  remaining: InkPoint[][];
}

export interface InkTransformUpdate {
  id: string;
  revision: number;
  points: InkPoint[];
  size: number;
}

export interface InkObjectBounds {
  id: string;
  bounds: InkRect;
}

export interface InkCanvasProps {
  strokes: InkStrokeRecord[];
  tool: InkCanvasTool;
  preset: InkPreset;
  zoom: number;
  viewportBounds?: InkRect;
  selectedInkIds: string[];
  externalSelectionOverlay?: boolean;
  eraserMode: InkEraserMode;
  lassoMode: InkLassoMode;
  eraserRadius?: number;
  panActive?: boolean;
  objectBounds?: InkObjectBounds[];
  screenToWorld(point: { x: number; y: number }): { x: number; y: number };
  onCreateStroke(stroke: NewInkStroke): void | Promise<void>;
  onErase(actions: InkEraseAction[]): void | Promise<void>;
  onSelectInk(ids: string[], mode: 'replace' | 'add' | 'toggle'): void;
  onSelectObjects?(ids: string[], mode: 'replace' | 'add'): void;
  onLassoComplete(): void;
  onMoveStart?(ids: string[]): boolean;
  onMovePreview?(delta: { x: number; y: number }): void;
  onMoveEnd?(delta: { x: number; y: number }): void;
  onMoveCancel?(): void;
  onTransformSelected?(updates: InkTransformUpdate[]): void | Promise<void>;
  onStyleSelected?(ids: string[], patch: { color?: string; layer?: 'background' | 'foreground' }): void | Promise<void>;
  onDeleteSelected?(ids: string[]): void | Promise<void>;
}

interface SelectionGesture {
  kind: 'move' | 'scale';
  pointerId: number;
  startClient: { x: number; y: number };
  bounds: InkRect;
  strokes: InkStrokeRecord[];
}

const DEFAULT_ERASER_RADIUS = 10;

export function InkCanvas({
  strokes, tool, preset, zoom, viewportBounds, selectedInkIds, eraserMode, lassoMode,
  eraserRadius = DEFAULT_ERASER_RADIUS, panActive = false, objectBounds = [], screenToWorld, externalSelectionOverlay = false,
  onCreateStroke, onErase, onSelectInk, onSelectObjects, onLassoComplete, onMoveStart, onMovePreview, onMoveEnd, onMoveCancel, onTransformSelected, onStyleSelected, onDeleteSelected
}: InkCanvasProps) {
  const [gesturePoints, setGesturePoints] = useState<InkPoint[]>([]);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Record<string, InkStrokeRecord>>({});
  const [pending, setPending] = useState<InkStrokeRecord[]>([]);
  const [failedIds, setFailedIds] = useState<string[]>([]);
  const savingIds = useRef(new Set<string>());
  const gestureId = useRef('');
  const gesturePointsRef = useRef<InkPoint[]>([]);
  const drawPointerRef = useRef<number | null>(null);
  const selectionGestureRef = useRef<SelectionGesture | null>(null);
  const selectionTransformRef = useRef<InkTransform | null>(null);
  const cancelCallback = useRef(onMoveCancel);
  cancelCallback.current = onMoveCancel;
  useEffect(() => {
    if (tool !== 'select' || panActive) cancelSelectionGesture();
  }, [tool, panActive]);
  useEffect(() => () => {
    if (selectionGestureRef.current?.kind === 'move') cancelCallback.current?.();
  }, []);

  useEffect(() => {
    setPreview({});
    const acknowledged = new Set(strokes.map((stroke) => stroke.id));
    setPending((current) => current.filter((stroke) => !acknowledged.has(stroke.id)));
    setFailedIds((current) => current.filter((id) => !acknowledged.has(id)));
  }, [strokes]);

  const allStrokes = useMemo(() => mergePendingInk(strokes, pending), [strokes, pending]);
  const visibleStrokes = useMemo(
    () => viewportBounds ? cullInkStrokes(allStrokes, viewportBounds, zoom) : allStrokes,
    [allStrokes, viewportBounds, zoom]
  );
  const rendered = useMemo(
    () => visibleStrokes.map((stroke) => preview[stroke.id] ?? stroke).sort(compareStrokes),
    [preview, visibleStrokes]
  );
  const selected = useMemo(
    () => selectedInkIds.map((id) => preview[id] ?? strokes.find((stroke) => stroke.id === id)).filter((stroke): stroke is InkStrokeRecord => Boolean(stroke)),
    [preview, selectedInkIds, strokes]
  );
  const selectedBounds = useMemo(() => selectionBounds(selected), [selected]);
  const layerBounds = useMemo(() => expandRect(viewportBounds || fallbackLayerBounds(allStrokes), Math.max(48, 128 / Math.max(zoom, 0.05))), [allStrokes, viewportBounds, zoom]);
  const draftStroke = useMemo<NewInkStroke | null>(() => {
    if ((tool !== 'pen' && tool !== 'highlighter') || gesturePoints.length === 0) return null;
    return { id: gestureId.current, tool, points: gesturePoints, color: preset.color, size: preset.size, opacity: preset.opacity, layer: preset.layer, zIndex: topInkZ(allStrokes) + 1 };
  }, [gesturePoints, preset, allStrokes, tool]);

  async function submitStroke(stroke: InkStrokeRecord) {
    if (savingIds.current.has(stroke.id)) return;
    savingIds.current.add(stroke.id);
    setFailedIds((current) => current.filter((id) => id !== stroke.id));
    const { revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = stroke;
    try { await onCreateStroke(input); }
    catch { setFailedIds((current) => current.includes(stroke.id) ? current : [...current, stroke.id]); }
    finally { savingIds.current.delete(stroke.id); }
  }

  const captureMode = !panActive && (tool === 'pen' || tool === 'highlighter' || tool === 'eraser' || tool === 'lasso');

  function collectPointerPoints(event: ReactPointerEvent<HTMLElement>): InkPoint[] {
    const native = event.nativeEvent;
    const samples = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [native];
    return samples.map((sample) => {
      const world = screenToWorld({ x: sample.clientX, y: sample.clientY });
      return { x: world.x, y: world.y, pressure: normalizePointerPressure(sample.pointerType, sample.pressure) };
    });
  }

  function appendGesturePoints(next: InkPoint[]) {
    gesturePointsRef.current = appendAndReturn(gesturePointsRef.current, next);
    setGesturePoints(gesturePointsRef.current);
  }

  function handleSurfacePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!captureMode || event.button !== 0 || drawPointerRef.current !== null || event.pointerType === 'touch' && event.isPrimary === false) return;
    event.preventDefault();
    event.stopPropagation();
    drawPointerRef.current = event.pointerId;
    gestureId.current = `ink:${crypto.randomUUID()}`;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesturePointsRef.current = collectPointerPoints(event);
    setGesturePoints(gesturePointsRef.current);
  }

  function handleSurfacePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (drawPointerRef.current !== event.pointerId) return;
    event.preventDefault();
    appendGesturePoints(collectPointerPoints(event));
  }

  function handleSurfacePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (drawPointerRef.current !== event.pointerId) return;
    event.preventDefault();
    const finalPoints = appendAndReturn(gesturePointsRef.current, collectPointerPoints(event));
    drawPointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setGesturePoints([]);
    gesturePointsRef.current = [];
    if (tool === 'pen' || tool === 'highlighter') {
      if (finalPoints.length > 0) {
        const now = new Date().toISOString();
        const stroke: InkStrokeRecord = { ...preset, id: gestureId.current, tool, points: finalPoints, zIndex: topInkZ(allStrokes) + 1, revision: 0, createdAt: now, updatedAt: now };
        setPending((current) => [...current, stroke]);
        void submitStroke(stroke);
      }
      return;
    }
    if (tool === 'eraser') {
      const actions = strokes.flatMap((stroke): InkEraseAction[] => {
        if (!wholeEraserHit(stroke, finalPoints, eraserRadius)) return [];
        const remaining = eraserMode === 'precision' ? precisionErase(stroke, finalPoints, eraserRadius).remaining : [];
        return [{ strokeId: stroke.id, revision: stroke.revision, mode: eraserMode, remaining }];
      });
      if (actions.length > 0) void onErase(actions);
      return;
    }
    if (tool === 'lasso' && finalPoints.length >= 3) {
      onSelectInk(lassoSelectStrokes(strokes, finalPoints), event.shiftKey ? 'add' : 'replace');
      if (lassoMode === 'includeObjects' && onSelectObjects) {
        onSelectObjects(objectBounds.filter((item) => rectIntersectsPolygon(item.bounds, finalPoints)).map((item) => item.id), event.shiftKey ? 'add' : 'replace');
      }
      // Keep the result selected while enabling its move/delete controls.
      onLassoComplete();
    }
  }

  function handleSurfacePointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    if (drawPointerRef.current !== event.pointerId) return;
    drawPointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setGesturePoints([]);
    gesturePointsRef.current = [];
  }

  function handleStrokePointerDown(event: ReactPointerEvent<SVGPathElement>, stroke: InkStrokeRecord) {
    if (tool !== 'select' || panActive || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const alreadySelected = selectedInkIds.includes(stroke.id);
    if (event.shiftKey) {
      onSelectInk([stroke.id], 'toggle');
      return;
    }
    const ids = alreadySelected ? selectedInkIds : [stroke.id];
    if (!alreadySelected) onSelectInk(ids, 'replace');
    const targets = ids.map((id) => strokes.find((candidate) => candidate.id === id)).filter((candidate): candidate is InkStrokeRecord => Boolean(candidate));
    const bounds = selectionBounds(targets);
    if (!bounds || !onTransformSelected) return;
    if (onMoveStart && !onMoveStart(ids)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    selectionTransformRef.current = null;
    selectionGestureRef.current = {
      kind: 'move', pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, bounds, strokes: targets
    };
  }

  function handleSelectionPointerMove(event: ReactPointerEvent<SVGElement>) {
    const gesture = selectionGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const start = screenToWorld(gesture.startClient);
    const current = screenToWorld({ x: event.clientX, y: event.clientY });
    const transform = gesture.kind === 'move'
      ? { translateX: current.x - start.x, translateY: current.y - start.y }
      : scaleFromCorner(gesture.bounds, current);
    selectionTransformRef.current = transform;
    if (gesture.kind === 'move') onMovePreview?.({ x: current.x - start.x, y: current.y - start.y });
    setPreview(Object.fromEntries(gesture.strokes.map((stroke) => [stroke.id, transformInkStroke(stroke, transform)])));
  }

  function handleSelectionPointerUp(event: ReactPointerEvent<SVGElement>) {
    const gesture = selectionGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const finalTransform = selectionTransformRef.current;
    const updates = gesture.strokes.map((stroke) => finalTransform ? transformInkStroke(stroke, finalTransform) : stroke).map((stroke) => ({
      id: stroke.id, revision: stroke.revision, points: stroke.points, size: stroke.size
    }));
    selectionGestureRef.current = null;
    selectionTransformRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setPreview({});
    if (gesture.kind === 'move' && onMoveEnd) onMoveEnd({ x: finalTransform?.translateX || 0, y: finalTransform?.translateY || 0 });
    else if (onTransformSelected) void onTransformSelected(updates);
  }

  function cancelSelectionGesture() {
    const gesture = selectionGestureRef.current;
    selectionGestureRef.current = null; selectionTransformRef.current = null; setPreview({});
    if (gesture?.kind === 'move') cancelCallback.current?.();
  }

  function handleScalePointerDown(event: ReactPointerEvent<SVGRectElement>) {
    if (!selectedBounds || selected.length === 0 || !onTransformSelected) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    selectionTransformRef.current = null;
    selectionGestureRef.current = {
      kind: 'scale', pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, bounds: selectedBounds, strokes: selected
    };
  }

  return <>
    <ViewportPortal>
      <InkLayer
        className="zz-ink-world zz-ink-world--background"
        strokes={rendered.filter((stroke) => stroke.layer === 'background')}
        selectedIds={selectedInkIds}
        hoveredId={hoveredId}
        zoom={zoom}
        bounds={layerBounds}
        selectable={tool === 'select' && !panActive}
        onHover={setHoveredId}
        onPointerDown={handleStrokePointerDown}
        onPointerMove={handleSelectionPointerMove}
        onPointerUp={handleSelectionPointerUp}
        onPointerCancel={cancelSelectionGesture}
      />
    </ViewportPortal>
    <ViewportPortal>
      <InkLayer
        className="zz-ink-world zz-ink-world--foreground"
        strokes={rendered.filter((stroke) => stroke.layer === 'foreground')}
        selectedIds={selectedInkIds}
        hoveredId={hoveredId}
        zoom={zoom}
        bounds={layerBounds}
        selectable={tool === 'select' && !panActive}
        onHover={setHoveredId}
        onPointerDown={handleStrokePointerDown}
        onPointerMove={handleSelectionPointerMove}
        onPointerUp={handleSelectionPointerUp}
        onPointerCancel={cancelSelectionGesture}
      >
        {selectedBounds && tool === 'select' && !panActive && !externalSelectionOverlay && <>
          <rect className="zz-ink-selection-box" x={selectedBounds.x} y={selectedBounds.y} width={selectedBounds.width} height={selectedBounds.height} />
          <rect
            className="zz-ink-selection-handle"
            x={selectedBounds.x + selectedBounds.width - 6 / Math.max(zoom, 0.1)}
            y={selectedBounds.y + selectedBounds.height - 6 / Math.max(zoom, 0.1)}
            width={12 / Math.max(zoom, 0.1)}
            height={12 / Math.max(zoom, 0.1)}
            rx={2 / Math.max(zoom, 0.1)}
            onPointerDown={handleScalePointerDown}
            onPointerMove={handleSelectionPointerMove}
            onPointerUp={handleSelectionPointerUp}
          />
        </>}
        {draftStroke?.layer === 'foreground' && <path className="zz-ink-path is-draft" d={strokeSvgPath(asStroke(draftStroke), zoom)} fill={draftStroke.color} fillOpacity={draftStroke.opacity} />}
        {tool === 'lasso' && gesturePoints.length > 1 && <path className="zz-ink-lasso" d={polylinePath(gesturePoints, true)} />}
        {tool === 'eraser' && gesturePoints.length > 0 && <path className="zz-ink-eraser-trace" d={polylinePath(gesturePoints, false)} strokeWidth={eraserRadius * 2} />}
      </InkLayer>
      {selectedBounds && selectedInkIds.length > 0 && tool === 'select' && !panActive && <div
        className="zz-ink-selection-actions nodrag nopan"
        style={{ left: selectedBounds.x, top: externalSelectionOverlay ? selectedBounds.y + selectedBounds.height + 16 / zoom : selectedBounds.y - 42 / Math.max(zoom, 0.1), transform: `scale(${1 / Math.max(zoom, 0.1)})`, transformOrigin: 'left top' }}
      >
        <ColorPalette label="墨迹颜色" value={selected[0]?.color || '#23201d'} opacity={selected[0]?.opacity} onChange={(color) => void onStyleSelected?.(selectedInkIds, { color })} />
        <button aria-label="置于气泡下方" title="置于气泡下方" onClick={() => void onStyleSelected?.(selectedInkIds, { layer: 'background' })}>↧</button>
        <button aria-label="置于气泡上方" title="置于气泡上方" onClick={() => void onStyleSelected?.(selectedInkIds, { layer: 'foreground' })}>↥</button>
        <button aria-label="删除墨迹并归档选中便签" title="处理选区（Delete）：项目保留，可撤销" onClick={() => void onDeleteSelected?.(selectedInkIds)}>×</button>
      </div>}
      {draftStroke?.layer === 'background' && <svg className="zz-ink-world zz-ink-world--background-draft" aria-hidden="true"
        viewBox={viewBoxFor(layerBounds)} preserveAspectRatio="none" style={layerStyle(layerBounds)}>
        <path className="zz-ink-path is-draft" d={strokeSvgPath(asStroke(draftStroke), zoom)} fill={draftStroke.color} fillOpacity={draftStroke.opacity} />
      </svg>}
    </ViewportPortal>
    {failedIds.some((id) => !strokes.some((stroke) => stroke.id === id)) && <div className="zz-ink-retry" role="status">
      <span>笔迹暂未保存，已保留在画布</span>
      <button onClick={() => pending.filter((stroke) => failedIds.includes(stroke.id)).forEach((stroke) => void submitStroke(stroke))}>重试保存</button>
    </div>}
    <div
      className={`zz-ink-input zz-ink-input--${tool}`}
      data-active={captureMode ? 'true' : 'false'}
      aria-label={captureMode ? inputLabel(tool) : undefined}
      onPointerDown={handleSurfacePointerDown}
      onPointerMove={handleSurfacePointerMove}
      onPointerUp={handleSurfacePointerUp}
      onPointerCancel={handleSurfacePointerCancel}
    />
  </>;
}

interface InkLayerProps {
  className: string;
  strokes: InkStrokeRecord[];
  selectedIds: string[];
  hoveredId: string | null;
  zoom: number;
  bounds: InkRect;
  selectable: boolean;
  onHover(id: string | null): void;
  onPointerDown(event: ReactPointerEvent<SVGPathElement>, stroke: InkStrokeRecord): void;
  onPointerMove(event: ReactPointerEvent<SVGElement>): void;
  onPointerUp(event: ReactPointerEvent<SVGElement>): void;
  onPointerCancel(): void;
  children?: ReactNode;
}

function InkLayer({ className, strokes, selectedIds, hoveredId, zoom, bounds, selectable, onHover, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, children }: InkLayerProps) {
  return <svg className={className} aria-hidden="true" viewBox={viewBoxFor(bounds)} preserveAspectRatio="none" style={layerStyle(bounds)} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onLostPointerCapture={onPointerCancel}>
    {strokes.map((stroke) => <path
      key={stroke.id}
      className={`zz-ink-path${selectedIds.includes(stroke.id) ? ' is-selected' : ''}${hoveredId === stroke.id ? ' is-hovered' : ''}`}
      d={cachedStrokeSvgPath(stroke, zoom)}
      fill={stroke.color}
      fillOpacity={stroke.opacity}
      pointerEvents={selectable ? 'visiblePainted' : 'none'}
      onPointerEnter={() => onHover(stroke.id)}
      onPointerLeave={() => onHover(null)}
      onPointerDown={(event) => onPointerDown(event, stroke)}
    />)}
    {children}
  </svg>;
}

function scaleFromCorner(bounds: InkRect, current: { x: number; y: number }): InkTransform {
  return {
    originX: bounds.x,
    originY: bounds.y,
    scaleX: Math.max(0.05, (current.x - bounds.x) / Math.max(bounds.width, 1)),
    scaleY: Math.max(0.05, (current.y - bounds.y) / Math.max(bounds.height, 1))
  };
}

function fallbackLayerBounds(strokes: readonly InkStrokeRecord[]): InkRect {
  return selectionBounds(strokes) || { x: 0, y: 0, width: 1, height: 1 };
}

function expandRect(rect: InkRect, padding: number): InkRect {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: Math.max(1, rect.width + padding * 2),
    height: Math.max(1, rect.height + padding * 2)
  };
}

function viewBoxFor(rect: InkRect): string {
  return `${rect.x} ${rect.y} ${rect.width} ${rect.height}`;
}

function layerStyle(rect: InkRect): CSSProperties {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

function appendAndReturn(current: InkPoint[], additions: InkPoint[]): InkPoint[] {
  const result = [...current];
  for (const point of additions) {
    const previous = result[result.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= 0.08 || Math.abs(point.pressure - previous.pressure) >= 0.03) result.push(point);
  }
  return result;
}

function topInkZ(strokes: readonly InkStrokeRecord[]): number {
  return strokes.reduce((highest, stroke) => Math.max(highest, stroke.zIndex), 0);
}

function compareStrokes(left: InkStrokeRecord, right: InkStrokeRecord): number {
  return left.zIndex - right.zIndex || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function polylinePath(points: readonly InkPoint[], closed: boolean): string {
  if (points.length === 0) return '';
  const body = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
  return closed ? `${body} Z` : body;
}

function asStroke(stroke: NewInkStroke): Pick<InkStrokeRecord, 'points' | 'size' | 'tool'> {
  return stroke;
}

/** Server acknowledgement replaces the provisional path in the same render, never adds a second translucent path. */
export function mergePendingInk(saved: InkStrokeRecord[], pending: InkStrokeRecord[]): InkStrokeRecord[] {
  const ids = new Set(saved.map((stroke) => stroke.id));
  return [...saved, ...pending.filter((stroke) => !ids.has(stroke.id))];
}

function inputLabel(tool: InkCanvasTool): string {
  if (tool === 'pen') return '自由绘制区域';
  if (tool === 'highlighter') return '荧光笔绘制区域';
  if (tool === 'eraser') return '墨迹擦除区域';
  if (tool === 'lasso') return '套索选择区域';
  return '';
}
