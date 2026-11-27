import { imageInfo, InvalidImageError } from '../shared/imageFormat.js';
import { MAX_IMAGE_BYTES, type MediaAsset } from '../shared/noteDocument.js';

export type ClipboardImage = File | { primary: File; alternates: (File | string)[] };
const imageFile = (file: File) => file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(file.name)
  || (!file.type || file.type === 'application/octet-stream') && /^(image|blob)?$/i.test(file.name);
function embeddedImage(data: DataTransfer): string | undefined {
  if (!Array.from(data.types || []).includes('text/html')) return;
  const html = data.getData('text/html');
  if (!html || html.length > MAX_IMAGE_BYTES * 4 / 3 + 65536 || !/;base64,/i.test(html)) return;
  // Contents of a template remain inert. Never adopt clipboard HTML into the page or follow its URLs.
  const template = document.createElement('template');
  template.innerHTML = html;
  const images = template.content.querySelectorAll('img');
  if (images.length !== 1) return;
  const src = images[0].getAttribute('src') || '';
  if (/^data:image\/(?:png|jpe?g|webp);base64,/i.test(src)) return src;
}
function embeddedFile(src: string): File | undefined {
  const comma = src.indexOf(',');
  if (src.length - comma - 1 > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return;
  try {
    const decoded = atob(src.slice(comma + 1));
    if (!decoded || decoded.length > MAX_IMAGE_BYTES) return;
    const bytes = Uint8Array.from(decoded, ch => ch.charCodeAt(0)), type = src.slice(5, src.indexOf(';')).toLowerCase();
    return new File([bytes], 'clipboard.' + type.slice(6), { type });
  } catch { return; }
}
export function clipboardImages(data: DataTransfer | null): ClipboardImage[] {
  if (!data) return [];
  const items = Array.from(data.items || []).flatMap(item => {
    if (item.kind !== 'file') return [];
    const file = item.getAsFile();
    return file && (item.type.startsWith('image/') || imageFile(file)) ? [file] : [];
  });
  const native = Array.from(data.files || []).filter(imageFile);
  const files = native.length > items.length ? native : items;
  if (files.length > 1) return files;
  const primary = files[0];
  const embedded = embeddedImage(data);
  if (primary) {
    const alternates: (File | string)[] = [];
    if (native[0] && (native[0].type !== primary.type || native[0].size !== primary.size)) alternates.push(native[0]);
    if (embedded) alternates.push(embedded);
    return alternates.length ? [{ primary, alternates }] : files;
  }
  const file = embedded && embeddedFile(embedded);
  return file ? [file] : [];
}
let serial = Promise.resolve();
async function submitImage(file: Blob): Promise<MediaAsset> {
  if (file.size > MAX_IMAGE_BYTES) throw new InvalidImageError('单张图片不能超过 25 MiB。');
  imageInfo(new Uint8Array(await file.arrayBuffer()));
  const response = await fetch('/api/media', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-zz-board-mutation': '1' }, body: file });
  const value = await response.json();
  if (!response.ok) {
    if (value.code === 'invalid_image') throw new InvalidImageError(value.error);
    throw new Error(value.error || '图片保存失败。');
  }
  return value as MediaAsset;
}
export function uploadImage(input: Blob | ClipboardImage): Promise<MediaAsset> {
  const work = serial.then(async () => {
    if (!('primary' in input)) return submitImage(input);
    let originalError: InvalidImageError | undefined;
    for (const variant of [input.primary, ...input.alternates]) {
      const file = typeof variant === 'string' ? embeddedFile(variant) : variant;
      if (!file) continue;
      try { return await submitImage(file); }
      catch (error) {
        if (!(error instanceof InvalidImageError)) throw error;
        originalError ??= error;
      }
    }
    throw originalError ?? new InvalidImageError('剪贴板缺少可读的图片，请重新复制原图。');
  });
  serial = work.then(() => undefined, () => undefined); return work;
}
export function mediaUrl(id: string, original = false): string { return `/api/media/${id}/${original ? 'original' : 'preview'}`; }
