import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from './noteDocument.js';

export class InvalidImageError extends Error {}
export interface ImageInfo { mime: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number }

function jpegDimensions(data: Uint8Array, view: DataView) {
  let width = 0, height = 0, seenScan = false, inScan = false, at = 2;
  while (at < data.length) {
    if (inScan) {
      at = data.indexOf(255, at);
      if (at < 0) break;
    } else if (data[at] !== 255) throw new InvalidImageError('JPEG 标记无效。');
    while (data[at] === 255) at++;
    if (at >= data.length) break;
    const marker = data[at++]!;
    // Escaped FF and restart markers belong to the entropy-coded scan.
    if (inScan && (marker === 0 || marker >= 0xd0 && marker <= 0xd7)) continue;
    inScan = false;
    if (marker === 0xd9) {
      if (!seenScan) throw new InvalidImageError('JPEG 缺少图像内容。');
      // Windows clipboard storage may pad a complete JPEG with zero bytes.
      while (at < data.length && data[at] === 0) at++;
      if (at !== data.length) throw new InvalidImageError('JPEG 结束标记后含其他数据。');
      return { width, height };
    }
    if (marker === 0x01) continue; // Standalone TEM marker.
    if (!marker || marker >= 0xd0 && marker <= 0xd8) throw new InvalidImageError('JPEG 标记无效。');
    if (at + 2 > data.length) break;
    const length = view.getUint16(at);
    if (length < 2 || at + length > data.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) throw new InvalidImageError('JPEG 图片头无效。');
      height = view.getUint16(at + 3); width = view.getUint16(at + 5);
    }
    at += length;
    if (marker === 0xda) { inScan = true; seenScan = true; }
  }
  throw new InvalidImageError('JPEG 文件不完整。');
}
/** Parse bounded containers before browser decoding; no filename/MIME trust. */
export function imageInfo(data: Uint8Array, maxBytes = MAX_IMAGE_BYTES, maxPixels = MAX_IMAGE_PIXELS): ImageInfo {
  if (!data.length || data.length > maxBytes) throw new InvalidImageError('图片文件过大或为空。');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (at: number, size = 4) => String.fromCharCode(...data.subarray(at, at + size));
  let mime: ImageInfo['mime'], width = 0, height = 0;
  if (data.length > 32 && tag(0, 8) === '\x89PNG\r\n\x1a\n') {
    mime = 'image/png'; let end = false, pixels = false;
    for (let at = 8; at + 12 <= data.length;) {
      const length = view.getUint32(at), kind = tag(at + 4);
      if (length > data.length - at - 12) throw new InvalidImageError('PNG 文件不完整。');
      if (at === 8) {
        if (kind !== 'IHDR' || length !== 13) throw new InvalidImageError('PNG 图片头无效。');
        width = view.getUint32(at + 8); height = view.getUint32(at + 12);
      }
      if (kind === 'acTL' || kind === 'fcTL') throw new InvalidImageError('暂不支持动画图片。');
      if (kind === 'IDAT') pixels = true;
      at += length + 12;
      if (kind === 'IEND') { end = length === 0 && at === data.length; break; }
    }
    if (!end || !pixels) throw new InvalidImageError('PNG 文件不完整。');
  } else if (data.length > 12 && data[0] === 255 && data[1] === 216) {
    mime = 'image/jpeg';
    ({ width, height } = jpegDimensions(data, view));
  } else if (data.length > 20 && tag(0) === 'RIFF' && tag(8) === 'WEBP') {
    mime = 'image/webp'; let pixels = false;
    if (view.getUint32(4, true) + 8 !== data.length) throw new InvalidImageError('WebP 文件不完整。');
    for (let at = 12; at + 8 <= data.length;) {
      const kind = tag(at), length = view.getUint32(at + 4, true), start = at + 8;
      if (length > data.length - start) throw new InvalidImageError('WebP 数据块无效。');
      if (kind === 'ANIM' || kind === 'ANMF' || kind === 'VP8X' && (data[start]! & 2)) throw new InvalidImageError('暂不支持动画图片。');
      if (kind === 'VP8X' && length >= 10) {
        width = 1 + data[start + 4]! + (data[start + 5]! << 8) + (data[start + 6]! << 16);
        height = 1 + data[start + 7]! + (data[start + 8]! << 8) + (data[start + 9]! << 16);
      }
      if (kind === 'VP8 ' && length >= 10 && tag(start + 3, 3) === '\x9d\x01\x2a') {
        if (!width) { width = view.getUint16(start + 6, true) & 0x3fff; height = view.getUint16(start + 8, true) & 0x3fff; }
        pixels = true;
      }
      if (kind === 'VP8L' && length >= 5 && data[start] === 0x2f) {
        const bits = view.getUint32(start + 1, true);
        if (!width) { width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff); }
        pixels = true;
      }
      at = start + length + (length & 1);
    }
    if (!pixels) throw new InvalidImageError('WebP 缺少图像内容。');
  } else throw new InvalidImageError('仅支持静态 PNG、JPEG、WebP 图片。');
  if (!width || !height || width * height > maxPixels || Math.max(width, height) > 32768) throw new InvalidImageError('图片尺寸超过限制（最多 4000 万像素）。');
  return { mime, width, height };
}
