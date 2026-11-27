import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(new URL('../../src/web/styles.css', import.meta.url), 'utf8');

describe('visual CSS contracts', () => {
  it('keeps explicit priority labels screen-sized and readable for notes, images and bubbles', () => {
    expect(css).toMatch(/\.bubble-priority-badge\s*\{[^}]*background:\s*var\(--control-bg\)[^}]*scale\(var\(--priority-scale, 1\)\)/s);
    for (const [level, token] of [['p1', 'high'], ['p2', 'attention']]) {
      const rule = css.split('}').find(block => block.includes(`.bubble[data-priority='${level}'] .bubble-priority-badge`));
      expect(rule).toContain(`color: var(--on-priority-${token},`);
      expect(rule).toContain(`background: var(--priority-${token},`);
    }
  });
  it('keeps image cards opaque and unrotated even when note Skin rules load later', () => {
    const imageCss = fs.readFileSync(new URL('../../src/web/noteDocument.css', import.meta.url), 'utf8');
    expect(imageCss).toMatch(/\.bubble\.bubble-image \.bubble-surface\s*\{[^}]*border:\s*0;[^}]*opacity:\s*1;[^}]*transform:\s*none/s);
    expect(imageCss).toMatch(/\.bubble\.bubble-image:hover \.bubble-surface\s*\{[^}]*transform:\s*none/s);
  });
  it('uses the note Skin text through editing, caret, placeholder and selection states', () => {
    expect(css).toMatch(/\.inline-note-editor\s*\{[^}]*color:\s*var\(--note-skin-text\)/s);
    expect(css).toMatch(/\.inline-note-editor\s*\{[^}]*caret-color:\s*var\(--note-skin-accent\)/s);
    expect(css).toMatch(/\.inline-note-editor::placeholder\s*\{[^}]*var\(--note-skin-text\)/s);
    expect(css).toMatch(/\.inline-note-editor::selection\s*\{[^}]*color:\s*var\(--note-skin-text\)/s);
  });

  it('keeps operation notices below panel layers and close controls sticky', () => {
    expect(css).toMatch(/\.notice\s*\{[^}]*z-index:\s*24/s);
    expect(css).toMatch(/\.detail-panel\s*\{[^}]*z-index:\s*30/s);
    expect(css).toMatch(/\.panel-close\s*\{[^}]*position:\s*sticky/s);
  });
});
