import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BUILT_IN_SKINS, builtInSkin, createSkinReference, parseSkinManifest, skinVersionKey } from '../../src/shared/skin.js';
import { SkinSample } from '../../src/web/SkinPanel.js';
import { applySkinVariables, composedSkinStyle, globalSkinStyle, nodeManifestSkinStyle, nodeSkinStyle, packageForReference, skinAspectLockedDefault, skinCornerRadii, skinShape } from '../../src/web/skinRuntime.js';

describe('declarative Skin runtime', () => {
  it('applies CSS custom properties through setProperty', () => {
    const values = new Map<string, string>();
    const removed: string[] = [];
    applySkinVariables({ setProperty: (name, value) => values.set(name, value || ''), removeProperty: (name) => { removed.push(name); return ''; } }, {
      '--paper': '#f6f0df',
      '--skin-link-width': 2
    });
    expect(values.get('--paper')).toBe('#f6f0df');
    expect(values.get('--skin-link-width')).toBe('2');
    expect(removed).toContain('--task-fill');
  });

  it('maps a V2 manifest to coordinated chrome, shape, material and Skin-driven motion', () => {
    const night = BUILT_IN_SKINS.find((skin) => skin.manifest.displayName === '夜墨 2.0')!;
    const style = globalSkinStyle(night);
    expect(style).toMatchObject({ '--paper': '#151514', '--panel': '#1D1D1B', '--task-radius': '50%', '--task-shape-kind': 'circle', '--task-aspect-default': '1', '--skin-motion-duration': '17000ms', '--skin-motion-amplitude': '6px' });
    expect(skinShape(night.manifest, 'taskBubble')).toBe('circle');
    expect(skinCornerRadii(night.manifest, 'taskBubble')).toBeUndefined();
    expect(skinAspectLockedDefault(night.manifest, 'taskBubble')).toBe(true);
    const mixed = composedSkinStyle(BUILT_IN_SKINS.map((skin) => skin.manifest), 'archive-paper@1.0.0', {});
    expect(mixed['--panel']).toBeTruthy();
  });

  it('keeps a light note component readable inside dark chrome without borrowing chrome text', () => {
    const manifests = BUILT_IN_SKINS.map((skin) => skin.manifest);
    const mixed = composedSkinStyle(manifests, 'ink-constellation@2.0.0', {
      chrome: 'ink-constellation@2.0.0/chrome',
      note: 'archive-paper@2.0.0/note'
    });
    expect(mixed['--ink']).toBe('#E9E4DA');
    expect(mixed['--note-skin-fill']).toBe('#E7D8BDF5');
    expect(mixed['--note-skin-text']).toBe('#2D2922');
    expect(mixed['--note-skin-text']).not.toBe(mixed['--ink']);
  });

  it('turns safe tokens into CSS variables without executable content', () => {
    const skin = BUILT_IN_SKINS[2]!;
    const style = globalSkinStyle(skin);
    expect(style['--paper']).toBe('#DDECF2');
    expect(style['--skin-background-image']).toContain('linear-gradient');
    expect(JSON.stringify(style)).not.toMatch(/url\(|<script|javascript:/i);
  });

  it('resolves pinned package references and falls back cleanly when missing', () => {
    const skin = BUILT_IN_SKINS[3]!;
    expect(packageForReference(BUILT_IN_SKINS, createSkinReference(skin.manifest, 'note'))).toBe(skin);
    expect(packageForReference(BUILT_IN_SKINS, 'missing@1.0.0/note')).toBeUndefined();
    expect(nodeSkinStyle(undefined, 'note')).toEqual({});
  });

  it('resolves paper, glass, matte and flat surfaces for both the canvas and the reader', () => {
    const paper = builtInSkin('archive-paper@3.0.0')!.manifest;
    if (paper.schemaVersion !== 3) throw new Error('Expected a V3 Skin');
    for (const [material, image, backdrop] of [
      ['flat', 'none', 'none'], ['matte', 'linear-gradient(138deg', 'none'],
      ['paper', 'repeating-linear-gradient', 'none'], ['glass', 'linear-gradient(135deg', 'blur(8px)']
    ]) {
      const manifest = parseSkinManifest({ ...paper, components: { note: { material, textureAssetId: 'test-paper' } }, assets: [{ id: 'test-paper', file: 'assets/test-paper.png', mediaType: 'image/png' }] });
      const node = nodeManifestSkinStyle(manifest, 'note');
      expect(node['--note-skin-material-image']).toContain(image);
      expect(node['--note-skin-backdrop']).toBe(backdrop);
      expect(node['--note-reading-texture']).toBe(node['--note-skin-texture-image']);
      expect(node['--note-reading-texture']).toContain('/api/skins/archive-paper%403.0.0/assets/test-paper');
    }
    const legacy = nodeSkinStyle(builtInSkin('archive-paper@2.0.0'), 'note');
    expect(legacy).toMatchObject({ '--note-skin-material-image': 'none', '--note-skin-texture-image': 'none', '--note-skin-backdrop': 'none', '--note-reading-texture': 'none' });
  });

  it('uses the resolved chrome priority pair independently from node and background overrides', () => {
    const manifests = BUILT_IN_SKINS.map(skin => skin.manifest);
    const style = composedSkinStyle(manifests, 'archive-paper@2.0.0', {
      background: 'glass-drift@3.0.0/background', chrome: 'ink-constellation@3.0.0/chrome', note: 'sketch-collage@3.0.0/note'
    });
    expect(style).toMatchObject({ '--priority-attention': '#E5C9A0', '--priority-high': '#A25034', '--note-skin-fill': '#F2DA98', '--skin-background': '#CFDFE0', '--skin-pattern-size': '26px 26px, 26px 26px' });
    expect(composedSkinStyle(manifests, 'archive-paper@1.0.0')['--panel']).toBe(globalSkinStyle(builtInSkin('ink-constellation@2.0.0'))['--panel']);
  });

  it('renders one Chinese sample using the same resolved surfaces, real note renderer and stroke geometry', () => {
    const manifests = BUILT_IN_SKINS.map(skin => skin.manifest);
    const sample = renderToStaticMarkup(createElement(SkinSample, { manifests, skinKey: 'glass-drift@3.0.0' }));
    expect(sample).toContain('街区导览');
    expect(sample).toContain('放大试读');
    expect(sample).toContain('focused-note-paper');
    expect(sample).toContain('bubble-note is-selected');
    expect(sample.match(/雨天走访时/g)).toHaveLength(2);
    expect(sample).toContain('canvas-link react-flow__edge-path');
    expect(sample).toContain('style="stroke:var(--edge);stroke-width:var(--skin-link-width)"');
    expect(sample).toContain('fill="var(--skin-ink-primary)"');
    expect(sample).toContain('--note-skin-backdrop:blur(8px)');
    expect(sample).not.toContain('wallpaper');
  });

  it.each(BUILT_IN_SKINS.filter(skin => skin.schemaVersion < 3).map(skin => skinVersionKey(skin.manifest)))(
    '%s samples resolve their own note, reading, and priority colors under a V3 board', (skinKey) => {
      const manifests = BUILT_IN_SKINS.map(skin => skin.manifest);
      const style = composedSkinStyle(manifests, skinKey);
      const pinned = nodeSkinStyle(builtInSkin(skinKey), 'note');
      expect(style['--note-skin-text']).toBe(pinned['--note-skin-text']);
      expect(style['--note-skin-fill']).toBe(pinned['--note-skin-fill']);
      expect(style).toMatchObject({ '--note-reading-radius': '14px', '--note-reading-texture': 'none', '--note-skin-material-image': 'none', '--chrome-material-image': 'none' });
      for (const name of ['--paper', '--panel', '--ink', '--control-text', '--note-skin-border', '--priority-attention', '--on-priority-attention', '--priority-high', '--on-priority-high'] as const) {
        expect(style[name]).toBeTruthy();
      }
      const sample = renderToStaticMarkup(createElement(SkinSample, { manifests, skinKey }));
      expect(sample).toContain(`--note-skin-text:${pinned['--note-skin-text']}`);
      expect(sample).toContain('>关注</span>');
      expect(sample).toContain('>优先</span>');
      expect(sample).toContain('走访笔记');
    }
  );
});
