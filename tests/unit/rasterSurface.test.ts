import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountRasterSurface } from '../../src/web/rasterExport.js';
import { SceneTile } from '../../src/web/exportScene.js';
import type { ExportScene } from '../../src/web/exportScene.js';
import { BUILT_IN_SKINS } from '../../src/shared/skin.js';
import { composedSkinStyle } from '../../src/web/skinRuntime.js';

afterEach(() => vi.unstubAllGlobals());
const css = { '--skin-background': '#171717', '--edge': '#ab7956', '--skin-link-width': '3px', '--skin-link-opacity': '.63', '--skin-link-dash': '4 5' };
function fakeStyles() { vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (key: keyof typeof css) => css[key] || '' })); }

describe('self-contained raster surface', () => {
  it('keeps the offscreen carrier outside the serialized scene and removes both', () => {
    const body = { append: vi.fn() };
    const created: { style: Record<string, string>; append: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; setAttribute: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal('document', { body, documentElement: {}, createElement: (tag: string) => {
      if (tag === 'canvas') return { getContext: () => ({ fillRect() {}, getImageData: () => ({ data: [23, 23, 23, 255] }) }) };
      const element = { style: {}, append: vi.fn(), remove: vi.fn(), setAttribute: vi.fn() }; created.push(element); return element;
    } });
    fakeStyles();
    const { surface, remove } = mountRasterSurface(449, 237);
    expect(created[0].style).toMatchObject({ position: 'fixed', left: '-20000px' });
    expect(surface.style).toMatchObject({ position: 'relative', left: '0', top: '0', width: '449px', height: '237px' });
    expect(created[0].append).toHaveBeenCalledWith(surface);
    expect(body.append).toHaveBeenCalledWith(created[0]);
    remove(); expect(created[0].remove).toHaveBeenCalledOnce();
  });

  it('serializes concrete link appearance, including Skin dash and scaled width', () => {
    vi.stubGlobal('document', { documentElement: {} }); fakeStyles();
    const nodes: ExportScene['nodes'] = [0, 1].map(i => ({ id: `${i}`, position: { x: 5000 + i * 200, y: 0 }, data: { record: { id: `${i}`, threadKey: null, x: 5000 + i * 200, y: 0, width: 100, height: 100, zIndex: 1, kind: 'note', contentScale: 2, body: '', title: '', revision: 0, lastViewedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }, annotationCount: 0, selected: false, canResize: false, onResizeEnd() {} } }));
    // Nodes stay outside this tile; the crossing SVG path still retains its endpoints.
    const region = { x: 0, y: 0, width: 400, height: 300 };
    const html = renderToStaticMarkup(createElement(SceneTile, { nodes, edges: [{ id: 'link', source: '0', target: '1' }], strokes: [], region, wholeRegion: region, scale: 2 }));
    expect(html).toContain('stroke="#ab7956"'); expect(html).toContain('stroke-width="6"');
    expect(html).toContain('stroke-dasharray="4 5"'); expect(html).toContain('opacity="0.63"');
    expect(html).not.toContain('var(--edge)'); expect(html).not.toContain('var(--skin-link-width');
  });

  it.each([
    ['glass-drift@3.0.0', '26px 26px, 26px 26px', '17px -41px, 17px -41px, center, center'],
    ['ink-constellation@3.0.0', '24px 24px', '17px -41px, center, center'],
    ['sketch-collage@3.0.0', 'auto, auto', 'center, center, center, center'],
    ['glass-drift@2.0.0', '34px 34px', '17px -41px, center, center']
  ])('%s uses the canvas pattern size and preserves each layer origin across output tiles', (key, size, positions) => {
    const style = composedSkinStyle(BUILT_IN_SKINS.map(skin => skin.manifest), key);
    expect(style['--skin-pattern-size']).toBe(size);
    const sharedCss = readFileSync(new URL('../../src/web/styles.css', import.meta.url), 'utf8');
    expect(sharedCss).toMatch(/\.board-stage, \.skin-sample-canvas, \.export-background\s*\{[^}]*background-size:\s*var\(--skin-pattern-size/);
    vi.stubGlobal('document', { documentElement: {} });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (name: keyof typeof style) => String(style[name] ?? '') }));
    const whole = { x: -17, y: 41, width: 1200, height: 80 };
    for (const offset of [0, 1024]) {
      const region = { ...whole, x: whole.x + offset, width: Math.min(1024, whole.width - offset) };
      const html = renderToStaticMarkup(createElement(SceneTile, { nodes: [], edges: [], strokes: [], region, wholeRegion: whole, scale: 2 }));
      expect(html).toContain(`background-position:${positions}`);
      expect(html).toContain(`left:${offset ? '-1024px' : '0'};top:0;width:1200px`);
    }
  });
});
