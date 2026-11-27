import { useState } from 'react';
import type { CanvasPageRecord } from '../shared/pages.js';
import type { SkinManifest } from '../shared/skin.js';
import { createSkinReference, getSkinComponent } from '../shared/skin.js';
import './pages.css';

export function PageNavigation({ pages, currentId, defaultId, online, backgrounds, onSwitch, onCreate, onRename, onArchive,
  onDefault, onDelete, onReorder, onBackground, onOpenWallpaper, onContinue }: {
  pages: CanvasPageRecord[]; currentId: string; defaultId: string; online: boolean; backgrounds: SkinManifest[];
  onSwitch(id: string): void; onCreate(name: string): void; onRename(page: CanvasPageRecord, name: string): void;
  onArchive(page: CanvasPageRecord, archived: boolean): void; onDefault(id: string): void; onDelete(page: CanvasPageRecord): void;
  onReorder(ids: string[]): void; onBackground(page: CanvasPageRecord, ref: string | null): void; onContinue(page: CanvasPageRecord): void;
  onOpenWallpaper?(): void;
}) {
  const [name, setName] = useState('');
  const current = pages.find(page => page.id === currentId);
  const active = pages.filter(page => !page.archivedAt);
  function reorder(id: string, direction: number) {
    const ordered = [...active]; const from = ordered.findIndex(page => page.id === id), to = from + direction;
    if (from < 0 || to < 0 || to >= ordered.length) return;
    [ordered[from], ordered[to]] = [ordered[to]!, ordered[from]!];
    onReorder(ordered.map(page => page.id));
  }
  return <section className="drawer-section page-navigation" aria-label="页面管理" onPointerDown={event => {
    if ((event.target as Element).closest('button')) event.preventDefault();
  }}>
    <h3>活动页面</h3>
    <nav aria-label="活动页面">{active.map(page => <div className="page-row" key={page.id}>
      <button aria-current={currentId === page.id ? 'page' : undefined} onClick={() => onSwitch(page.id)}>
        {page.name}<small>{page.id === defaultId ? ' · 新项目接收页' : ''}{page.autoCheckPaused ? ' · 检查暂停' : ''}</small>
      </button>
      <button disabled={!online} title="上移页面" aria-label={`上移${page.name}`} onClick={() => reorder(page.id, -1)}>↑</button>
      <button disabled={!online} title="下移页面" aria-label={`下移${page.name}`} onClick={() => reorder(page.id, 1)}>↓</button>
    </div>)}</nav>
    <form onSubmit={event => { event.preventDefault(); if (name.trim()) { onCreate(name.trim()); setName(''); } }}>
      <input aria-label="新页面名称" value={name} onChange={event => setName(event.target.value)} placeholder="新页面名称" maxLength={100} />
      <button disabled={!online || !name.trim()}>新建</button>
    </form>
    {current && <details><summary>管理「{current.name}」</summary>
      {!current.archivedAt ? <>
        <button disabled={!online} onClick={() => { const value = window.prompt('页面名称', current.name); if (value?.trim()) onRename(current, value.trim()); }}>重命名</button>
        <button disabled={!online || current.id === defaultId} onClick={() => onDefault(current.id)}>设为新项目接收页</button>
        <label>本页背景<select disabled={!online} aria-label="本页背景" value={current.wallpaper ? 'wallpaper' : current.backgroundSkinRef ?? ''} onChange={event => onBackground(current, event.target.value || null)}>
          {current.wallpaper && <option value="wallpaper" disabled>本页图片</option>}<option value="">使用看板默认背景</option>{backgrounds.filter(manifest => getSkinComponent(manifest, 'background')).map(manifest => <option key={`${manifest.skinId}@${manifest.version}`} value={createSkinReference(manifest, 'background')}>{manifest.displayName} · {manifest.version}</option>)}
        </select></label>
        {onOpenWallpaper && <button onClick={onOpenWallpaper}>设置背景图片</button>}
        {current.autoCheckPaused && <button disabled={!online} onClick={() => onContinue(current)}>继续本页自动检查</button>}
        <button disabled={!online || active.length < 2} onClick={() => onArchive(current, true)}>归档页面并暂停检查</button>
        <button disabled={!online || active.length < 2 || current.id === defaultId} onClick={() => onDelete(current)}>删除空页面</button>
      </> : <button disabled={!online} onClick={() => onArchive(current, false)}>恢复页面（检查保持暂停）</button>}
    </details>}
    <details><summary>归档页面 · {pages.filter(page => page.archivedAt).length}</summary>
      {pages.some(page => page.archivedAt) && <p>恢复后可以编辑。需要自动检查时，可在该页的管理菜单选择「继续本页自动检查」。</p>}
      {pages.filter(page => page.archivedAt).map(page => <div className="page-row" key={page.id}>
        <button onClick={() => onSwitch(page.id)}>{page.name} · 只读</button>
        <button disabled={!online} onClick={() => onArchive(page, false)} aria-label={`恢复页面「${page.name}」`} title="恢复后，本页自动检查仍暂停">恢复</button>
      </div>)}
    </details>
  </section>;
}
