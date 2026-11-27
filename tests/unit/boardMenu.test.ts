import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BoardDatabase } from '../../src/server/database.js';
import { createDemoSnapshot } from '../../src/shared/demo.js';
import type { BoardState, BoardThread, ThreadRecap } from '../../src/shared/schema.js';
import { BoardMenu, type MenuLocation } from '../../src/web/BoardMenu.js';
import { awaitsResponse, projectActions } from '../../src/web/projectActions.js';
import { visibleCanvasRecords } from '../../src/web/projectCanvas.js';
import { summary, time } from '../fixtures/summary.js';

const seed = createDemoSnapshot(8, new Date(time));
const source: BoardThread = { ...seed.threads[0]!, lastObservedAt: time, missingSince: null };
const recap: ThreadRecap = { sourceFingerprint: 'a'.repeat(64), sources: [], summary: { ...summary(), workState: 'waiting_for_user',
  nextStep: { kind: 'wait', strength: 'blocking', text: '等待外部', origin: 'explicit_handoff', sourceRefs: [] } },
  evidenceCheckedAt: time, summarizedAt: time, promptVersion: 'test', model: 'sample', effort: 'low' };

function renderMenu(board: BoardState, canWrite: boolean, location: MenuLocation = { section: 'projects', path: [] }) {
  const noop = () => {};
  return renderToStaticMarkup(createElement(BoardMenu, {
    board, records: visibleCanvasRecords(board), pages: board.pages || [], currentPage: '工作页', canWrite,
    menuKey: 'Q', noteKey: 'Z', onClose: noop, onWrite: noop, onResponses: noop, onLocate: noop, onFocusThread: noop,
    location, onSection: noop, onUpdates: noop, sectionContent: '栏目内容', detailContent: '子页内容', status: null
  }));
}

describe('response list and folded board menu', () => {
  it('requires an attributable blocking action waiting for the user', () => {
    const needsResponse = (patch: Partial<BoardThread>) => projectActions({ threads: [{ ...source, ...patch }], todos: [] }).some(awaitsResponse);
    expect(needsResponse({})).toBe(true);
    expect(awaitsResponse({ kind: 'decide', strength: 'blocking', text: '选择版本', sources: [] })).toBe(false);
    expect(needsResponse({ actionStrength: 'recommended' })).toBe(false);
    expect(needsResponse({ missingSince: time })).toBe(false);
    expect(needsResponse({ runtimeState: 'running' })).toBe(true);
    expect(needsResponse({ workState: 'needs_validation', humanAction: 'test' })).toBe(true);
    expect(needsResponse({ workState: 'waiting_external', humanAction: 'wait' })).toBe(false);
    expect(needsResponse({ recap })).toBe(false);
    expect(needsResponse({ recap: { ...recap, summary: { ...recap.summary, nextStep: {
      kind: 'decide', strength: 'blocking', text: '选择封面', origin: 'explicit_handoff', sourceRefs: []
    } } }, recapOutdated: true })).toBe(false);
  });

  it('keeps write, search and the zero-count response entry on the first menu screen', () => {
    const db = new BoardDatabase(':memory:');
    try {
      const html = renderMenu(db.getBoard(), false);
      expect(html).toContain('aria-label="跨页查找"');
      expect(html).toContain('待我处理 <strong>0</strong>');
      expect(html).not.toContain('运行中');
      expect(html).toContain('收起（Q）');
      expect(html).toMatch(/<button[^>]+disabled=""[^>]*>写便签 <kbd>Z/);
      expect(html).toContain('还没有已保存的项目。');
      for (const label of ['页面', '外观', '画布与工具', '数据与帮助', '项目更新']) expect(html).toContain(label);
      expect(html).not.toMatch(/上次设置|工具与设置|看板设置/);
    } finally { db.close(); }
  });

  it('keeps the search on Projects and mounts only the active detail inside the left menu', () => {
    const db = new BoardDatabase(':memory:');
    try {
      const pages = renderMenu(db.getBoard(), true, { section: 'pages', path: [] });
      expect(pages).toContain('aria-current="page">页面');
      expect(pages).toContain('栏目内容');
      expect(pages).not.toContain('aria-label="跨页查找"');
      expect(pages).not.toContain('子页内容');
      const nested = renderMenu(db.getBoard(), true, { section: 'pages', path: ['wallpaper'] });
      expect(nested).toContain('class="board-menu-index" hidden="" inert=""');
      expect(nested).toMatch(/class="menu-detail"[^>]*>子页内容<\/div><\/aside>/);
    } finally { db.close(); }
  });

  it('lists projects in their saved Codex order, including the page name', () => {
    const db = new BoardDatabase(':memory:');
    try {
      db.importSnapshot(seed);
      const board = db.getBoard();
      const html = renderMenu({ ...board, projects: [...board.projects].reverse() }, true);
      const first = html.indexOf(seed.projects[0]!.name);
      const second = html.indexOf(seed.projects[1]!.name);
      expect(first).toBeGreaterThan(0);
      expect(second).toBeGreaterThan(first);
      expect(html).toContain(board.pages![0]!.name);
    } finally { db.close(); }
  });
});
