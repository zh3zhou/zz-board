import { describe, expect, it } from 'vitest';
import { defaultShortcuts, mergeShortcuts, normalizeShortcut, panelOwnsCanvasKeys, shortcutConflicts, shortcutMatches, startsCanvasPan } from '../../src/web/shortcuts.js';

describe('custom keyboard shortcuts', () => {
  it('reserves Space for the canvas and leaves native controls, panels and composition alone', () => {
    const key = { code: 'Space', defaultPrevented: false, isComposing: false, repeat: false, ctrlKey: false, altKey: false, metaKey: false };
    const ancestor = (selector: string) => ({ closest: (selectors: string) => selectors.split(', ').includes(selector) ? {} as Element : null }) as Pick<Element, 'closest'>;
    expect(startsCanvasPan(key, ancestor('.react-flow__pane'))).toBe(true);
    for (const selector of ['button', 'summary', 'input', '.panel-shell', '.modal-backdrop', '.control-drawer', '[role="tab"]']) {
      expect(startsCanvasPan(key, ancestor(selector)), selector).toBe(false);
    }
    expect(startsCanvasPan({ ...key, code: 'Enter' }, null)).toBe(false);
    expect(startsCanvasPan({ ...key, isComposing: true }, null)).toBe(false);
    expect(startsCanvasPan({ ...key, defaultPrevented: true }, null)).toBe(false);
    expect(startsCanvasPan({ ...key, ctrlKey: true }, null)).toBe(false);
  });
  it('keeps canvas delete and history shortcuts behind the same open-panel boundary', () => {
    const pane = { closest: () => null };
    const fromDetail = { closest: (selector: string) => selector.includes('.panel-shell') ? {} as Element : null } as Pick<Element, 'closest'>;
    expect(panelOwnsCanvasKeys(true, pane)).toBe(true);
    expect(panelOwnsCanvasKeys(true, null)).toBe(true);
    expect(panelOwnsCanvasKeys(false, fromDetail)).toBe(true);
    expect(panelOwnsCanvasKeys(false, pane)).toBe(false);
  });
  it('normalizes bindings and preserves defaults for unknown input', () => {
    expect(normalizeShortcut('shift + ctrl + z')).toBe('Ctrl+Shift+Z');
    expect(mergeShortcuts({ menu: 'q', undo: '' })).toMatchObject({ menu: 'Q', undo: defaultShortcuts.undo });
  });

  it('reports collisions and fixed safety/editing keys', () => {
    const map = { ...defaultShortcuts, menu: 'P', newNote: 'Escape' };
    expect(shortcutConflicts(map)).toEqual(expect.arrayContaining([
      { binding: 'P', actions: expect.arrayContaining(['menu', 'penTool']) },
      { binding: 'Escape', actions: ['newNote'] }
    ]));
  });

  it('matches modifier combinations without confusing plain keys', () => {
    const event = { key: 'z', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true };
    expect(shortcutMatches(event, 'Ctrl+Shift+Z')).toBe(true);
    expect(shortcutMatches(event, 'Z')).toBe(false);
  });
});
