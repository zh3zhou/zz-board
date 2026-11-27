import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolPalette, type ToolPaletteProps } from '../../src/web/ToolPalette.js';

function props(patch: Partial<ToolPaletteProps> = {}): ToolPaletteProps {
  return {
    tool: 'select',
    preset: { color: '#23201d', size: 6, opacity: 1, layer: 'background' },
    eraserMode: 'whole',
    lassoMode: 'inkOnly',
    onToolChange() {},
    onPresetChange() {},
    onEraserModeChange() {},
    onLassoModeChange() {},
    ...patch
  };
}

describe('ToolPalette', () => {
  it('exposes every primary tool directly when the canvas opens', () => {
    const html = renderToStaticMarkup(createElement(ToolPalette, props({ onExport() {} })));
    for (const label of ['选择', '画笔', '荧光笔', '橡皮擦', '套索', '导出区域 PNG']) expect(html).toContain(`aria-label="${label}"`);
    expect(html).not.toContain('展开绘制工具');
    expect(html).not.toContain('选项"');
  });
  it('retains a direct exit while selecting an export region', () => {
    const html = renderToStaticMarkup(createElement(ToolPalette, props({ exportActive: true, onExport() {} })));
    expect(html).toContain('aria-label="结束区域导出"');
    expect(html).not.toContain('aria-label="画笔"');
  });

  it('offers colour and size next to an active brush even when selected by shortcut', () => {
    const html = renderToStaticMarkup(createElement(ToolPalette, props({ tool: 'pen' })));
    expect(html).toContain('画笔颜色'); expect(html).toContain('画笔粗细');
    expect(html).not.toContain('荧光笔颜色');
  });

  it('exposes Chinese accessible names and custom shortcut tooltips', () => {
    const html = renderToStaticMarkup(createElement(ToolPalette, props({ shortcuts: { pen: 'B' } })));
    expect(html).toContain('aria-label="绘制工具"');
    expect(html).toContain('aria-label="画笔"');
    expect(html).toContain('title="画笔 (B)"');
    expect(html).toContain('aria-pressed="true"');
  });

  it('shows only the relevant secondary mode control', () => {
    const eraser = renderToStaticMarkup(createElement(ToolPalette, props({ tool: 'eraser', eraserMode: 'precision' })));
    expect(eraser).toContain('aria-label="精细擦除"');
    expect(eraser).not.toContain('aria-label="颜色"');
    const lasso = renderToStaticMarkup(createElement(ToolPalette, props({ tool: 'lasso', lassoMode: 'includeObjects' })));
    expect(lasso).toContain('aria-label="选择墨迹与气泡便签"');
  });
});
