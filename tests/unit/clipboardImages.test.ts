import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clipboardImages, uploadImage } from '../../src/web/mediaClient.js';

const picture = async (format: 'jpeg' | 'png') => new Uint8Array(await sharp({ create: { width: 8, height: 5, channels: 3, background: '#aa4433' } }).toFormat(format).toBuffer());
const item = (file: File, type = file.type) => ({ kind: 'file', type, getAsFile: () => file });
const transfer = (items: Array<ReturnType<typeof item>>, files: File[]) => ({ items, files, types: [] } as unknown as DataTransfer);
const asset = { id: 'a'.repeat(64), width: 8, height: 5 };
afterEach(() => vi.unstubAllGlobals());

describe('clipboard image representations', () => {
  it('preserves distinct file items in order and recovers an empty item list or missing MIME using FileList', () => {
    const a = new File(['dummy'], 'one.png'), b = new File(['other'], 'two.jpg', { type: 'image/jpeg' });
    expect(clipboardImages(transfer([item(a), item(b)], [a, b]))).toEqual([a, b]);
    expect(clipboardImages(transfer([], [a, b]))).toEqual([a, b]);
    expect(clipboardImages(transfer([item(a)], [a, b]))).toEqual([a, b]);
    const anonymous = new File(['sniff before upload'], 'image', {type: 'application/octet-stream'});
    expect(clipboardImages(transfer([], [anonymous]))).toEqual([anonymous]);
  });
  it('uses the alternate representation of that single paste if the primary container is incomplete', async () => {
    const jpeg = await picture('jpeg'), png = await picture('png');
    const incomplete = new File([jpeg.slice(0, -2)], 'one.jpg', { type: 'image/jpeg' });
    const alternate = new File([png], 'one.png', { type: 'image/png' });
    const [source] = clipboardImages(transfer([item(incomplete)], [alternate]));
    const post = vi.fn(async () => Response.json(asset, { status: 201 }));
    vi.stubGlobal('fetch', post);
    expect(await uploadImage(source!)).toEqual(asset);
    expect(post.mock.calls).toHaveLength(1);
    expect(post).toHaveBeenCalledWith('/api/media', expect.objectContaining({ body: alternate }));
  });
  it('can recover a failed decoder using one local embedded PNG, and never retries a storage or network failure as a format error', async () => {
    const primary = new File([await picture('jpeg')], 'source.jpg', { type: 'image/jpeg' });
    const png = await picture('png'), alternate = 'data:image/png;base64,' + Buffer.from(png).toString('base64');
    const post = vi.fn()
      .mockResolvedValueOnce(Response.json({ code: 'invalid_image', error: '解码失败' }, { status: 400 }))
      .mockResolvedValueOnce(Response.json(asset, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ error: '存储不可用' }, { status: 400 }))
      .mockRejectedValueOnce(new Error('网络不可用'));
    vi.stubGlobal('fetch', post);
    expect(await uploadImage({ primary, alternates: [new File(['damaged'], 'fallback.jpg'), alternate] })).toEqual(asset);
    expect(new Uint8Array(await (post.mock.calls[1][1].body as Blob).arrayBuffer())).toEqual(png);
    await expect(uploadImage({ primary, alternates: [alternate] })).rejects.toThrow('存储不可用');
    await expect(uploadImage({ primary, alternates: [alternate] })).rejects.toThrow('网络不可用');
    expect(post).toHaveBeenCalledTimes(4);
  });
});
