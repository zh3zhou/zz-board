import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { BaseEdge, EdgeLabelRenderer, useInternalNode, useReactFlow, type EdgeProps } from '@xyflow/react';
import { floatingLinkGeometry, linkBendFromPoint, type LinkBend } from './linkGeometry.js';
import type { SkinShapeKind } from '../shared/skin.js';
import './link.css';

interface FloatingLinkData extends Record<string, unknown> {
  sourceKind: 'task' | 'note';
  targetKind: 'task' | 'note';
  sourceShape?: SkinShapeKind;
  targetShape?: SkinShapeKind;
  sourceCornerRadii?: readonly number[];
  targetCornerRadii?: readonly number[];
  highlighted: boolean;
  bend?: LinkBend | null;
  projectedLabel?: string;
  onBendChange?: (id: string, bend: LinkBend | null) => void | Promise<void>;
  onDelete?: (id: string) => void;
}

export function FloatingLinkEdge({ id, source, target, style, interactionWidth, data, selected }: EdgeProps) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const { screenToFlowPosition } = useReactFlow();
  const details = (data || {}) as Partial<FloatingLinkData>;
  const [draftBend, setDraftBend] = useState<LinkBend | null | undefined>();
  const pointer = useRef<number | null>(null);
  const moved = useRef(false);
  const saveGeneration = useRef(0);
  useEffect(() => { if (pointer.current === null) setDraftBend(undefined); }, [details.bend?.along, details.bend?.normal]);
  if (!sourceNode || !targetNode) return null;
  const sourceRect = rect(sourceNode, details.sourceKind || 'task', details.sourceShape, details.sourceCornerRadii);
  const targetRect = rect(targetNode, details.targetKind || 'task', details.targetShape, details.targetCornerRadii);
  const geometry = floatingLinkGeometry(sourceRect, targetRect, draftBend === undefined ? details.bend : draftBend);
  function pointerBend(event: PointerEvent<HTMLButtonElement>) {
    return linkBendFromPoint(geometry.source, geometry.target, screenToFlowPosition({ x: event.clientX, y: event.clientY }), geometry.frameScale);
  }
  function saveBend(next: LinkBend | null) {
    setDraftBend(next);
    const generation = ++saveGeneration.current;
    const completion = details.onBendChange?.(id, next);
    if (completion && typeof completion.then === 'function') {
      const settle = () => { if (saveGeneration.current === generation && pointer.current === null) setDraftBend(undefined); };
      void completion.then(settle, settle);
    }
  }
  return <><g>{details.projectedLabel && <title>{details.projectedLabel}</title>}<BaseEdge
    id={id}
    path={geometry.path}
    className={`canvas-link${details.highlighted ? ' is-highlighted' : ''}${selected ? ' is-selected' : ''}${geometry.overlapping ? ' is-overlapping' : ''}`}
    interactionWidth={interactionWidth || 26}
    style={{ ...style, '--link-content-scale': geometry.frameScale, strokeWidth: `calc(var(--skin-link-width, 2px) * ${geometry.frameScale})` } as CSSProperties}
  /></g>
    {selected && <EdgeLabelRenderer><div className="zz-link-tools nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${geometry.midpoint.x}px, ${geometry.midpoint.y}px)` }}
      onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      {details.projectedLabel && <span className="zz-link-projected-label">{details.projectedLabel}</span>}
      {details.onBendChange && <button type="button" className="zz-link-bend" title="拖动调整连线弯曲；方向键微调" aria-label="调整连线弯曲"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault(); pointer.current = event.pointerId; moved.current = false;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (pointer.current !== event.pointerId) return;
          moved.current = true; setDraftBend(pointerBend(event));
        }}
        onPointerUp={(event) => {
          if (pointer.current !== event.pointerId) return;
          pointer.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          if (moved.current) saveBend(pointerBend(event));
        }}
        onPointerCancel={() => { pointer.current = null; setDraftBend(undefined); }}
        onKeyDown={(event) => {
          const delta = { ArrowLeft: [-6, 0], ArrowRight: [6, 0], ArrowUp: [0, -6], ArrowDown: [0, 6] }[event.key];
          if (!delta) return;
          event.preventDefault(); event.stopPropagation();
          const next = linkBendFromPoint(geometry.source, geometry.target, { x: geometry.midpoint.x + delta[0]!, y: geometry.midpoint.y + delta[1]! }, geometry.frameScale);
          saveBend(next);
        }}><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3"/><path d="M10 1v3m0 12v3M1 10h3m12 0h3"/></svg></button>}
      <div className="zz-link-actions">
        {details.onBendChange && <button type="button" title="恢复默认曲线" aria-label="恢复默认曲线" onClick={() => saveBend(null)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 7a6 6 0 1 1-1 6M4 2v5h5"/></svg></button>}
        {details.onDelete && <button type="button" title="删除连线" aria-label="删除连线" onClick={() => details.onDelete?.(id)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M7 5V3h6v2M5 5l1 12h8l1-12M8 8v6m4-6v6"/></svg></button>}
      </div>
    </div></EdgeLabelRenderer>}
  </>;
}

function rect(node: NonNullable<ReturnType<typeof useInternalNode>>, kind: 'task' | 'note', shape?: SkinShapeKind, cornerRadii?: readonly number[]) {
  const position = node.internals.positionAbsolute;
  return {
    x: position.x,
    y: position.y,
    width: node.measured.width || Number(node.width) || 180,
    height: node.measured.height || Number(node.height) || 180,
    contentScale: (node.data.record as { contentScale?: number } | undefined)?.contentScale ?? 1,
    kind,
    shape,
    cornerRadii
  };
}
