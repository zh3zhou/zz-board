import { mediaUrl } from './mediaClient.js';
import { RasterCache } from './rasterCache.js';

/** Keep offscreen positioning outside the subtree serialized into SVG. */
export function mountRasterSurface(width: number, height: number): { surface: HTMLDivElement; remove(): void } {
  const carrier = document.createElement('div'), surface = document.createElement('div');
  Object.assign(carrier.style, { position: 'fixed', left: '-20000px', top: '0', pointerEvents: 'none' });
  carrier.setAttribute('aria-hidden', 'true');
  Object.assign(surface.style, { position: 'relative', left: '0', top: '0', width: `${width}px`, height: `${height}px`, overflow: 'hidden', background: exportBackground() });
  carrier.append(surface); document.body.append(carrier);
  return { surface, remove: () => carrier.remove() };
}

export function exportBackground(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--skin-background').trim();
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d')!; context.fillStyle = '#f4f0e8'; context.fillRect(0, 0, 1, 1);
  context.fillStyle = value || '#f4f0e8'; context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}
export async function readyForRaster(element: HTMLElement, scale: number, signal?: AbortSignal, cache = new RasterCache(), maxLayoutHeight?: number) {
  signal?.throwIfAborted();
  await document.fonts.ready;
  // Decode sequentially: large original images never form a parallel bitmap queue.
  for (const img of element.querySelectorAll<HTMLImageElement>('img')) {
    signal?.throwIfAborted();
    const id = img.dataset.mediaId;
    const sampleWidth = Math.max(1, Math.ceil((img.getBoundingClientRect().width || img.clientWidth || img.parentElement?.clientWidth || 520) * scale));
    const key = `${id}:${sampleWidth}`, cached = id ? cache.get(key) : undefined;
    if (cached) img.src = cached;
    if (id && !cached) {
      const response = await fetch(mediaUrl(id, true), { signal });
      if (!response.ok) throw new Error('原图暂不可用，请恢复本地连接后重试导出。');
      const bitmap = await createImageBitmap(await response.blob(), { imageOrientation: 'from-image' });
      const sample = document.createElement('canvas');
      try {
        signal?.throwIfAborted();
        if (maxLayoutHeight && sampleWidth / scale * bitmap.height / bitmap.width > maxLayoutHeight)
          throw new Error(`完整图片超过单张 PNG 的 ${maxLayoutHeight} 像素高度上限，请调整便签内图宽或分开保存。`);
        // Sample the original at actual output resolution, never upscale a preview.
        // Pre-inline data avoids html-to-image's permanent URL→Base64 cache.
        sample.width = Math.min(bitmap.width, sampleWidth);
        sample.height = Math.max(1, Math.ceil(sample.width * bitmap.height / bitmap.width));
        const context = sample.getContext('2d')!;
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, sample.width, sample.height);
        img.src = sample.toDataURL('image/png');
        cache.set(key, img.src);
      } finally { bitmap.close(); sample.width = sample.height = 1; }
    }
    if (!img.src) continue;
    try { await img.decode(); } catch { throw new Error('有图片未能读取，请恢复本地连接后重试导出。'); }
  }
  signal?.throwIfAborted();
}
let rasterBusy = false;
export async function rasterElement(element: HTMLElement, width: number, height: number, scale: number, signal?: AbortSignal, cache?: RasterCache): Promise<HTMLCanvasElement> {
  const pixelWidth = Math.ceil(width * scale), pixelHeight = Math.ceil(height * scale);
  if (![width, height, scale].every(value => Number.isFinite(value) && value > 0) || pixelWidth > 8192 || pixelHeight > 8192 || pixelWidth * pixelHeight > 32_000_000) throw new Error('导出尺寸过大，请降低倍率或缩小范围。');
  if (rasterBusy) throw new Error('已有图片正在生成，请稍后重试。');
  rasterBusy = true;
  try {
  await readyForRaster(element, scale, signal, cache);
  const { toCanvas } = await import('html-to-image');
  // Rasterize foreignObject contents at final pixels. Merely increasing the
  // destination canvas pixelRatio can enlarge a logical-resolution SVG bitmap.
  const canvas = await toCanvas(element, { width: pixelWidth, height: pixelHeight, pixelRatio: 1, skipAutoScale: true, skipFonts: true, backgroundColor: exportBackground(),
    // The raster root already lives at (0, 0); reset logical as well as physical
    // insets so a serialized browser layout cannot retain an offscreen offset.
    style: { position: 'relative', inset: 'auto', insetBlock: 'auto', insetInline: 'auto', left: '0', top: '0', margin: '0', width: `${width}px`, height: `${height}px`, transform: `scale(${scale})`, transformOrigin: 'top left', animation: 'none', transition: 'none' },
    filter: node => !(node instanceof Element && (node.hasAttribute('data-export-exclude') || node.matches('button, .react-flow__handle, .note-image-controls')))
  });
  if (signal?.aborted) { canvas.width = canvas.height = 1; signal.throwIfAborted(); }
  return canvas;
  } finally { rasterBusy = false; }
}
export function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG 生成失败。')), 'image/png'));
}
export async function copyPng(blob: Blob | Promise<Blob>): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('当前窗口不支持图片剪贴板，请在正式桌面版重试。');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}
const properties = ['display', 'box-sizing', 'width', 'height', 'min-height', 'max-height', 'max-width', 'padding', 'margin', 'float', 'clear', 'overflow', 'border', 'border-radius', 'background-color', 'background-image', 'background-size', 'background-position', 'opacity', 'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'white-space', 'word-break', 'overflow-wrap', 'text-align', 'text-decoration', 'align-items', 'justify-content', 'object-fit', 'box-shadow'];
/** Copy the visual skin of the mounted paper without its clipped children or editor controls. */
export function resolvedSurface(source: HTMLElement): HTMLElement {
  const target = source.cloneNode(false) as HTMLElement;
  target.removeAttribute('class'); target.removeAttribute('style'); target.removeAttribute('contenteditable'); target.removeAttribute('id'); target.removeAttribute('tabindex');
  const style = getComputedStyle(source);
  for (const key of properties) target.style.setProperty(key, style.getPropertyValue(key));
  return target;
}
