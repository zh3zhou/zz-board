import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { AppErrorBoundary } from '../../src/web/AppErrorBoundary.js';
import { SkinPanel } from '../../src/web/SkinPanel.js';
import { SKIN_PACKAGE_SCHEMA_VERSION } from '../../src/shared/skin.js';

it('keeps the available recovery action visible and places technical errors in closed details', () => {
  const boundary = new AppErrorBoundary({ children: null });
  boundary.state = AppErrorBoundary.getDerivedStateFromError(new Error('Synthetic <failure>'));
  const html = renderToStaticMarkup(boundary.render());
  expect(html).toMatch(/<details><summary>错误详情<\/summary><pre>Synthetic &lt;failure&gt;<\/pre><\/details>/);
  expect(html).toContain('重新加载</button>');
  expect(html).toContain('系统托盘');
});

it('separates whole-board and selected-note skin operations and names the import destination', () => {
  const html = renderToStaticMarkup(createElement(SkinPanel, {
    items: [{ key: 'sample@1.1.0', skinId: 'sample', displayName: '合成样式', description: '', version: '1.1.0', builtIn: true, schemaVersion: SKIN_PACKAGE_SCHEMA_VERSION, components: ['note'] }],
    activeComponents: {}, manifests: [], activeKey: null, online: true, selectedNodeKind: 'note', onClose() {}, async onApplySkin() {}, async onApplyComponent() {}, async onApplyToSelected() {}, async onClearSelected() {}, async onImport() {}
  }));
  expect(html).toMatch(/<h2\b[^>]*>皮肤库<\/h2>/);
  expect(html).toContain('已导入</button>');
  expect(html).toContain('整套应用</button>');
  expect(html).toContain('仅用于这张便签</button>');
  expect(html).toContain('内置 · 1.1.0');
});
