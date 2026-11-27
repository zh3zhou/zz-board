import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { BoardDatabase } from './database.js';
import { imageInfo } from '../shared/imageFormat.js';
import { MAX_EXPORT_BYTES, MAX_EXPORT_PIXELS, type ExportSettings, type SavedPng } from '../shared/imageExport.js';

/** Local output only. No caller-supplied filename, overwrite, or canvas-history operation. */
export class ImageExports {
  readonly defaultDirectory: string;
  constructor(private db: BoardDatabase, private dataDir: string, projectRoot?: string) {
    // The desktop passes the bound source root explicitly; portable exports must
    // not jump between release folders or enter a custom private data directory.
    const fallback = path.join(path.dirname(dataDir), path.basename(dataDir) === '.local-data' ? 'exports' : `${path.basename(dataDir)}-exports`);
    try { this.defaultDirectory = this.validateDirectory(projectRoot ? path.join(projectRoot, 'exports') : fallback); }
    catch { this.defaultDirectory = fallback; } // Invalid bindings must not create an unusable/private default.
  }
  settings(): ExportSettings {
    return { directory: this.db.getSetting('imageExportDirectory') || this.defaultDirectory, defaultDirectory: this.defaultDirectory };
  }
  setDirectory(value: string | null): ExportSettings {
    const directory = value === null ? null : this.validateDirectory(value);
    this.db.setSetting('imageExportDirectory', directory);
    return this.settings();
  }
  private validateDirectory(value: string): string {
    if (!value.trim() || value.length > 2048 || /[\x00-\x1f]/.test(value) || value.split(/[\\/]/).includes('..') || !path.isAbsolute(value)
      || value.startsWith('\\\\') || value.startsWith('//')) throw new Error('请选择本机的完整文件夹路径，不使用相对路径、网络路径或设备路径。');
    const normalized = path.resolve(value);
    if (normalized === path.parse(normalized).root || normalized.toLowerCase() === path.resolve(os.homedir()).toLowerCase()) throw new Error('请指定一个导出子文件夹，不直接保存到盘符或用户目录根部。');
    const relative = path.relative(this.dataDir, normalized);
    if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error('请将导出图片放在私有数据库目录之外。');
    return normalized;
  }
  async save(payload: Buffer, kind: 'region' | 'note'): Promise<SavedPng> {
    const info = imageInfo(payload, MAX_EXPORT_BYTES, MAX_EXPORT_PIXELS);
    if (info.mime !== 'image/png' || Math.max(info.width, info.height) > 8192) throw new Error('只保存有效的 PNG，最长边不超过 8192px、总计不超过 3200 万像素。');
    try { await sharp(payload, { limitInputPixels: MAX_EXPORT_PIXELS, failOn: 'warning', sequentialRead: true }).stats(); }
    catch { throw new Error('PNG 内容损坏，未保存。'); }
    const directory = this.validateDirectory(this.settings().directory);
    await fs.mkdir(directory, { recursive: true });
    const real = await fs.realpath(directory);
    if (real.toLowerCase() !== directory.toLowerCase()) throw new Error('导出目录是重定向链接，请在设置中指定实际文件夹。');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(real, `ZZ-Board-${kind}-${stamp}-${randomUUID().slice(0, 8)}.png`);
    const handle = await fs.open(file, 'wx');
    try {
      await handle.writeFile(payload); await handle.sync();
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => undefined);
      try { await fs.unlink(file); }
      catch (cleanup) { if ((cleanup as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`保存未完成，请检查可能残留的文件：${file}`); }
      throw error;
    }
    return { path: file, bytes: payload.length, width: info.width, height: info.height };
  }
}
