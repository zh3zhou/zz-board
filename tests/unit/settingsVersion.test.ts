import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../../src/shared/version.js';
import { ControlSettings, DataSettings, VersionInfo, defaultDrawingPreferences } from '../../src/web/SettingsPanel.js';
import { defaultShortcuts } from '../../src/web/shortcuts.js';
const health = { ok: true as const, appVersion: APP_VERSION, snapshotSchemaVersions: [1, 2, 3, 4], mode: 'formal', uptimeSeconds: 5, runtime: 'desktop-sidecar', checkedAt: '2026-09-21T08:00:00Z' };
const props = { shortcuts: defaultShortcuts, drawing: defaultDrawingPreferences, online: true, serviceHealth: health,
  onDraftChange() {}, onSave: async () => {} };

describe('canvas control preferences', () => {
  it('restores the edited fields over the latest saved preferences on returning to the controls section', () => {
    const html = renderToStaticMarkup(createElement(ControlSettings, { ...props,
      shortcuts: { ...defaultShortcuts, newNote: 'Q' }, drawing: { ...defaultDrawingPreferences, highlighterSize: 33 },
      draft: { keyBindings: { menu: 'T' }, drawingPreferences: { penSize: 7 } } }));
    expect(html).toContain('aria-label="菜单快捷键" value="T"');
    expect(html).toContain('aria-label="新建便签快捷键" value="Q"');
    expect(html).toMatch(/画笔粗细<input[^>]*value="7"/);
    expect(html).toMatch(/荧光笔粗细<input[^>]*value="33"/);
    expect(html).not.toContain('总结模型');
  });
});

describe('settings version information', () => {
  it('keeps version diagnostics in the data and help section', () => {
    const controls = renderToStaticMarkup(createElement(ControlSettings, { ...props, draft: {} }));
    expect(controls).not.toContain('界面版本');
    const html = renderToStaticMarkup(createElement(DataSettings, { online:true, serviceHealth:health }));
    expect(html).toContain('关于与诊断'); expect(html).toContain(APP_VERSION); expect(html).toContain('界面版本');
    expect(html).toContain('本地服务版本'); expect(html).toContain('桌面内置服务');
  });
  it('does not infer the service version from frontend or stale offline information', () => {
    const absent = renderToStaticMarkup(createElement(VersionInfo, { online: false }));
    expect(absent).toContain('尚未核验');
    const stale = renderToStaticMarkup(createElement(VersionInfo, { online: false, serviceHealth: health }));
    expect(stale).toContain('上次观测'); expect(stale).toContain('不代表实时状态');
  });
  it('explicitly reports a mismatched old service without hiding its actual version', () => {
    const html = renderToStaticMarkup(createElement(VersionInfo, { online: false, serviceHealth: { ...health, appVersion: '0.6.1' } }));
    expect(html).toContain('0.6.1'); expect(html).toContain('版本不一致'); expect(html).toContain('真正退出');
  });
});
