import { useState } from 'react';
import type { SkinComponents } from '../shared/schema.js';
import { SKIN_PACKAGE_SCHEMA_VERSION, getSkinComponent, skinVersionKey, type SkinComponentId, type SkinManifest } from '../shared/skin.js';
import { strokeSvgPath } from './inkGeometry.js';
import { NoteDocumentView } from './NoteDocumentView.js';
import { MenuHeader, type MenuNavigation } from './MenuHeader.js';
import { composedSkinStyle, skinComponentManifest, skinShape } from './skinRuntime.js';

export interface SkinLibraryItem {
  key: string;
  skinId: string;
  version: string;
  displayName: string;
  description: string;
  builtIn: boolean;
  schemaVersion: SkinManifest['schemaVersion'];
  components: SkinComponentId[];
}

interface SkinPanelProps extends MenuNavigation {
  items: SkinLibraryItem[];
  manifests: SkinManifest[];
  activeKey: string | null;
  activeComponents: SkinComponents;
  selectedNodeKind?: 'task' | 'note';
  online: boolean;
  onApplySkin(key: string): Promise<void>;
  onApplyComponent(key: string, component: SkinComponentId): Promise<void>;
  onApplyToSelected(key: string, component: 'taskBubble' | 'note'): Promise<void>;
  onClearSelected(): Promise<void>;
  onImport(text: string): Promise<void>;
}

type SkinTab = 'official' | 'mine' | 'mixer';

export function SkinPanel({ items, manifests, activeKey, activeComponents, selectedNodeKind, online, onApplySkin, onApplyComponent, onApplyToSelected, onClearSelected, onImport, ...navigation }: SkinPanelProps) {
  const [tab, setTab] = useState<SkinTab>('official');
  const [copyStatus, setCopyStatus] = useState('');
  async function importFile(file: File | undefined) {
    if (!file) return;
    await onImport(await file.text());
  }
  const official = items.filter((item) => item.builtIn && item.schemaVersion === SKIN_PACKAGE_SCHEMA_VERSION);
  const legacy = items.filter((item) => item.builtIn && item.schemaVersion < SKIN_PACKAGE_SCHEMA_VERSION);
  const mine = items.filter((item) => !item.builtIn);

  return <section className="menu-page panel-shell skin-panel" aria-label="皮肤库">
    <MenuHeader title="皮肤库" {...navigation}>
      <nav className="panel-tabs" aria-label="皮肤分类">
        <button aria-current={tab === 'official'} onClick={() => setTab('official')}>内置</button>
        <button aria-current={tab === 'mine'} onClick={() => setTab('mine')}>已导入</button>
        <button aria-current={tab === 'mixer'} onClick={() => setTab('mixer')}>混搭外观</button>
      </nav>
    </MenuHeader>
    <div className="panel-scroll">
      {tab !== 'mixer' && <details className="panel-fold skin-create"><summary>用 Codex 制作外观</summary>
        <p>{SKIN_CREATION_PROMPT}</p>
        <button onClick={async () => {
          try { await navigator.clipboard.writeText(SKIN_CREATION_PROMPT); setCopyStatus('指令已复制。'); }
          catch { setCopyStatus('请选中上方指令复制。'); }
        }}>复制制作指令</button>
        <span role="status">{copyStatus}</span>
      </details>}
      {tab === 'official' && <>
        <SkinCards items={official} manifests={manifests} activeKey={activeKey} selectedNodeKind={selectedNodeKind} online={online} onApplySkin={onApplySkin} onApplyToSelected={onApplyToSelected} />
        <details className="panel-fold"><summary>旧版内置皮肤 · {legacy.length}</summary><SkinCards items={legacy} manifests={manifests} activeKey={activeKey} selectedNodeKind={selectedNodeKind} online={online} onApplySkin={onApplySkin} onApplyToSelected={onApplyToSelected} /></details>
      </>}
      {tab === 'mine' && <>
        <p className="settings-help">自己制作或他人分享的皮肤（Skin）都可以在这里导入。皮肤只含外观数据和本地图片。选择 .zzskin 文件后可以预览，点应用时才会改变看板外观。</p>
        <label className="skin-import"><span>导入 .zzskin</span><input type="file" accept=".zzskin,application/json" disabled={!online} onChange={(event) => {
          const input = event.currentTarget;
          void importFile(input.files?.[0]).finally(() => { input.value = ''; });
        }} /></label>
        {mine.length ? <SkinCards items={mine} manifests={manifests} activeKey={activeKey} selectedNodeKind={selectedNodeKind} online={online} onApplySkin={onApplySkin} onApplyToSelected={onApplyToSelected} /> : <p className="empty-summary">还没有导入皮肤。</p>}
      </>}
      {tab === 'mixer' && <section className="skin-mixer">
        <p className="settings-help">可以分别为背景、便签或连线选择皮肤。每项只列出提供这种外观的皮肤。</p>
        {(['background', 'chrome', 'taskBubble', 'note', 'link', 'inkPalette'] as SkinComponentId[]).map((component) => <label key={component}>
          <span>{componentLabel(component)}</span>
          <select disabled={!online} value={referenceKey(activeComponents[component]) || activeKey || ''} onChange={(event) => void onApplyComponent(event.target.value, component)}>
            {items.filter((item) => item.components.includes(component)).map((item) => <option value={item.key} key={`${component}:${item.key}`}>{item.displayName}</option>)}
          </select>
        </label>)}
        {selectedNodeKind && <button className="skin-follow-button" disabled={!online} onClick={() => void onClearSelected()}>让选中项跟随看板外观</button>}
      </section>}
    </div>
  </section>;
}

function SkinCards({ items, manifests, activeKey, selectedNodeKind, online, onApplySkin, onApplyToSelected }: {
  items: SkinLibraryItem[]; manifests: SkinManifest[]; activeKey: string | null; selectedNodeKind?: 'task' | 'note'; online: boolean;
  onApplySkin(key: string): Promise<void>; onApplyToSelected(key: string, component: 'taskBubble' | 'note'): Promise<void>;
}) {
  return <div className="skin-library">{items.map((item) => {
    const manifest = manifests.find((candidate) => skinVersionKey(candidate) === item.key);
    return <article className="skin-card" key={item.key}>
      <div className="skin-card-copy"><strong>{item.displayName}{activeKey === item.key ? ' · 当前' : ''}</strong><small>{item.description}</small><small>{item.builtIn ? `内置 · ${item.version}` : `已导入 · ${item.version}`}</small></div>
      {manifest && <SkinSample manifests={manifests} skinKey={item.key} />}
      <div className="skin-card-actions">
        <button disabled={!online || activeKey === item.key} onClick={() => void onApplySkin(item.key)}>整套应用</button>
        {selectedNodeKind && item.components.includes(selectedNodeKind === 'note' ? 'note' : 'taskBubble') && <button disabled={!online} onClick={() => void onApplyToSelected(item.key, selectedNodeKind === 'note' ? 'note' : 'taskBubble')}>{selectedNodeKind === 'note' ? '仅用于这张便签' : '仅用于这个项目气泡'}</button>}
      </div>
    </article>;
  })}</div>;
}

const SKIN_CREATION_PROMPT = '请按 ZZ Board 配套源码里的 skills/create-zz-board-skin/SKILL.md，把「蓝墨水写在暖白方格纸上」做成一套 V3 皮肤，先给我预览。';
const sampleBody = '雨天走访时，大家最先看的是站牌上的地名。下一轮把路线和换乘信息放在一起，再请第一次来的人试读。\n\n周四带上两份大字样稿，记录读者第一次停下来找方向的位置。';
const sampleInk = strokeSvgPath({
  tool: 'pen', size: 2.6,
  points: [[32, 132], [44, 128], [58, 132], [75, 127], [88, 128], [105, 125]].map(([x, y]) => ({ x, y, pressure: 0.55 }))
});

export function SkinSample({ manifests, skinKey }: { manifests: SkinManifest[]; skinKey: string }) {
  const style = composedSkinStyle(manifests, skinKey);
  const task = skinComponentManifest(manifests, skinKey, 'taskBubble');
  const source = skinComponentManifest(manifests, skinKey, 'inkPalette');
  const palette = source && getSkinComponent(source, 'inkPalette');
  return <section className="skin-sample" aria-label="外观样板" style={style}>
    <div className="skin-sample-canvas">
      <svg className="skin-sample-lines" viewBox="0 0 300 148" preserveAspectRatio="none" aria-hidden="true">
        <path className="canvas-link react-flow__edge-path" d="M 63 67 C 114 50 130 94 192 88" fill="none" style={{ stroke: 'var(--edge)', strokeWidth: 'var(--skin-link-width)' }} vectorEffect="non-scaling-stroke" />
        <path d={sampleInk} fill="var(--skin-ink-primary)" />
      </svg>
      <div className="skin-sample-toolbar"><span>画笔</span>{palette && 'colors' in palette && palette.colors.slice(0, 4).map((color, index) => <i aria-hidden="true" key={index} style={{ backgroundColor: color }} />)}</div>
      <div className="bubble bubble-task skin-sample-task" data-priority="p2" data-shape={skinShape(task, 'taskBubble')}><div className="bubble-surface"><span className="bubble-title">街区导览</span></div>
        <span className="bubble-priority-badge">关注</span>
      </div>
      <div className="bubble bubble-note is-selected skin-sample-note" data-priority="p1"><div className="bubble-surface"><NoteDocumentView body={sampleBody} /></div>
        <span className="bubble-priority-badge">优先</span>
      </div>
    </div>
    <details className="skin-sample-reader"><summary>放大试读</summary>
      <div className="focused-note-paper"><header><h2>走访笔记</h2></header>
        <div className="focused-note-body"><NoteDocumentView body={sampleBody} /></div>
      </div>
    </details>
  </section>;
}

function referenceKey(reference: string | undefined): string | undefined { return reference?.split('/')[0]; }

function componentLabel(component: SkinComponentId): string {
  return ({ background: '背景', chrome: '界面', taskBubble: '项目气泡', note: '便签', link: '连线', inkPalette: '墨迹色板' } as const)[component];
}
