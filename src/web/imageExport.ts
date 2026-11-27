import { api } from './api.js';
import { copyPng } from './rasterExport.js';
import type { ImageExportResult } from '../shared/imageExport.js';

let busy = false;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** Start clipboard work inside the user gesture, not after a filesystem roundtrip. */
export async function saveAndCopyPng(input: Blob | Promise<Blob> | (() => Promise<Blob>), kind: 'region' | 'note'): Promise<ImageExportResult> {
  if (busy) { if (typeof input !== 'function') void Promise.resolve(input).catch(() => undefined); throw new Error('上一张图片仍在保存，请稍后重试。'); }
  busy = true;
  try {
    const blob = typeof input === 'function' ? Promise.resolve().then(input) : Promise.resolve(input);
    const copied = copyPng(blob);
    const saved = blob.then(value => api.savePng(value, kind));
    const [save, copy] = await Promise.allSettled([saved, copied]);
    const result: ImageExportResult = {
      ...(save.status === 'fulfilled' ? { saved: save.value } : { saveError: message(save.reason) }),
      copied: copy.status === 'fulfilled',
      ...(copy.status === 'rejected' ? { copyError: message(copy.reason) } : {})
    };
    window.dispatchEvent(new CustomEvent('zz-image-exported', { detail: result }));
    return result;
  } finally { busy = false; }
}
