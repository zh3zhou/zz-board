import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BoardState, CanvasNodeRecord } from '../shared/schema.js';
import { pageId, type CanvasPageRecord } from '../shared/pages.js';
import { contextForNode, projectSignals } from './projectCanvas.js';
import { filterDrawerProjects, type DrawerProjectSignal, type ProjectDrawerPriority, type ProjectDrawerStatus } from './projectDrawer.js';
import { manualPriorityLabel, portfolioActions } from './manualPriority.js';
import { awaitsResponse } from './projectActions.js';
import { pageSearch } from './pageCanvas.js';
import { PageSearchResult } from './PageSearchResult.js';
import { MenuHeader } from './MenuHeader.js';
import './boardMenu.css';

export const menuSections = { projects: '项目', pages: '页面', appearance: '外观', controls: '画布与工具', data: '数据与帮助' } as const;
export const menuDetails = { responses: '待我处理', updates: '项目更新', permissions: '来源授权', skins: '皮肤库',
  wallpaper: '背景图片', archive: '本页便签归档', guide: '使用指南', feedback: '反馈与帮助', snapshot: '导入快照', curator: '看板顾问' } as const;
export type MenuSection = keyof typeof menuSections;
export type MenuDetail = keyof typeof menuDetails;
export interface MenuLocation { section: MenuSection; path: MenuDetail[]; fromProject?: boolean }

type Props = {
  board: BoardState; pages: CanvasPageRecord[]; records: CanvasNodeRecord[]; currentPage: string;
  canWrite: boolean; menuKey: string; noteKey: string; location: MenuLocation;
  onClose(): void; onWrite(): void; onResponses(): void; onUpdates(): void; onLocate(record: CanvasNodeRecord): void;
  onFocusThread(threadKey: string): void;
  onSection(section: MenuSection): void; sectionContent: ReactNode; detailContent: ReactNode; status: ReactNode;
};

export function BoardMenu({ board, pages, records, currentPage, canWrite, menuKey, noteKey, onClose, onWrite, onResponses, onUpdates,
  onLocate, onFocusThread, location, onSection, sectionContent, detailContent, status }: Props) {
  const { section, path } = location;
  const [query, setQuery] = useState('');
  const [priority, setPriority] = useState<ProjectDrawerPriority>('all');
  const [stateFilter, setStateFilter] = useState<ProjectDrawerStatus>('all');
  const search = useRef<HTMLInputElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const positions = useRef(new Map<string, number>());
  const openers = useRef(new Map<string, HTMLElement>());
  const route = [section, ...path].join('/');
  const previous = useRef('');
  useLayoutEffect(() => {
    const pane = drawer.current?.querySelector<HTMLElement>('[data-menu-pane]');
    if (!pane) return;
    const returning = previous.current.startsWith(route + '/');
    const previousButton = returning && openers.current.get(route);
    let target: HTMLElement | undefined;
    if (previousButton) {
      target = pane.contains(previousButton) ? previousButton : [...pane.querySelectorAll<HTMLElement>('button, summary')].find(item =>
        item.textContent === previousButton.textContent && item.getAttribute('aria-label') === previousButton.getAttribute('aria-label'));
      for (let parent = target?.parentElement; parent && pane.contains(parent); parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
      }
    }
    const scroller = pane.querySelector<HTMLElement>('.panel-scroll, .board-menu-scroll');
    if (scroller) scroller.scrollTop = positions.current.get(route) ?? 0;
    (target ?? pane.querySelector<HTMLElement>('h2'))?.focus({ preventScroll: true });
    previous.current = route;
  }, [route]);

  const projects = useMemo(() => [...board.projects].sort((a,b) =>
    (a.sidebarIndex ?? Number.MAX_SAFE_INTEGER) - (b.sidebarIndex ?? Number.MAX_SAFE_INTEGER)), [board.projects]);
  const projectRecords = useMemo(() => new Map(records.filter(record => record.kind === 'task' && record.projectKey)
    .map(record => [record.projectKey!, record])), [records]);
  const pageById = useMemo(() => new Map(pages.map(page => [page.id, page])), [pages]);
  const responses = useMemo(() => portfolioActions(board, records).filter(({ action }) => awaitsResponse(action)), [board, records]);
  const signals = useMemo(() => {
    if (stateFilter === 'all') return new Map<string, DrawerProjectSignal>();
    const awaiting = new Set(responses.map(item => item.projectKey));
    return new Map(projects.map(project => {
      const record = projectRecords.get(project.projectKey);
      const context = stateFilter !== 'action' && record ? contextForNode(board, record) : undefined;
      const signal = context && projectSignals(context);
      return [project.projectKey, { actionRequired: awaiting.has(project.projectKey), uncertain: !signal || signal.confidence === 'low' || signal.workState === 'insufficient_evidence',
        closed: Boolean(signal && ['complete', 'intentionally_closed', 'stage_closed'].includes(signal.workState)) }] as const;
    }));
  }, [stateFilter, projects, projectRecords, board, responses]);
  const visibleProjects = filterDrawerProjects({ projects, records, signals, search: '', priority, status: stateFilter });
  const results = useMemo(() => pageSearch(board, query, records), [board, query, records]);
  const searching = Boolean(query.trim());
  const filterActive = priority !== 'all' || stateFilter !== 'all';
  const atRoot = path.length === 0;
  return <aside ref={drawer} id="board-menu" className="control-drawer board-menu" aria-label="看板菜单"
    onScrollCapture={event => {
      if (event.target instanceof HTMLElement && event.target.matches('.panel-scroll, .board-menu-scroll') && event.target.closest('[data-menu-pane]'))
        positions.current.set(route, event.target.scrollTop);
    }}
    onClickCapture={event => {
      const trigger = event.target instanceof Element && event.target.closest<HTMLElement>('button, summary');
      if (trigger) openers.current.set(route, trigger);
    }}>
    <div className="board-menu-index" data-menu-pane={atRoot ? '' : undefined} hidden={!atRoot} inert={!atRoot}>
    <MenuHeader title={menuSections[section]} onClose={onClose} closeHint={`收起（${menuKey}）`}>
      <nav className="board-menu-sections" aria-label="菜单分区">{(Object.entries(menuSections) as [MenuSection,string][]).map(([key,label]) =>
        <button key={key} type="button" aria-current={key === section ? 'page' : undefined} onClick={() => onSection(key)}>{label}</button>)}</nav>
    </MenuHeader>
    <div className="board-menu-scroll">
    {section === 'projects' ? <>
      <label className="board-menu-search"><span aria-hidden="true" /><input ref={search} value={query} type="text" aria-label="跨页查找" placeholder="查找项目、便签或对话" onChange={event => setQuery(event.target.value)} />
        {query && <button type="button" aria-label="清除搜索" onClick={() => { setQuery(''); search.current?.focus(); }}>×</button>}
      </label>
      <div className="board-menu-actions"><button type="button" className="board-menu-write" disabled={!canWrite} onClick={onWrite}>写便签 <kbd>{noteKey}</kbd></button>
        <button type="button" onClick={onResponses}>待我处理 <strong>{responses.length}</strong></button>
        <button type="button" onClick={onUpdates}>项目更新</button></div>
      {searching ? <section aria-label="查找结果"><h3>查找结果 <small>{results.length}</small></h3>
        <div className="page-search-results" aria-live="polite">{results.length ? results.map(hit =>
          <PageSearchResult key={hit.thread ? `thread:${hit.thread.threadKey}` : `node:${hit.record.id}`} {...hit} query={query}
            onLocate={() => hit.thread ? onFocusThread(hit.thread.threadKey) : onLocate(hit.record)} />) :
          <p role="status">没有找到匹配的项目、便签或对话。{board.nodes.some(node => node.kind === 'note' && node.archivedAt) && '要找已归档的便签，请到原页面打开「本页便签归档」。'}</p>}</div>
      </section> : <section aria-label="项目目录">
          <h3>{filterActive ? '已筛选项目' : '全部项目'} <small>{visibleProjects.length}</small></h3>
          <details className="board-menu-filters"><summary>筛选项目{filterActive && ' · 已启用'}</summary>
            <div><select aria-label="按手动优先级筛选项目" value={priority} onChange={event => setPriority(event.target.value as ProjectDrawerPriority)}>
              <option value="all">全部手动优先级</option><option value="p1">优先</option><option value="p2">关注</option><option value="unset">未设置</option></select>
              <select aria-label="按状态筛选项目" value={stateFilter} onChange={event => setStateFilter(event.target.value as ProjectDrawerStatus)}>
                <option value="all">全部状态</option><option value="action">待我处理</option><option value="uncertain">待厘清</option><option value="closed">已收口</option></select></div>
          </details>
          <nav className="board-menu-projects" aria-label="项目（保留 Codex 侧边栏顺序）">{visibleProjects.map(project => {
            const record = projectRecords.get(project.projectKey);
            const page = record && pageById.get(pageId(record));
            return <button type="button" key={project.projectKey} disabled={!record} onClick={() => record && onLocate(record)}>
              <span>{project.name}</span>{record?.manualPriority && <em>{manualPriorityLabel(record.manualPriority)}</em>}
              {page && <small>{page.name}{page.archivedAt && ' · 归档只读'}</small>}
            </button>;
          })}</nav>
          {!visibleProjects.length && <p role="status">{filterActive ? '没有符合筛选条件的项目。' : '还没有已保存的项目。'}</p>}
        </section>}
    </> : sectionContent}
    </div>
    <footer className="board-menu-foot"><span>当前页 · {currentPage}</span>{status}</footer>
    </div>
    {!atRoot && <div className="menu-detail" data-menu-pane="">{detailContent}</div>}
  </aside>;
}
