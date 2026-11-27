import { useRef, useState, type PointerEvent } from 'react';
import { centeredPlacement, MAX_STROKE_POINTS, MAX_WALLPAPER_POINTS, MAX_WALLPAPER_STROKES, sameWallpaper, wallpaperImages, withWallpaperImages, type Wallpaper, type WallpaperImage, type WallpaperStroke } from '../shared/wallpaper.js';
import { WallpaperScene } from './WallpaperScene.js';

type Point = WallpaperStroke['points'][number];
type Placement = NonNullable<WallpaperImage['placement']>;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(n)));

export function studioPoint(clientX: number, clientY: number, rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>): Point {
  return [clamp((clientX - rect.left) * 1000 / Math.max(rect.width, 1), 0, 1000),
    clamp((clientY - rect.top) * 1000 / Math.max(rect.height, 1), 0, 1000)];
}
export function moveWallpaperImage(initial: Placement, start: Point, current: Point): Placement {
  return { ...initial, x: clamp(initial.x + (current[0] - start[0]) / 10, -100, 100),
    y: clamp(initial.y + (current[1] - start[1]) / 10, -100, 100) };
}
type Gesture = { pointerId: number; start: Point; basis: Wallpaper; index: number; initial: Placement; stroke: WallpaperStroke | null };

export function WallpaperStudio({ value, index, locked, urlFor, onChange }: {
  value: Wallpaper; index: number; locked: boolean; urlFor(id: string): string; onChange(value: Wallpaper): void;
}) {
  const [tool, setTool] = useState<'move' | 'draw'>('move');
  const [color, setColor] = useState('#597e86');
  const [size, setSize] = useState(6);
  const [preview, setPreview] = useState<Wallpaper | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const image = wallpaperImages(value)[index], place = image?.placement ?? centeredPlacement;
  const remaining = MAX_WALLPAPER_POINTS - (value.strokes ?? []).reduce((sum, stroke) => sum + stroke.points.length, 0);
  const maxPoints = Math.min(remaining, MAX_STROKE_POINTS);
  const canDraw = remaining > 0 && (value.strokes?.length ?? 0) < MAX_WALLPAPER_STROKES;
  function setPlacement(basis: Wallpaper, i: number, placement: Placement): Wallpaper {
    return withWallpaperImages(basis, wallpaperImages(basis).map((layer, n) => n === i ? { ...layer, placement } : layer));
  }
  function point(e: PointerEvent<HTMLDivElement>) { return studioPoint(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect()); }
  function begin(e: PointerEvent<HTMLDivElement>) {
    if (locked || gesture.current || e.button !== 0 || (tool === 'move' ? !image : !canDraw)) return;
    e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
    const start = point(e);
    const stroke = tool === 'draw' ? { color, size, points: [start] } : null;
    gesture.current = { pointerId: e.pointerId, start, basis: value, index, initial: place, stroke };
    if (stroke) setPreview({ ...value, strokes: [...value.strokes ?? [], stroke] });
  }
  function update(e: PointerEvent<HTMLDivElement>, finish: boolean) {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const here = point(e);
    let next: Wallpaper;
    if (g.stroke) {
      const last = g.stroke.points.at(-1)!;
      if (g.stroke.points.length < maxPoints && (last[0] !== here[0] || last[1] !== here[1])) {
        g.stroke = { ...g.stroke, points: [...g.stroke.points, here] };
      }
      next = { ...g.basis, strokes: [...g.basis.strokes ?? [], g.stroke] };
    } else next = setPlacement(g.basis, g.index, moveWallpaperImage(g.initial, g.start, here));
    if (finish) {
      gesture.current = null; setPreview(null);
      if (!locked && sameWallpaper(value, g.basis)) onChange(next);
    } else setPreview(next);
  }
  function cancel(e: PointerEvent<HTMLDivElement>) {
    if (gesture.current?.pointerId === e.pointerId) { gesture.current = null; setPreview(null); }
  }
  return <div className="wallpaper-studio">
    <div className="wallpaper-tools" role="group" aria-label="背景画布工具">
      <button type="button" aria-pressed={tool === 'move'} onClick={() => setTool('move')}>移动图片</button>
      <button type="button" aria-pressed={tool === 'draw'} onClick={() => setTool('draw')}>画笔</button>
    </div>
    <div className="wallpaper-workspace" data-tool={tool} role="group" aria-label="背景布置画布"
      onPointerDown={begin} onPointerMove={e => update(e, false)} onPointerUp={e => update(e, true)}
      onPointerCancel={cancel} onLostPointerCapture={cancel}>
      <WallpaperScene value={preview ?? value} urlFor={urlFor} preview />
    </div>
    {tool === 'move' && image && <div className="wallpaper-placement">
      {(['scale', 'x', 'y'] as const).map(key => <label key={key}>
        {{ scale: '图片大小', x: '水平移动', y: '垂直移动' }[key]} · {place[key]}%
        <input type="range" min={key === 'scale' ? 10 : -100} max={key === 'scale' ? 300 : 100} value={place[key]} disabled={locked}
          onChange={e => onChange(setPlacement(value, index, { ...place, [key]: Number(e.target.value) }))} />
      </label>)}
    </div>}
    {tool === 'draw' && <div className="wallpaper-brush">
      <label>墨色<input type="color" value={color} disabled={locked} onChange={e => setColor(e.target.value)} /></label>
      <label>笔宽 · {size}<input type="range" min="1" max="20" value={size} disabled={locked} onChange={e => setSize(Number(e.target.value))} /></label>
      <button type="button" disabled={locked || !value.strokes?.length}
        onClick={() => onChange({ ...value, strokes: value.strokes?.slice(0, -1) })}>撤回一笔</button>
      {!canDraw ? <small role="status">这套背景的笔迹已满。</small> :
        preview?.strokes?.at(-1)?.points.length === maxPoints && <small role="status">这笔已满，抬笔后可以继续。</small>}
    </div>}
  </div>;
}
