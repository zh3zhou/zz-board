import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { Viewport } from '@xyflow/react';
import { createPortal } from 'react-dom';
import type { ExportScene } from './exportScene.js';
import { exportDimensions, type ExportRect } from './exportGeometry.js';
import { saveAndCopyPng } from './imageExport.js';
import { ExportReceipt } from './ImageExportFeedback.js';
import type { ImageExportResult } from '../shared/imageExport.js';
import './export.css';

/** Capture before the canvas can interpret a right click as a menu or selection. */
export function installExportReturnControls(target: EventTarget, back: () => void): () => void {
  const stop = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const key = (event: Event) => { if ((event as KeyboardEvent).key === 'Escape') { stop(event); back(); } };
  const pointer = (event: Event) => { if ((event as MouseEvent).button === 2) stop(event); };
  const menu = (event: Event) => { stop(event); back(); };
  target.addEventListener('keydown', key, true);
  target.addEventListener('pointerdown', pointer, true);
  target.addEventListener('pointerup', pointer, true);
  target.addEventListener('contextmenu', menu, true);
  return () => {
    target.removeEventListener('keydown', key, true);
    target.removeEventListener('pointerdown', pointer, true);
    target.removeEventListener('pointerup', pointer, true);
    target.removeEventListener('contextmenu', menu, true);
  };
}

export function ExportRegion({ nodes, edges, strokes, viewport, panActive, toWorld, onClose, onNotice, onViewport }: ExportScene & {
  viewport: Viewport; panActive: boolean; toWorld(p: { x: number; y: number }): { x: number; y: number }; onClose(): void; onNotice(text: string): void; onViewport(viewport: Viewport): void;
}) {
  const [rect, setRect] = useState<ExportRect | null>(null), [scale, setScale] = useState(2);
  const [progress, setProgress] = useState(''), [preview, setPreview] = useState<{ blob: Blob; url: string; width: number; height: number } | null>(null);
  const [error, setError] = useState('');
  const [actualPixels, setActualPixels] = useState(false);
  const [saving, setSaving] = useState(false), [receipt, setReceipt] = useState<ImageExportResult | null>(null);
  const previewRef = useRef(preview); previewRef.current = preview;
  const abort = useRef<AbortController | null>(null), alive = useRef(true);
  const selector = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; start: { x: number; y: number }; fixed: { x: number; y: number }; rect?: ExportRect; mode: string } | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; abort.current?.abort(); }; }, []);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);
  useEffect(() => {
    const element = selector.current; if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation();
      const point = toWorld({ x: event.clientX, y: event.clientY });
      const zoom = Math.max(.2, Math.min(2.2, viewport.zoom * Math.exp(-event.deltaY * (event.deltaMode === 1 ? .03 : .002))));
      onViewport({ x: viewport.x + point.x * (viewport.zoom - zoom), y: viewport.y + point.y * (viewport.zoom - zoom), zoom });
    };
    element.addEventListener('wheel', wheel, { passive: false }); return () => element.removeEventListener('wheel', wheel);
  }, [viewport, toWorld, onViewport]);
  function back() {
    drag.current = null;
    if (abort.current) abort.current.abort();
    else if (preview) setPreview(null);
    else onClose();
  }
  useEffect(() => installExportReturnControls(window, back), [preview, onClose]);
  function begin(event: PointerEvent<HTMLDivElement>) {
    if (panActive || event.button !== 0 || progress || drag.current || event.pointerType === 'touch' && event.isPrimary === false) return;
    event.stopPropagation(); event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const point = toWorld({ x: event.clientX, y: event.clientY });
    const mode = (event.target as HTMLElement).dataset.handle || 'new';
    const fixed = rect && mode !== 'new' && mode !== 'move' ? { x: mode.includes('w') ? rect.x + rect.width : rect.x, y: mode.includes('n') ? rect.y + rect.height : rect.y } : point;
    drag.current = { pointerId: event.pointerId, start: point, fixed, mode, rect: rect || undefined };
    if (mode === 'new') setRect({ ...point, width: 1, height: 1 });
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const state = drag.current; if (!state || state.pointerId !== event.pointerId) return;
    const point = toWorld({ x: event.clientX, y: event.clientY });
    if (state.mode === 'move' && state.rect) setRect({ ...state.rect, x: state.rect.x + point.x - state.start.x, y: state.rect.y + point.y - state.start.y });
    else setRect({ x: Math.min(point.x, state.fixed.x), y: Math.min(point.y, state.fixed.y), width: Math.max(1, Math.abs(point.x - state.fixed.x)), height: Math.max(1, Math.abs(point.y - state.fixed.y)) });
  }
  async function generate() {
    if (!rect || abort.current) return;
    const controller = new AbortController(); abort.current = controller; setError(''); setProgress('正在准备图片…');
    try {
      const size = exportDimensions(rect, scale);
      const { exportRegionPng } = await import('./exportScene.js');
      controller.signal.throwIfAborted();
      const blob = await exportRegionPng({ nodes, edges, strokes }, rect, scale, controller.signal, (done, total) => { if (alive.current && !controller.signal.aborted && abort.current === controller) setProgress(`正在生成 ${done} / ${total}`); });
      if (alive.current && !controller.signal.aborted && abort.current === controller) { setReceipt(null); setActualPixels(false); setPreview({ blob, url: URL.createObjectURL(blob), ...size }); }
    } catch (cause) { if (alive.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : '导出失败。'); }
    finally { if (abort.current === controller) { abort.current = null; if (alive.current) setProgress(''); } }
  }
  let dimensions = ''; let invalid = '';
  async function saveImage() {
    if (!preview || saving) return;
    setSaving(true); setError('');
    const output = preview;
    try { const result = await saveAndCopyPng(output.blob, 'region'); if (alive.current && previewRef.current === output) setReceipt(result); }
    catch (cause) { if (alive.current) { const message = cause instanceof Error ? cause.message : '图片保存失败。'; setError(message); onNotice(message); } }
    finally { if (alive.current) setSaving(false); }
  }
  if (rect) { try { const size = exportDimensions(rect, scale); dimensions = `${size.width} × ${size.height} px`; } catch (cause) { invalid = (cause as Error).message; } }
  return <>
    <div ref={selector} className="export-selector" style={{ pointerEvents: panActive || preview ? 'none' : 'auto' }} onPointerDown={begin} onPointerMove={move} onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) drag.current = null; }} onPointerCancel={event => {
      if (drag.current?.pointerId !== event.pointerId) return;
      // A two-finger viewport gesture must not alter an existing export range.
      setRect(drag.current.rect || null); drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}>
      {rect && <div className="export-rectangle" data-handle="move" style={{ left: rect.x * viewport.zoom + viewport.x, top: rect.y * viewport.zoom + viewport.y, width: rect.width * viewport.zoom, height: rect.height * viewport.zoom }}>
        {['nw', 'ne', 'sw', 'se'].map(corner => <span key={corner} data-handle={corner} className={`export-corner ${corner}`} />)}
      </div>}
    </div>
    <div className="export-toolbar" role="region" aria-label="导出区域" onPointerDown={event => event.stopPropagation()}>
      <header><strong>导出区域</strong><button className="export-close" aria-label="返回上一步" title="右键 / Esc 返回" onClick={back}>×</button></header>
      <p className="export-help">拖出矩形，拖角调整范围。<br />空格平移 · 滚轮缩放 · 右键 / Esc 返回</p>
      <div className="export-quality"><span>清晰度</span><div className="export-scale-options" role="group" aria-label="导出倍率">{[1, 2, 4].map(n => <button key={n} aria-pressed={scale === n} disabled={!!progress} onClick={() => setScale(n)}>{n}×</button>)}</div></div>
      <output className="export-dimensions">{dimensions || '请在画布上选择范围'}</output>
      <p className="export-help">按原图生成；倍率提高输出像素，不能补出原图没有的细节。</p>
      <button className="export-primary" disabled={!rect || !!invalid || !!progress} onClick={() => void generate()}>生成预览</button>
      {(invalid || error || progress) && <small role="status">{invalid || error || progress}{progress && <button onClick={() => abort.current?.abort()}>停止</button>}</small>}
    </div>
    {preview && createPortal(<div className="export-preview modal-backdrop" role="dialog" aria-modal="true" aria-label="PNG 预览"><section className="modal panel-shell">
      <header className="panel-fixed-header"><h2>{preview.width} × {preview.height} PNG</h2><button className="panel-close" onClick={() => setPreview(null)} aria-label="返回调整范围">×</button></header>
      <div className={`panel-scroll${actualPixels ? ' export-actual-pixels' : ''}`}><img src={preview.url} alt="导出区域预览" style={actualPixels ? { width: preview.width, height: preview.height } : undefined} /></div>
      <footer><button aria-pressed={actualPixels} onClick={() => setActualPixels(value => !value)}>{actualPixels ? '适应窗口' : '100% 像素'}</button><button disabled={saving} onClick={() => void saveImage()}>{saving ? '正在保存…' : '保存并复制 PNG'}</button>
        <button onClick={() => setPreview(null)}>继续调整</button>{receipt && <ExportReceipt key={receipt.saved?.path} result={receipt} />}{error && <small role="alert">{error}</small>}</footer>
    </section></div>, document.body)}
  </>;
}
