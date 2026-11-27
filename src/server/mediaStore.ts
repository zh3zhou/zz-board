import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { BoardDatabase } from './database.js';
import { imageInfo, InvalidImageError } from '../shared/imageFormat.js';
import { MAX_IMAGE_PIXELS, mediaIdSchema, type MediaAsset } from '../shared/noteDocument.js';

sharp.cache(false);
sharp.concurrency(1);

export class MediaStore {
  private serial = Promise.resolve();
  private pending = 0;
  constructor(private root: string, private db: BoardDatabase) {}
  /** Bounded original bytes; server decodes and generates its own trusted preview. */
  import(payload: Buffer): Promise<MediaAsset> {
    if (this.pending >= 2) return Promise.reject(new Error('正在处理其他图片，请稍后重试。'));
    this.pending++;
    const work = this.serial.then(() => this.write(payload)).finally(() => { this.pending--; });
    this.serial = work.then(() => undefined, () => undefined);
    return work;
  }
  private async safePath(name: string): Promise<string> {
    await fs.mkdir(this.root, { recursive: true });
    const real = await fs.realpath(this.root);
    if (path.resolve(real).toLowerCase() !== path.resolve(this.root).toLowerCase()) throw new Error('图片目录不能指向其他位置。');
    const file = path.join(real, name);
    try { if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('图片文件不能是链接。'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return file;
  }
  private async write(payload: Buffer): Promise<MediaAsset> {
    const original = payload;
    const info = imageInfo(original);
    const id = createHash('sha256').update(original).digest('hex');
    const known = this.db.getMedia(id);
    if (known) { await this.read(id, false); await this.read(id, true); return known; }
    let preview: Buffer, rotated = false;
    try {
      const decoder = sharp(original, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning', sequentialRead: true });
      const metadata = await decoder.metadata();
      if ((metadata.pages || 1) !== 1 || !['png', 'jpeg', 'webp'].includes(metadata.format || '')) throw new Error('format');
      rotated = [5, 6, 7, 8].includes(metadata.orientation || 1);
      preview = await decoder.autoOrient().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    } catch { throw new InvalidImageError('图片损坏或格式不支持。只接受静态 PNG、JPEG、WebP。'); }
    const files = [[`${id}.original`, original], [`${id}.preview`, preview]] as const;
    const created: string[] = [], temporary: string[] = [];
    try {
      for (const [name, bytes] of files) {
        const destination = await this.safePath(name), temp = await this.safePath(`upload-${randomUUID()}.tmp`);
        temporary.push(temp); await fs.writeFile(temp, bytes, { flag: 'wx' });
        // A previous interrupted import may leave the identical content-addressed file.
        try { const existing = await fs.readFile(destination); if (!existing.equals(bytes)) throw new Error('已存图片校验失败，未覆盖原文件。'); await fs.unlink(temp); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await fs.rename(temp, destination); created.push(destination); }
      }
      const asset: MediaAsset = { id, mime: info.mime, width: rotated ? info.height : info.width, height: rotated ? info.width : info.height, bytes: original.length, previewBytes: preview.length };
      this.db.registerMedia(asset); return asset;
    } catch (error) { for (const file of created) await fs.unlink(file).catch(() => undefined); throw error; }
    finally { for (const file of temporary) await fs.unlink(file).catch(() => undefined); }
  }
  async read(id: string, preview: boolean): Promise<{ file: string; mime: string }> {
    mediaIdSchema.parse(id);
    const asset = this.db.getMedia(id);
    if (!asset) throw new Error('图片不存在。');
    const file = await this.safePath(`${id}.${preview ? 'preview' : 'original'}`);
    if (!(await fs.stat(file)).isFile()) throw new Error('图片文件不可用。');
    return { file, mime: preview ? 'image/png' : asset.mime };
  }
}
