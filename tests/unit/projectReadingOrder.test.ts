import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { createDemoSnapshot } from '../../src/shared/demo.js';
import { ProjectDetail } from '../../src/web/ProjectDetail.js';
import type { ProjectBubbleContext } from '../../src/web/projectCanvas.js';
import { readingDate, shortRecordDate } from '../../src/web/projectContextReading.js';

it('leads with each fact, links its own source and leaves the conversation list to the main navigation', () => {
  const snapshot = createDemoSnapshot(16, new Date('2026-01-08T00:00:00Z'));
  const project = snapshot.projects[0]!;
  const observed = snapshot.generatedAt;
  const context: ProjectBubbleContext = {
    project, memberNodeIds: [], todos: [],
    brief: { ...snapshot.projectBriefs[0]!, stopPoint: '样稿校对完成', lastObservedAt: observed, missingSince: null },
    threads: snapshot.threads.filter(thread => thread.projectKey === project.projectKey).map((thread, i) => ({
      ...thread, title: `打样记录 ${i}`, workState: 'waiting_for_user', humanAction: 'decide',
      actionStrength: 'blocking', stopPoint: `已核对样纸 ${i}`, evidence: '保留旧快照依据', sourceUpdatedAt: observed,
      lastObservedAt: observed, missingSince: null
    }))
  };
  const html = renderToStaticMarkup(createElement(ProjectDetail, {context, focusedThreadKey: null, view: 'overview', onFocusThread() {}}));
  const stop = html.indexOf('最近进展');
  const actions = html.indexOf('<h3>明确待办</h3>');
  expect(stop).toBeGreaterThan(-1);
  expect(actions).toBeGreaterThan(stop);
  expect(html.indexOf('已核对样纸 0')).toBeGreaterThan(stop);
  expect(html.indexOf('对话更新于')).toBeGreaterThan(html.indexOf('已核对样纸 0'));
  expect(html.indexOf('打样记录 0</button>')).toBeGreaterThan(html.indexOf('对话更新于'));
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toMatch(/样稿校对完成|查看全部|查看依据|保留旧快照依据|codex:\/\//);
  expect(html.slice(actions)).toContain('打样记录 0</button>');
  expect(html.slice(actions)).toContain('其余 1 项明确待办');
  expect(html.slice(actions)).toContain('打样记录 1</button>');
  const old = renderToStaticMarkup(createElement(ProjectDetail, {context: {...context, threads: []}, focusedThreadKey: null, view: 'overview'}));
  expect(old).toContain('旧项目简报'); expect(old).toContain('样稿校对完成');
});

it('uses a short calendar date without inventing a timestamp for an event', () => {
  const today = new Date(2026, 0, 1);
  expect(shortRecordDate('2025-12-31', today)).toBe('2025 年 12 月 31 日');
  expect(shortRecordDate('2026-01-01', today)).toBe('1 月 1 日');
  expect(shortRecordDate('invalid', today)).toBe('');
  const line = {text:'保存了双页打印设置',label:'成果',sourceRefs:[],historical:false,occurredAt:'2026-11-23'};
  expect(readingDate({...line,timeKind:'event'})).not.toMatch(/于|:/);
  expect(readingDate({...line,timeKind:'source'})).toMatch(/^记录于 /);
  expect(readingDate({...line,occurredAt:undefined})).toBe('');
});
