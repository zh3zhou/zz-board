import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ColorPalette, DEFAULT_COLOR_SLOTS } from './ColorPalette.js';
import { TrialDiagnosticsStatus } from './TrialDiagnosticsStatus.js';
import { APP_VERSION } from '../shared/version.js';
import type { DrawingPreferences } from '../shared/schema.js';
import type { HealthStatus } from './api.js';
import { api } from './api.js';
import type { ExportSettings } from '../shared/imageExport.js';
import {
  mergeShortcuts,
  shortcutConflicts,
  shortcutLabels,
  type ShortcutAction,
  type ShortcutMap
} from './shortcuts.js';

export const defaultDrawingPreferences: DrawingPreferences = {
  penColor: '#2f3b39',
  penSize: 4,
  highlighterColor: '#e7c95c',
  highlighterSize: 18,
  highlighterColorSlots: [...DEFAULT_COLOR_SLOTS],
  eraserMode: 'whole',
  lassoMode: 'ink',
  layer: 'background',
  paletteCollapsed: true
};

export interface SettingsDraft {
  keyBindings?: Partial<ShortcutMap>;
  drawingPreferences?: Partial<DrawingPreferences>;
}

interface ControlSettingsProps {
  shortcuts: ShortcutMap;
  drawing: DrawingPreferences;
  draft: SettingsDraft;
  onDraftChange(draft: SettingsDraft): void;
  online: boolean;
  highlighterOpacity?: number;
  onSave(value: { keyBindings: ShortcutMap; drawingPreferences: DrawingPreferences }): Promise<void>;
  onSaveError?(message: string): void;
}

interface DataSettingsProps {
  online: boolean;
  serviceHealth?: (HealthStatus & { checkedAt: string }) | null;
}

const shortcutSections: Array<{ title: string; actions: ShortcutAction[] }> = [
  { title: '常用', actions: ['menu', 'newNote', 'fitView'] },
  { title: '优先级', actions: ['priority1', 'priority2', 'priority3', 'priorityClear'] },
  { title: '绘制工具', actions: ['selectTool', 'penTool', 'highlighterTool', 'eraserTool', 'lassoTool'] },
  { title: '历史', actions: ['undo', 'redo'] }
];

export function ControlSettings({ shortcuts, drawing, online, onSave, onSaveError, highlighterOpacity = .26, draft, onDraftChange }: ControlSettingsProps) {
  const draftShortcuts = useMemo(() => ({ ...mergeShortcuts(shortcuts), ...draft.keyBindings }), [shortcuts, draft.keyBindings]);
  const draftDrawing = { ...defaultDrawingPreferences, ...drawing, ...draft.drawingPreferences };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const conflicts = useMemo(() => shortcutConflicts(draftShortcuts), [draftShortcuts]);

  function editShortcut(action: ShortcutAction, binding: string) {
    onDraftChange({ ...draft, keyBindings: { ...draft.keyBindings, [action]: binding } });
  }
  function editDrawing(patch: Partial<DrawingPreferences>) {
    onDraftChange({ ...draft, drawingPreferences: { ...draft.drawingPreferences, ...patch } });
  }

  async function save() {
    if (busy || conflicts.length || !online) return;
    setBusy(true); setSaved(false); setError('');
    try {
      await onSave({ keyBindings: draftShortcuts, drawingPreferences: draftDrawing });
      if (mounted.current) { onDraftChange({}); setSaved(true); }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '保存失败，请恢复本地连接后重试。';
      if (mounted.current) setError(message);
      else onSaveError?.(message);
    } finally { if (mounted.current) setBusy(false); }
  }

  return <div className="settings-panel">
    <details className="menu-fold" inert={busy}><summary>快捷键</summary>
      <p className="settings-help">在下方输入快捷键组合，点「保存设置」生效。输入便签文字时会保留编辑器按键。Esc、Space、Ctrl+Enter、Backspace 和 Delete 为保留键。</p>
      {shortcutSections.map((section) => <fieldset key={section.title}>
        <legend>{section.title}</legend>
        {section.actions.map((action) => <label className="shortcut-row" key={action}>
          <span>{shortcutLabels[action]}</span>
          <input aria-label={`${shortcutLabels[action]}快捷键`} value={draftShortcuts[action]}
            onChange={(event) => editShortcut(action, event.target.value)} />
        </label>)}
      </fieldset>)}
      {conflicts.length > 0 && <div className="settings-error" role="alert">快捷键冲突：{conflicts.map((item) => item.binding || '空按键').join('、')}</div>}
    </details>

    <details className="menu-fold" inert={busy}><summary>画笔、橡皮擦与套索</summary>
      <div className="drawing-settings-grid">
        <div>画笔颜色<ColorPalette label="画笔颜色" placement="below" value={draftDrawing.penColor} onChange={(penColor) => editDrawing({ penColor })} /></div>
        <label>画笔粗细<input type="range" min="1" max="36" value={draftDrawing.penSize} onChange={(event) => editDrawing({ penSize: Number(event.target.value) })} /></label>
        <div>荧光笔颜色<ColorPalette label="荧光笔颜色" placement="below" value={draftDrawing.highlighterColor} opacity={highlighterOpacity}
          slots={draftDrawing.highlighterColorSlots || DEFAULT_COLOR_SLOTS}
          onSlotsChange={(highlighterColorSlots, highlighterColor) => editDrawing({ highlighterColorSlots, highlighterColor })}
          onChange={(highlighterColor) => editDrawing({ highlighterColor })} /></div>
        <label>荧光笔粗细<input type="range" min="1" max="72" value={draftDrawing.highlighterSize} onChange={(event) => editDrawing({ highlighterSize: Number(event.target.value) })} /></label>
        <label>默认图层<select value={draftDrawing.layer} onChange={(event) => editDrawing({ layer: event.target.value as DrawingPreferences['layer'] })}><option value="background">气泡下方</option><option value="foreground">气泡上方</option></select></label>
        <label>橡皮擦<select value={draftDrawing.eraserMode} onChange={(event) => editDrawing({ eraserMode: event.target.value as DrawingPreferences['eraserMode'] })}><option value="whole">整笔擦除</option><option value="precision">精细擦除</option></select></label>
        <label>套索范围<select value={draftDrawing.lassoMode} onChange={(event) => editDrawing({ lassoMode: event.target.value as DrawingPreferences['lassoMode'] })}><option value="ink">只选墨迹</option><option value="all">墨迹与气泡</option></select></label>
      </div>
    </details>
    {(draft.drawingPreferences || draft.keyBindings) && <button className="primary" disabled={!online || busy || conflicts.length > 0} onClick={() => void save()}>{busy ? '保存中…' : '保存设置'}</button>}
    {error && <p role="alert">{error}</p>}
    {saved && !draft.drawingPreferences && !draft.keyBindings && <p role="status">设置已保存。</p>}
  </div>;
}

export function DataSettings({ online, serviceHealth }: DataSettingsProps) {
  return <div className="settings-panel">
    <MediaUsage online={online} /><ImageExportSettings online={online} />
    <details className="menu-fold"><summary>版本与诊断</summary><VersionInfo online={online} serviceHealth={serviceHealth} /></details>
  </div>;
}

export function VersionInfo({ online, serviceHealth }: DataSettingsProps) {
  const version = serviceHealth?.appVersion;
  const mismatch = Boolean(version && version !== APP_VERSION);
  const runtime = serviceHealth?.runtime === 'desktop-sidecar' ? '桌面内置服务'
    : serviceHealth?.runtime === 'web-fallback' ? '网页本地服务' : serviceHealth?.runtime || '未知';
  return <section className="settings-version" aria-label="版本信息">
    <h3>关于与诊断</h3>
    <dl><dt>界面版本</dt><dd>{APP_VERSION}</dd>
      <dt>{online ? '本地服务版本' : '上次观测的服务版本'}</dt><dd>{version || '尚未核验'}</dd>
      <dt>运行方式</dt><dd>{runtime}</dd></dl>
    <TrialDiagnosticsStatus />
    {serviceHealth && <small>检查于 {new Date(serviceHealth.checkedAt).toLocaleString('zh-CN')}</small>}
    {mismatch ? <p role="alert">界面与服务版本不一致，写入已暂停。请从托盘真正退出旧版，打开配套的新程序，再刷新页面。</p>
      : !online && <p role="status">当前未连接，服务版本不代表实时状态。</p>}
  </section>;
}

function MediaUsage({ online }: { online: boolean }) {
  const [usage, setUsage] = useState<{ count: number; bytes: number } | null>(null);
  useEffect(() => { const controller = new AbortController(); if (online) void fetch('/api/media/usage', { signal: controller.signal }).then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(setUsage).catch(() => undefined); return () => controller.abort(); }, [online]);
  return <section className="settings-version"><h3>本地图片</h3><p>{usage ? `${usage.count} 张 · ${(usage.bytes / 1024 / 1024).toFixed(1)} MiB（原图与预览）` : '占用暂不可用'}</p><small>图片只保存在本机；暂不自动清理原图，以保留归档、撤销和恢复能力。</small></section>;
}

function ImageExportSettings({ online }: { online: boolean }) {
  const [settings, setSettings] = useState<ExportSettings | null>(null), [directory, setDirectory] = useState('');
  const [busy, setBusy] = useState(false), [status, setStatus] = useState('');
  useEffect(() => {
    let active = true;
    if (online) void api.exportSettings().then(value => { if (active) { setSettings(value); setDirectory(value.directory); } }).catch(() => { if (active) setStatus('暂时无法读取保存位置。'); });
    return () => { active = false; };
  }, [online]);
  async function save(reset = false) {
    if (busy || !online) return;
    setBusy(true); setStatus('');
    try { const value = await api.setExportDirectory(reset ? null : directory); setSettings(value); setDirectory(value.directory); setStatus('图片保存位置已更新。'); }
    catch (cause) { setStatus(cause instanceof Error ? cause.message : '保存位置未能更新。'); }
    finally { setBusy(false); }
  }
  return <section className="settings-version image-export-settings"><h3>图片保存位置</h3>
    <p className="settings-help">区域导出和便签图片都保存到这里，同时尝试复制到剪贴板。每次生成独立 PNG，不覆盖已有图片。</p>
    <label>本机文件夹<input aria-label="图片保存文件夹" value={directory} disabled={!online || !settings || busy} onChange={event => { setDirectory(event.target.value); setStatus(''); }} /></label>
    {settings && <small>默认：{settings.defaultDirectory}</small>}
    <div><button disabled={!online || !settings || busy || !directory} onClick={() => void save()}>保存路径</button><button disabled={!online || !settings || busy} onClick={() => void save(true)}>恢复默认</button></div>
    {status && <small role="status">{status}</small>}
  </section>;
}
