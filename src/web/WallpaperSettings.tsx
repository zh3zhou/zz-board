import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { CanvasPageRecord } from '../shared/pages.js';
import { MAX_WALLPAPER_IMAGES, MAX_WALLPAPER_PRESETS, sameWallpaper, wallpaperImages, withWallpaperImages,
  type Wallpaper, type WallpaperImage, type WallpaperPresetSummary } from '../shared/wallpaper.js';
import { api } from './api.js';
import { mediaUrl, uploadImage } from './mediaClient.js';
import { WallpaperScene } from './WallpaperScene.js';
import { WallpaperStudio } from './WallpaperStudio.js';

export { WallpaperScene };
const blank: Wallpaper = { assetId: null, fit: 'cover', opacity: .65 };
interface Draft { value: Wallpaper; basis: Wallpaper | null; revision?: number }
interface LocalImage { file: File; url: string; savedId?: string }
interface Props {
  global: Wallpaper | null; page?: CanvasPageRecord; presets?: WallpaperPresetSummary[];
  online: boolean; onSaved(): Promise<void>;
}

export function WallpaperSettings({ global, page, presets, online, onSaved, initialScope = 'board', leaveGuard }: Props & {
  initialScope?: 'page' | 'board'; leaveGuard?: RefObject<(() => boolean) | null>;
}) {
  const [scope, setScope] = useState<'page' | 'board'>(page ? initialScope : 'board');
  const [busy, setBusy] = useState(false);
  const dirty = useRef(false);
  useLayoutEffect(() => {
    if (!leaveGuard) return;
    leaveGuard.current = () => !busy && (!dirty.current || window.confirm('放弃未应用的背景改动？'));
    return () => { leaveGuard.current = null; };
  }, [busy, leaveGuard]);
  const target = scope === 'page' ? page : undefined;
  return <section className="wallpaper-settings">
    <label>应用范围<select value={scope} disabled={busy} onChange={event => {
      if (!dirty.current || window.confirm('放弃未应用的改动并切换范围？')) setScope(event.target.value as typeof scope);
    }}>
      <option value="board">全板默认</option>
      {page && <option value="page">当前页 · {page.name}</option>}
    </select></label>
    <WallpaperEditor key={target?.id ?? 'board'} global={global} page={target} presets={presets} online={online} onSaved={onSaved}
      reportBusy={setBusy} reportDirty={v => { dirty.current = v; }} />
  </section>;
}

function WallpaperEditor({ page, global, presets = [], online, onSaved, reportBusy, reportDirty }: Props & {
  reportBusy(value: boolean): void; reportDirty(value: boolean): void;
}) {
  const current = page ? page.wallpaper ?? null : global;
  const visible = current ?? (page && !page.backgroundSkinRef ? global : null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [studio, setStudio] = useState(false);
  const [selected, setSelected] = useState(0);
  const [presetId, setPresetId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [ratio, setRatio] = useState(() => typeof window === 'undefined' ? 16 / 9 : window.innerWidth / Math.max(1, window.innerHeight));
  const fileInput = useRef<HTMLInputElement>(null);
  const insertion = useRef<'add' | 'replace'>('replace');
  const localImages = useRef(new Map<string, LocalImage>());
  const saving = useRef(false);
  const saveId = useRef('');
  const base: Draft = draft ?? { value: visible ?? blank, basis: current, revision: page?.revision };
  const value = base.value, images = wallpaperImages(value);
  const index = Math.min(selected, Math.max(0, images.length - 1)), active = images[index];
  const hasContent = images.length > 0 || !!value.strokes?.length;
  const dirty = !!draft && !sameWallpaper(value, visible ?? blank);
  const locked = !online || busy || !!page?.archivedAt;
  useLayoutEffect(() => { reportDirty(dirty); }, [dirty, reportDirty]);
  useEffect(() => {
    const files = localImages.current;
    const resize = () => setRatio(window.innerWidth / Math.max(1, window.innerHeight));
    window.addEventListener('resize', resize);
    return () => { window.removeEventListener('resize', resize); for (const image of files.values()) URL.revokeObjectURL(image.url); };
  }, []);
  const urlFor = (id: string) => localImages.current.get(id)?.url ?? mediaUrl(id, true);
  function releaseUnused(next: Wallpaper) {
    const used = new Set(wallpaperImages(next).map(image => image.assetId));
    for (const [id, image] of localImages.current) if (!used.has(id)) {
      URL.revokeObjectURL(image.url); localImages.current.delete(id);
    }
  }
  function change(next: Wallpaper) {
    releaseUnused(next); setDraft({ ...base, value: next }); setMessage(''); saveId.current = '';
  }
  function editLayer(patch: Partial<WallpaperImage>) {
    change(withWallpaperImages(value, images.map((image, i) => i === index ? { ...image, ...patch } : image)));
  }
  function chooseFile(file: File) {
    if (locked) return;
    const add = insertion.current === 'add' || !active;
    if (add && images.length >= MAX_WALLPAPER_IMAGES) return;
    const id = 'local:' + crypto.randomUUID();
    localImages.current.set(id, { file, url: URL.createObjectURL(file) });
    const next = [...images], position = add ? next.length : index;
    next[position] = !add && active ? { ...active, assetId: id } :
      { assetId: id, fit: images.length ? 'contain' : 'cover', opacity: images.length ? 1 : .65,
        ...(images.length ? { placement: { x: 0, y: 0, scale: 50 } } : {}) };
    setSelected(position); change(withWallpaperImages(value, next));
  }
  async function resolveMedia(): Promise<Wallpaper> {
    const saved: WallpaperImage[] = [];
    for (const image of images) {
      const local = localImages.current.get(image.assetId);
      if (local) local.savedId ??= (await uploadImage(local.file)).id;
      saved.push(local ? { ...image, assetId: local.savedId! } : image);
    }
    return withWallpaperImages(value, saved);
  }
  async function run(work: () => Promise<void>) {
    if (locked || saving.current) return;
    saving.current = true; reportBusy(true); setBusy(true); setMessage('');
    try { await work(); }
    catch (e) { setMessage(e instanceof Error ? e.message : '背景操作未完成，请重试。'); }
    finally { saving.current = false; reportBusy(false); setBusy(false); }
  }
  async function refresh(success: string) {
    try { await onSaved(); setMessage(success); }
    catch { setMessage(success + ' 看板尚未刷新，请重新连接。'); }
  }
  function apply(clear: boolean) {
    return run(async () => {
      if (!sameWallpaper(base.basis, current) || (page && base.revision !== page.revision)) {
        throw new Error('背景设置已更新。请放弃草稿，确认当前背景后再应用。');
      }
      const result = clear || !hasContent ? null : await resolveMedia();
      if (page) await api.updatePage(page.id, { revision: base.revision!, wallpaper: result, backgroundSkinRef: null });
      else await api.setWallpaper({ previous: base.basis, value: result });
      releaseUnused(blank); setDraft(null); setSelected(0); saveId.current = '';
      await refresh(page && !result ? '已恢复继承全板背景。' : '背景已保存。');
    });
  }
  function savePreset() {
    return run(async () => {
      const wallpaper = await resolveMedia();
      saveId.current ||= crypto.randomUUID();
      await api.saveWallpaperPreset({ id: saveId.current, name: name.trim(), wallpaper });
      setPresetId(saveId.current); setName(''); saveId.current = '';
      if (draft) { setDraft({ ...draft, value: wallpaper }); releaseUnused(wallpaper); }
      await refresh('已存入背景收藏。');
    });
  }
  function loadPreset() {
    return run(async () => {
      if (dirty && !window.confirm('用这套收藏替换未应用的背景改动？')) return;
      const preset = await api.wallpaperPreset(presetId);
      saveId.current = ''; releaseUnused(preset.wallpaper); setSelected(0);
      setDraft({ value: preset.wallpaper, basis: current, revision: page?.revision }); setStudio(true);
      setMessage('已载入收藏，应用后会显示在看板上。');
    });
  }
  return <>
    <small>{page ? page.archivedAt ? '归档页面只读。' : current ? '本页使用独立背景。' : page.backgroundSkinRef ? '本页使用单独选择的皮肤背景。' : '本页继承全板背景。' : '未单独设置的页面会使用这个背景。'}</small>
    <div style={{ '--wallpaper-screen-ratio': ratio } as CSSProperties}>
      {studio ? <WallpaperStudio value={value} index={index} urlFor={urlFor} locked={locked} onChange={change} /> :
        <button type="button" className="wallpaper-preview" onClick={() => setStudio(true)} aria-label="进入背景布置画布">
          <WallpaperScene value={value} urlFor={urlFor} preview /><span>布置与绘制</span>
        </button>}
    </div>
    {images.length > 1 && <label>当前图层<select value={index} disabled={busy} onChange={e => setSelected(Number(e.target.value))}>
      {images.map((_, i) => <option value={i} key={i}>图片 {i + 1}{i === 0 ? ' · 底层' : ''}</option>)}
    </select></label>}
    <input hidden ref={fileInput} type="file" aria-label="选择本机图片" accept="image/png,image/jpeg,image/webp" disabled={locked}
      onChange={e => { const file = e.target.files?.[0]; if (file) chooseFile(file); e.target.value = ''; }} />
    <div className="wallpaper-actions">
      <button disabled={locked} onClick={() => { insertion.current = 'replace'; fileInput.current?.click(); }}>{active ? '替换这张图' : '选择本机图片'}</button>
      {active && <><button disabled={locked || images.length >= MAX_WALLPAPER_IMAGES} onClick={() => { insertion.current = 'add'; fileInput.current?.click(); }}>添加一层图片</button>
        <button disabled={locked} onClick={() => change(withWallpaperImages(value, images.filter((_, i) => i !== index)))}>移除这张图</button></>}
    </div>
    {active && <>
      <label>显示方式<select value={active.fit} disabled={locked} onChange={e => editLayer({ fit: e.target.value as Wallpaper['fit'] })}>
        <option value="cover">铺满</option><option value="contain">完整显示</option><option value="tile">平铺</option>
      </select></label>
      <label>图片不透明度 · {Math.round(active.opacity * 100)}%<input type="range" min="0" max="100" value={Math.round(active.opacity * 100)} disabled={locked}
        onChange={e => editLayer({ opacity: Number(e.target.value) / 100 })} /></label>
    </>}
    <div className="wallpaper-actions">
      <button disabled={locked || !dirty} onClick={() => void apply(false)}>{busy ? '正在保存…' : '应用背景图'}</button>
      {draft && <button disabled={busy} onClick={() => { releaseUnused(blank); setDraft(null); setMessage(''); saveId.current = ''; }}>放弃草稿</button>}
      {(current || page?.backgroundSkinRef) && <button disabled={locked} onClick={() => void apply(true)}>{page ? '恢复继承全板背景' : '移除全板背景图'}</button>}
    </div>
    <details className="wallpaper-presets"><summary>背景收藏{presets.length ? ` · ${presets.length}` : ''}</summary>
      {presets.length > 0 && <><label>已存的背景<select value={presets.some(p => p.id === presetId) ? presetId : ''} disabled={locked} onChange={e => setPresetId(e.target.value)}>
        <option value="">选择一套背景</option>{presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>
        <div className="wallpaper-actions"><button disabled={locked || !presets.some(p => p.id === presetId)} onClick={() => void loadPreset()}>载入收藏</button>
          <button disabled={locked || !presets.some(p => p.id === presetId)} onClick={() => void run(async () => {
            await api.deleteWallpaperPreset(presetId); setPresetId(''); await refresh('收藏已移除，可撤销。');
          })}>移除收藏</button></div></>}
      <label>收藏名<input value={name} maxLength={60} disabled={locked} onChange={e => { setName(e.target.value); saveId.current = ''; }} /></label>
      <button disabled={locked || !name.trim() || !hasContent || presets.length >= MAX_WALLPAPER_PRESETS} onClick={() => void savePreset()}>另存到收藏</button>
    </details>
    {message && <small role="status">{message}</small>}
  </>;
}
