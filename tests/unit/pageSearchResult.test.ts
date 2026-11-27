import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { BoardThread, CanvasNodeRecord } from '../../src/shared/schema.js';
import type { CanvasPageRecord } from '../../src/shared/pages.js';
import { PageSearchResult } from '../../src/web/PageSearchResult.js';

const page = { name: '校样工作桌', archivedAt: '2000-01-01' } as CanvasPageRecord;
const prefix = '铅字样张与纸墨效果的长篇中文编辑制作校样和跨部门联审工作记录'.repeat(2);
const title = prefix + ' · 第17册';
const content = (title: string, body: string, query: string) => {
  const record = { id: 'synthetic-note', kind: 'note', title, body } as CanvasNodeRecord;
  return renderToStaticMarkup(createElement(PageSearchResult, { record, page, query, onLocate() {} }));
};

it('keeps the full accessible name and shows the distinct suffix for a shared long prefix', () => {
  const html = content(title, '', '铅字样张');
  expect(html).toContain('aria-label="' + title + '，便签 · 校样工作桌 · 归档只读"');
  expect(html).toMatch(/<span>[^<]+…[^<]*第17册<\/span>/u);
  expect(content(prefix + ' · 第18册', '', '铅字样张')).toContain('第18册</span>');
  expect(html).toContain('<button type="button"');
});

it('shows a match that only occurs in the middle of a long title', () => {
  const html = content('前'.repeat(70) + '待选方案Ａ' + '后'.repeat(60), '', '待选方案');
  expect(html).toMatch(/<small>…前+待选方案Ａ后+…<\/small>/u);
});

it('shows the matched body context under its title and escapes note text', () => {
  const html = content('第17册', '甲'.repeat(100) + 'Shell <B>.* 小样' + '乙'.repeat(100), 'shell <b>.*');
  expect(html).toMatch(/<span>第17册<\/span><small>…甲+Shell &lt;B&gt;\.\* 小样乙+…<\/small>/u);
  expect(html).not.toContain('<B>');
});

it('names the original conversation, project, page and source for archived or missing records', () => {
  const record = { kind: 'task', projectKey: 'studio', title: '排版项目', body: '项目正文不应出现在对话结果中' } as CanvasNodeRecord;
  const thread = { title: '校验印刷稿', displayTitle: '自动摘要名', sourceUpdatedAt: '2026-11-10T12:00:00Z', missingSince: '2026-11-12T12:00:00Z' } as BoardThread;
  const html = renderToStaticMarkup(createElement(PageSearchResult, { record, thread, page, identity: 'studio · 00000042', query: '印刷', onLocate() {} }));
  expect(html).toContain('<span>校验印刷稿</span>');
  expect(html).toMatch(/对话 · 排版项目 · 校样工作桌 · studio · 00000042 · 2026\/11\/10 · 上次记录 · 归档只读/u);
  expect(html).not.toMatch(/自动摘要名|项目正文/u);
});

it('shows a snippet once for an untitled note and handles expanded Unicode case folds', () => {
  const html = content('', 'İ'.repeat(100) + '套色🟣原样' + '末'.repeat(100), '套色🟣');
  expect(html).toMatch(/<span>…İ+套色🟣原样末+…<\/span><small>便签 · 校样工作桌/u);
  expect(html).not.toContain('�');
});
