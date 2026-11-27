import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { hoverSavedTime, NoteMetadata } from '../../src/web/NoteMetadata.js';

describe('saved note times', () => {
  it('displays both persisted timestamps and does not invent a text-only edit time', () => {
    const note = { createdAt: '2026-10-01T01:02:03.000Z', updatedAt: '2026-10-04T04:05:06.000Z' };
    const html = renderToStaticMarkup(createElement(NoteMetadata, { note }));
    expect(html).toContain('创建时间'); expect(html).toContain('最近节点变动');
    expect(html).toContain(`dateTime="${note.createdAt}"`); expect(html).toContain(`dateTime="${note.updatedAt}"`);
    expect(html).not.toContain('最近内容修改');
    const edit = { ...note, contentEditedAt: '2026-10-03T00:00:00.000Z' };
    expect(renderToStaticMarkup(createElement(NoteMetadata, { note: edit }))).toContain(`最近内容修改</dt><dd><time dateTime="${edit.contentEditedAt}"`);
  });
  it('formats today, yesterday and older dates against the local calendar', () => {
    const now = new Date(2026, 7, 1, 0, 3);
    expect(hoverSavedTime(now.toISOString(), now)).toBe('今天 00:03');
    expect(hoverSavedTime(new Date(2026, 6, 31, 19, 27).toISOString(), now)).toBe('昨天 19:27');
    expect(hoverSavedTime(new Date(2026, 6, 30, 2, 5).toISOString(), now)).toBe('2026-07-30 02:05');
    expect(hoverSavedTime('unknown', now)).toBe('时间未知');
  });

  it('marks unknown dates and unsaved changes honestly', () => {
    const html = renderToStaticMarkup(createElement(NoteMetadata, { note: { createdAt: '', updatedAt: 'invalid' }, pending: true }));
    expect(html.match(/时间未知/g)).toHaveLength(2); expect(html).toContain('本机内容待保存');
    expect(html).not.toContain('Invalid Date'); expect(html).not.toContain('<time');
  });
});
