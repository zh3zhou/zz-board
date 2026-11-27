import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { NoteEditor } from '../../src/web/NoteEditor.js';

it('mounts the first offline editor without suspending for a network module', () => {
  const html = renderToStaticMarkup(createElement(NoteEditor, {
    body: '', online: false, onChange() {}, onComposition() {}, onFinish() {}
  }));
  expect(html).toContain('note-editor-host');
});
