import { afterEach, describe, expect, it, vi } from 'vitest';
import { rasterElement, readyForRaster } from '../../src/web/rasterExport.js';

const { toCanvas } = vi.hoisted(() => ({ toCanvas: vi.fn(async (_element, options) => ({ width: options.width * options.pixelRatio, height: options.height * options.pixelRatio })) }));
vi.mock('html-to-image', () => ({ toCanvas }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
function environment(images: unknown[] = []) {
  const context = { fillRect: vi.fn(), drawImage: vi.fn(), getImageData: () => ({ data: [20, 20, 20, 255] }), imageSmoothingEnabled: false, imageSmoothingQuality: 'low' };
  vi.stubGlobal('document', { fonts: { ready: Promise.resolve() }, documentElement: {}, createElement: () => ({ width: 0, height: 0, getContext: () => context, toDataURL: () => 'data:image/png;base64,fixture' }) });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '#141414' }));
  return { element: { querySelectorAll: () => images } as unknown as HTMLElement, context };
}
describe('image export resolution', () => {
  it.each([1, 2, 4])('rasterizes SVG at final %s× pixels rather than stretching a logical-size image', async scale => {
    const { element } = environment();
    const canvas = await rasterElement(element, 300, 180, scale);
    expect(canvas).toMatchObject({ width: 300 * scale, height: 180 * scale });
    expect(toCanvas).toHaveBeenCalledWith(element, expect.objectContaining({ width: 300 * scale, height: 180 * scale, pixelRatio: 1, skipAutoScale: true,
      style: expect.objectContaining({ width: '300px', height: '180px', transform: `scale(${scale})`, transformOrigin: 'top left' }) }));
  });
  it('samples original pixels at output size, never fetches or enlarges the preview', async () => {
    const img = { dataset: { mediaId: 'a'.repeat(64) }, src: '/preview', getBoundingClientRect: () => ({ width: 600 }), decode: vi.fn() };
    const { element, context } = environment([img]);
    const fetch = vi.fn(async () => ({ ok: true, blob: async () => new Blob() })); vi.stubGlobal('fetch', fetch);
    const bitmap = { width: 4096, height: 2048, close: vi.fn() }; vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    await readyForRaster(element, 4);
    expect(fetch).toHaveBeenCalledWith(`/api/media/${'a'.repeat(64)}/original`, expect.anything());
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 2400, 1200);
    expect(context.imageSmoothingQuality).toBe('high');
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
  it('does not invent resolution when the original is small', async () => {
    const img = { dataset: { mediaId: 'b'.repeat(64) }, src: '', getBoundingClientRect: () => ({ width: 600 }), decode: vi.fn() };
    const { element, context } = environment([img]);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob() })));
    const bitmap = { width: 120, height: 80, close: vi.fn() }; vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    await readyForRaster(element, 4);
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 120, 80);
  });
  it('fails visibly rather than exporting a preview when the original is unavailable', async () => {
    const { element } = environment([{ dataset: { mediaId: 'c'.repeat(64) }, getBoundingClientRect: () => ({ width: 200 }) }]);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    await expect(readyForRaster(element, 2)).rejects.toThrow('原图暂不可用');
  });
  it('refuses excessive output instead of allowing library auto-downscaling', async () => {
    const { element } = environment();
    await expect(rasterElement(element, 4100, 100, 2)).rejects.toThrow('导出尺寸过大');
    expect(toCanvas).not.toHaveBeenCalled();
  });
});
