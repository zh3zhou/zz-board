import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { Edge, Node, NodeProps } from '@xyflow/react';
import type { InkStrokeRecord } from '../shared/schema.js';
import { TaskBubble, type BubbleData } from './TaskBubble.js';
import { floatingLinkGeometry, type LinkBend } from './linkGeometry.js';
import { selectionBounds, strokeSvgPath } from './inkGeometry.js';
import { exportDimensions, exportTiles, rectIntersects, type ExportRect } from './exportGeometry.js';
import { canvasPng, mountRasterSurface, rasterElement } from './rasterExport.js';
import './export.css';
import { RasterCache } from './rasterCache.js';

export interface ExportScene { nodes: Node<BubbleData>[]; edges: Edge[]; strokes: InkStrokeRecord[] }
let busy = false;
export async function exportRegionPng(scene: ExportScene, region: ExportRect, scale: number, signal: AbortSignal, progress: (completed: number, total: number) => void): Promise<Blob> {
  if (busy) throw new Error('已有图片正在导出，请稍候。');
  const size = exportDimensions(region, scale), tiles = exportTiles(region, scale);
  busy = true;
  const canvas = document.createElement('canvas');
  canvas.width = size.width; canvas.height = size.height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) { busy = false; throw new Error('无法建立导出画面。'); }
  const { surface: host, remove } = mountRasterSurface(size.width / scale, size.height / scale);
  host.className = 'zz-export-scene';
  const root = createRoot(host);
  const cache = new RasterCache();
  try {
    for (let i = 0; i < tiles.length; i++) {
      signal.throwIfAborted();
      const tile = tiles[i]!;
      Object.assign(host.style, { width: `${tile.width}px`, height: `${tile.height}px` });
      flushSync(() => root.render(<SceneTile {...scene} region={tile} wholeRegion={region} scale={scale} />));
      let raster: HTMLCanvasElement | undefined;
      try { raster = await rasterElement(host, tile.width, tile.height, scale, signal, cache); context.drawImage(raster, tile.pixelX, tile.pixelY, tile.pixelWidth, tile.pixelHeight); }
      finally { if (raster) raster.width = raster.height = 1; host.querySelectorAll('img').forEach(img => img.removeAttribute('src')); flushSync(() => root.render(null)); }
      progress(i + 1, tiles.length);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    signal.throwIfAborted();
    const blob = await canvasPng(canvas); signal.throwIfAborted(); return blob;
  } finally { cache.clear(); root.unmount(); remove(); canvas.width = canvas.height = 1; busy = false; }
}
export function SceneTile({ nodes, edges, strokes, region, wholeRegion, scale }: ExportScene & { region: ExportRect; wholeRegion: ExportRect; scale: number }) {
  // html-to-image deep-clones SVG without resolving styles on its descendants.
  // SVG presentation attributes must therefore be self-contained, not var(...).
  const skin = getComputedStyle(document.documentElement);
  const linkColor = skin.getPropertyValue('--edge').trim() || '#817b6d';
  const linkWidth = Number.parseFloat(skin.getPropertyValue('--skin-link-width')) || 2;
  const linkOpacity = Number.parseFloat(skin.getPropertyValue('--skin-link-opacity'));
  const linkDash = skin.getPropertyValue('--skin-link-dash').trim() || 'none';
  const worldOrigin = `${-wholeRegion.x}px ${-wholeRegion.y}px`;
  const sizes = skin.getPropertyValue('--skin-pattern-size').trim() || '34px 34px';
  // Each repeating layer keeps the world's origin. Full-size washes and the two
  // ambient gradients use the same whole-region frame on every output tile.
  const origins = sizes.split(',').map(size => size.trim() === 'auto' ? 'center' : worldOrigin);
  const backgroundPosition = [...origins, 'center', 'center'].join(', ');
  const map = new Map(nodes.filter(n => !n.hidden).map(n => [n.id, n]));
  const links = edges.filter(e => !e.hidden).flatMap(edge => {
    const a = map.get(edge.source), b = map.get(edge.target); if (!a || !b) return [];
    const rect = (n: Node<BubbleData>) => ({ ...n.data.record, ...n.position, shape: n.data.shape, cornerRadii: n.data.cornerRadii });
    const geometry = floatingLinkGeometry(rect(a), rect(b), edge.data?.bend as LinkBend | null);
    return [{ id: edge.id, path: geometry.path, scale: geometry.frameScale }];
  });
  const ink = [...strokes].filter(stroke => { const bounds = selectionBounds([stroke]); return bounds && rectIntersects(bounds, region); }).sort((a, b) => a.zIndex - b.zIndex || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const svg = (layer: string, zIndex: number) => <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex }} viewBox={`${region.x} ${region.y} ${region.width} ${region.height}`}>
    {ink.filter(s => s.layer === layer).map(s => <path key={s.id} d={strokeSvgPath(s, scale)} fill={s.color} fillOpacity={s.opacity} />)}
  </svg>;
  return <>
    <div className="export-background" style={{ left: wholeRegion.x - region.x, top: wholeRegion.y - region.y, width: wholeRegion.width, height: wholeRegion.height, backgroundPosition }} />
    {svg('background', 1)}
    <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', zIndex: 2 }} viewBox={`${region.x} ${region.y} ${region.width} ${region.height}`}>
      {links.map(link => <path key={link.id} d={link.path} fill="none" stroke={linkColor} strokeWidth={linkWidth * link.scale} strokeDasharray={linkDash} opacity={Number.isFinite(linkOpacity) ? linkOpacity : .82} />)}
    </svg>
    {nodes.filter(n => !n.hidden && rectIntersects({ ...n.data.record, ...n.position }, region, 64 * (n.data.record.contentScale ?? 1))).sort((a, b) => a.data.record.zIndex - b.data.record.zIndex).map(n => <div key={n.id} style={{ position: 'absolute', left: n.position.x - region.x, top: n.position.y - region.y, width: n.data.record.width, height: n.data.record.height, zIndex: 3 }}>
      <TaskBubble id={n.id} data={{ ...n.data, selected: false, canResize: false, exportMode: true, isDraft: false, editing: false, foldAnimation: undefined }} />
    </div>)}
    {svg('foreground', 4)}
  </>;
}
