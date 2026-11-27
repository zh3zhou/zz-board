import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { centeredPlacement, wallpaperImages, type Wallpaper, type WallpaperImage, type WallpaperStroke } from '../shared/wallpaper.js';
import { mediaUrl } from './mediaClient.js';
import './wallpaper.css';

const original = (id: string) => mediaUrl(id, true);

export function layerStyle(image: WallpaperImage, url: string, previewScale = 1): CSSProperties {
  const { scale, x, y } = image.placement ?? centeredPlacement;
  if (image.fit === 'tile') {
    // The density scales each tile without moving the edges of the repeated surface.
    return { inset: 0, opacity: image.opacity, backgroundImage: `image-set(url("${url}") ${100 / (scale * previewScale)}x)`,
      backgroundRepeat: 'repeat', backgroundPosition: `${x}cqw ${y}cqh`, backgroundSize: 'auto' };
  }
  const margin = (100 - scale) / 2;
  return { left: `${margin + x}%`, top: `${margin + y}%`, width: `${scale}%`, height: `${scale}%`,
    backgroundImage: `url("${url}")`, backgroundSize: image.fit, backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat', opacity: image.opacity };
}

function InkMark({ stroke }: { stroke: WallpaperStroke }) {
  if (stroke.points.length === 1) {
    const [x, y] = stroke.points[0]!;
    return <circle cx={x} cy={y} r={stroke.size / 2} fill={stroke.color} />;
  }
  return <polyline points={stroke.points.map(point => point.join(',')).join(' ')} fill="none"
    stroke={stroke.color} strokeWidth={stroke.size} strokeLinecap="round" strokeLinejoin="round" />;
}

export function WallpaperScene({ value, urlFor = original, preview = false }: {
  value: Wallpaper; urlFor?(id: string): string; preview?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [pixelScale, setPixelScale] = useState(1);
  useEffect(() => {
    const element = root.current;
    if (!preview || !element) return;
    const measure = () => setPixelScale(Math.max(.01, element.clientWidth / Math.max(1, window.innerWidth)));
    const observer = new ResizeObserver(measure);
    observer.observe(element); window.addEventListener('resize', measure); measure();
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [preview]);
  return <div className="wallpaper-scene" ref={root} aria-hidden="true">
    {wallpaperImages(value).map((image, index) =>
      <div key={index} className="wallpaper-layer" style={layerStyle(image, urlFor(image.assetId), preview ? pixelScale : 1)} />)}
    {!!value.strokes?.length && <svg className="wallpaper-ink" viewBox="0 0 1000 1000" preserveAspectRatio="none">
      {value.strokes.map((stroke, index) => <InkMark key={index} stroke={stroke} />)}
    </svg>}
  </div>;
}
