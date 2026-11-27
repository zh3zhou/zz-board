import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { BoardDatabase } from '../../src/server/database.js';
import { loadConfig } from '../../src/server/config.js';
import { DEFAULT_PAGE_ID } from '../../src/shared/pages.js';
import { sameWallpaper, type Wallpaper } from '../../src/shared/wallpaper.js';

it('saves drawings and independently placed images, reopens named backgrounds and keeps undo, media and conflict checks', async () => {
  const parent = path.resolve('.tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'wallpaper-studio-'));
  const config = loadConfig({ ZZ_BOARD_DATA_DIR: root });
  const file = path.join(root, 'fixture.sqlite');
  const open = () => buildApp(config, { db: new BoardDatabase(file) });
  const writes = { 'x-zz-board-mutation': '1' };
  let app = await open();
  try {
    const db = app.zzServices.db;
    const png = await sharp({create:{width:42, height:48, channels:3, background:'#638bd3'}}).png().toBuffer();
    const upload = await app.inject({ method:'POST', url:'/api/media', headers:{...writes, 'content-type':'application/octet-stream'}, payload:png });
    const imageId: string = upload.json().id;
    const drawn: Wallpaper = { assetId:null, fit:'cover', opacity:.65, strokes:[{ color:'#556677', size:8, points:[[50,250],[100,500]] }] };
    const placed: Wallpaper = { ...drawn, assetId:imageId, placement:{x:20,y:-38,scale:75},
      layers:[{ assetId:imageId, fit:'contain', opacity:.28, placement:{x:-25,y:35,scale:25} }] };
    const url = '/api/settings/wallpaper/presets';
    const first = { id:randomUUID(), name:'笔迹', wallpaper:drawn };
    const second = { id:randomUUID(), name:'两层图片', wallpaper:placed };
    const revision = () => app.zzServices.db.getBoard().boardRevision;
    const save = (preset: unknown) => app.inject({ method:'POST', url, headers:writes, payload:preset as object });
    const get = (id: string) => app.inject({ method:'GET', url:`${url}/${id}` });
    expect((await app.inject({ method:'POST', url, payload:first })).statusCode).toBe(403);
    expect((await save(first)).statusCode).toBe(204);
    const afterSave = revision();
    expect((await save(first)).statusCode).toBe(204);
    expect((await save({...first, name:'同一请求的冲突内容'})).statusCode).toBe(409);
    expect((await save({ ...second, wallpaper:{...placed, layers:[{ ...placed.layers![0]!, assetId:'0'.repeat(64) }] } })).statusCode).toBe(409);
    expect((await save({ ...second, wallpaper:{...placed, placement:{x:101,y:0,scale:100}} })).statusCode).toBe(400);
    expect(revision()).toBe(afterSave);
    expect((await save(second)).statusCode).toBe(204);
    expect(db.getBoard().settings.wallpaperPresets).toEqual(expect.arrayContaining([
      {id:first.id, name:first.name}, {id:second.id, name:second.name}
    ]));
    expect(db.getBoard().settings.wallpaper).toBeNull();
    const endpoint = '/api/settings/wallpaper';
    const apply = (previous: Wallpaper | null, value: Wallpaper) => app.inject({method:'PATCH', url:endpoint, headers:writes, payload:{previous,value}});
    expect((await apply(null, placed)).statusCode).toBe(200);
    expect((await apply({...placed, placement:{x:20,y:-37,scale:75}}, drawn)).statusCode).toBe(409);
    const page = db.getPage(DEFAULT_PAGE_ID);
    expect((await app.inject({method:'PATCH', url:`/api/pages/${page.id}`, headers:writes,
      payload:{revision:page.revision,wallpaper:drawn}})).statusCode).toBe(200);
    db.undo(); expect(db.getPage(page.id).wallpaper).toBeNull();
    db.redo(); expect(db.getPage(page.id).wallpaper).toEqual(drawn);
    await app.close(); app = await open();
    expect((await get(first.id)).json()).toEqual(first);
    expect(sameWallpaper((await get(second.id)).json().wallpaper, placed)).toBe(true);
    expect(app.zzServices.db.getBoard().settings.wallpaper).toEqual(placed);
    expect(app.zzServices.db.getPage(page.id).wallpaper).toEqual(drawn);
    expect((await app.inject({method:'DELETE', url:`${url}/${second.id}`, headers:writes})).statusCode).toBe(204);
    expect((await get(second.id)).statusCode).toBe(404);
    expect(app.zzServices.db.getBoard().settings.wallpaper).toEqual(placed);
    app.zzServices.db.undo(); expect((await get(second.id)).json()).toEqual(second);
    expect((await app.inject({method:'GET', url:`/api/media/${imageId}/original`})).rawPayload).toEqual(png);
  } finally {
    await app.close();
    if (path.dirname(root) !== parent || !path.basename(root).startsWith('wallpaper-studio-')) throw Error('Unexpected test directory');
    await rm(root, {recursive:true, force:true});
  }
});

it('updates an untouched factory page name and preserves an explicitly renamed page on reopen', async () => {
  const parent = path.resolve('.tmp'); await mkdir(parent,{recursive:true});
  const root = await mkdtemp(path.join(parent,'page-name-')), file = path.join(root,'fixture.sqlite');
  let db = new BoardDatabase(file);
  try {
    db.close();
    const previous = new DatabaseSync(file);
    try { previous.prepare('UPDATE canvas_pages SET name=? WHERE id=?').run('默认页', DEFAULT_PAGE_ID); }
    finally { previous.close(); }
    db = new BoardDatabase(file);
    expect(db.getPage(DEFAULT_PAGE_ID).name).toBe('page 1');
    db.updatePage(DEFAULT_PAGE_ID,{name:'我的第一页',revision:0}); db.close();
    db = new BoardDatabase(file); expect(db.getPage(DEFAULT_PAGE_ID).name).toBe('我的第一页');
    db.updatePage(DEFAULT_PAGE_ID,{name:'默认页',revision:1}); db.close();
    db = new BoardDatabase(file); expect(db.getPage(DEFAULT_PAGE_ID).name).toBe('默认页');
  } finally {
    db.close();
    if (path.dirname(root) !== parent || !path.basename(root).startsWith('page-name-')) throw Error('Unexpected test directory');
    await rm(root,{recursive:true,force:true});
  }
});
