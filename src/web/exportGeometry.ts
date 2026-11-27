export interface ExportRect { x: number; y: number; width: number; height: number }
export function exportDimensions(rect: ExportRect, scale: number) {
  if (![rect.x, rect.y, rect.width, rect.height, scale].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || ![1, 2, 4].includes(scale)) throw new Error('请选择有效的矩形范围和倍率。');
  const width = Math.ceil(rect.width * scale), height = Math.ceil(rect.height * scale);
  if (width > 8192 || height > 8192 || width * height > 32_000_000) throw new Error('超过 8192px / 3200 万像素，请降低倍率或缩小范围。');
  return { width, height };
}
export function exportTiles(rect: ExportRect, scale: number, tileSize = 2048) {
  const { width, height } = exportDimensions(rect, scale);
  const tiles = [];
  for (let y = 0; y < height; y += tileSize) for (let x = 0; x < width; x += tileSize) {
    const w = Math.min(tileSize, width - x), h = Math.min(tileSize, height - y);
    tiles.push({ pixelX: x, pixelY: y, pixelWidth: w, pixelHeight: h, x: rect.x + x / scale, y: rect.y + y / scale, width: w / scale, height: h / scale });
  }
  return tiles;
}
export function rectIntersects(a: ExportRect, b: ExportRect, padding = 0) {
  return a.x - padding <= b.x + b.width && a.x + a.width + padding >= b.x && a.y - padding <= b.y + b.height && a.y + a.height + padding >= b.y;
}
