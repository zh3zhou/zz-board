import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { BoardDatabase } from '../../src/server/database.js';
import { MediaStore } from '../../src/server/mediaStore.js';

describe('complete synthetic local-data recovery', () => {
  it('restores a closed database together with original pictures, references and undo history', async () => {
    const parent = path.resolve('.tmp'); await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, 'full-backup-'));
    const source = path.join(root, 'source'), backup = path.join(root, 'backup'), restored = path.join(root, 'restored');
    let db: BoardDatabase | undefined;
    try {
      db = new BoardDatabase(path.join(source, 'zz-board.sqlite'));
      const media = new MediaStore(path.join(source, 'media'), db);
      const original = await sharp({ create: { width: 48, height: 32, channels: 4, background: '#4a9871' } }).png().toBuffer();
      const asset = await media.import(original);
      const backgroundBytes = await sharp({ create: { width: 34, height: 42, channels: 3, background: '#9764bd' } }).png().toBuffer();
      const backgroundAsset = await media.import(backgroundBytes);
      const preset = { id:randomUUID(), name:'Synthetic background', wallpaper:{ assetId:backgroundAsset.id, fit:'contain' as const, opacity:.5, placement:{ x:23, y:11, scale:80 } } };
      db.changeWallpaperPreset(preset.id, preset);
      const picture = db.createNote({ title: 'Synthetic picture', body: '', x: 80, y: 40, width: 160, height: 120,
        noteDocument: { version: 1, content: [{ type: 'image', assetId: asset.id, side: 'right', width: 100 }] } });
      const note = db.createNote({ title: 'Synthetic note', body: '中文恢复样本', x: 300, y: 80, width: 200, height: 160 });
      db.createLink(note.id, picture.id, 'Synthetic connection');
      db.createAnnotation(note.id, 'Synthetic annotation');
      const board = db.getBoard(), history = db.getHistoryStatus();
      db.close(); db = undefined; // The documented full-copy procedure requires a real exit first.
      await fs.cp(source, backup, { recursive: true, errorOnExist: true, force: false });
      await fs.cp(backup, restored, { recursive: true, errorOnExist: true, force: false });
      const digest = async (file: string) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
      expect(await digest(path.join(restored, 'zz-board.sqlite'))).toBe(await digest(path.join(source, 'zz-board.sqlite')));
      for (const file of await fs.readdir(path.join(source, 'media'))) {
        expect(await digest(path.join(restored, 'media', file))).toBe(await digest(path.join(source, 'media', file)));
      }
      db = new BoardDatabase(path.join(restored, 'zz-board.sqlite'));
      expect(db.getBoard()).toEqual(board); // Also checks that current migrations are idempotent on reopen.
      expect(db.getHistoryStatus()).toEqual(history);
      const recoveredMedia = new MediaStore(path.join(restored, 'media'), db);
      expect(db.getWallpaperPreset(preset.id)).toEqual(preset);
      expect(await fs.readFile((await recoveredMedia.read(backgroundAsset.id, false)).file)).toEqual(backgroundBytes);
      expect(await fs.readFile((await recoveredMedia.read(asset.id, false)).file)).toEqual(original);
      expect(await sharp((await recoveredMedia.read(asset.id, true)).file).metadata()).toMatchObject({ width: 48, height: 32 });
      db.undo(); expect(db.getBoard().annotations).toHaveLength(0);
      db.redo(); expect(db.getBoard().annotations).toEqual(board.annotations);
      // A database-only recovery can retain image references while losing image bytes.
      await expect(new MediaStore(path.join(root, 'missing-images'), db).read(asset.id, false)).rejects.toThrow();
    } finally {
      db?.close();
      if (path.dirname(root) !== parent || !path.basename(root).startsWith('full-backup-') || (await fs.lstat(root)).isSymbolicLink()) throw new Error('Unsafe fixture cleanup.');
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
