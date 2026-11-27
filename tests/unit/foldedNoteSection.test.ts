import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { FoldedNoteSection } from '../../src/web/FoldedNoteSection.js';
import type { CanvasNodeRecord } from '../../src/shared/schema.js';

it('shows the folded-note count and restore actions only in its detail section', () => {
  const note: CanvasNodeRecord = { id: 'note:test', kind: 'note', threadKey: null, title: '', body: '  已收纳\n', x: 10, y: 20, width: 200, height: 150, zIndex: 1, lastViewedAt: null, revision: 0, createdAt: '', updatedAt: '' };
  const html = renderToStaticMarkup(createElement(FoldedNoteSection, { notes: [note], online: false, onUnfold: () => {} }));
  expect(html).toContain('收纳便签 · 1'); expect(html).toContain('  已收纳\n'); expect(html).toContain('disabled');
  expect(renderToStaticMarkup(createElement(FoldedNoteSection, { notes: [], online: true, onUnfold: () => {} }))).toBe('');
});
