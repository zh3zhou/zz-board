import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_SKINS, contrastRatio, getSkinComponent, skinVersionKey } from '../../src/shared/skin.js';
import { composedSkinStyle, controlVariables } from '../../src/web/skinRuntime.js';

describe('UI control readability across Skin combinations', () => {
  const manifests = BUILT_IN_SKINS.map(s => s.manifest);
  for (const background of manifests) for (const chrome of manifests.filter(m => m.schemaVersion >= 2)) {
    it(`${skinVersionKey(background)} + ${skinVersionKey(chrome)} chrome keeps paired colors`, () => {
      const style = composedSkinStyle(manifests, skinVersionKey(background), { chrome: `${skinVersionKey(chrome)}/chrome` });
      for (const name of ['--control-text', '--control-muted'] as const) expect(contrastRatio(String(style[name]), String(style['--control-bg']))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(String(style['--control-hover-text']), String(style['--control-hover']))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(String(style['--on-accent']), String(style['--control-accent']))).toBeGreaterThanOrEqual(4.5);
      for (const level of ['attention', 'high'] as const) expect(contrastRatio(String(style[`--on-priority-${level}`]), String(style[`--priority-${level}`]))).toBeGreaterThanOrEqual(4.5);
      for (const name of ['--control-border', '--control-focus'] as const) expect(contrastRatio(String(style[name]), String(style['--control-bg']))).toBeGreaterThanOrEqual(3);
    });
  }
  it('protects controls from a custom elevated surface not covered by legacy manifest checks', () => {
    const component = getSkinComponent(manifests.find(m=>m.schemaVersion === 2)!, 'chrome');
    if (!component || !('panelElevated' in component)) throw new Error('Missing chrome fixture');
    const style = controlVariables({...component, panelElevated:'#FFFFFF22', text:'#EEEEEE', muted:'#FFFFFF', accent:'#FFFFCC', accentSoft:'#FFFFFF'});
    expect(style['--control-bg']).toBe('#FFFFFF');
    expect(contrastRatio(String(style['--control-text']), '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(String(style['--on-accent']), '#FFFFCC')).toBeGreaterThanOrEqual(4.5);
  });
  it('new unclassed controls have an authored surface, readable disabled state and focus', () => {
    const css=fs.readFileSync('src/web/styles.css','utf8');
    expect(css).toMatch(/:where\(button, select\)\s*\{[^}]*background:\s*var\(--control-bg\)/);
    expect(css).toMatch(/button:disabled\s*\{[^}]*opacity:\s*1/);
    expect(css).toContain('color: var(--on-accent)');
    expect(css).toMatch(/\.modal\s*\{[^}]*color:\s*var\(--ink\)/);
    expect(css).toContain(':focus-visible { outline: 2px solid var(--control-focus)');
    expect(css).not.toMatch(/\.primary\s*\{[^}]*color:\s*white/);
  });
  it('UI styles never reintroduce fixed white-on-accent labels or opacity-only disabled controls', () => {
    for (const file of fs.readdirSync('src/web').filter(f=>f.endsWith('.css'))) {
      const css=fs.readFileSync(`src/web/${file}`,'utf8');
      const rules=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
      for(const [,selector,body] of rules) {
        if (/color:\s*(white|#fff(?:fff)?)\s*;/i.test(body!) && /background:\s*var\(--accent\)/.test(body!)) throw new Error(`${file}: unpaired accent text in ${selector}`);
        if (selector?.includes('button:disabled') && /opacity:\s*0?\.[0-5]\s*;/.test(body!)) throw new Error(`${file}: opacity-only disabled control in ${selector}`);
      }
    }
  });
  it('keeps the development preview away from locked/private desktop resources', () => {
    const config=fs.readFileSync('vite.config.ts','utf8');
    for(const field of ['watch:', 'fs:']) {
      const line=config.split('\n').find(line=>line.includes(field))!;
      expect(line).toContain('**/.local-data/**');
      expect(line).toContain('**/src-tauri/target/**');
    }
  });
});
