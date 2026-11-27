import type { BoardState, CanvasNodeRecord, ManualPriority } from '../shared/schema.js';
import { localCalendarDate, manualLevel, priorityOnDate } from '../shared/notePriority.js';
import { projectActions, type ProjectAction } from './projectActions.js';

export const manualPriorityOrder: Record<ManualPriority, number> = { p1: 0, p2: 1, p3: 1 };

export function manualPriorityLabel(priority: ManualPriority | null | undefined): string {
  return priority === 'p1' ? '优先' : priority ? '关注' : '';
}

export function displayedPriority(record: Pick<CanvasNodeRecord, 'manualPriority' | 'effectivePriority' | 'noteSchedule'>, date?: string) {
  return record.effectivePriority === undefined ? priorityOnDate(record, date ?? localCalendarDate()).effectivePriority : record.effectivePriority;
}

type PriorityKey = Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'repeat' | 'isComposing' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

/** Returns undefined when the canvas must not own this key; null means explicitly clear priority. */
export function priorityFromShortcut(event: PriorityKey, editing: boolean, overlayOpen: boolean, hasSelection: boolean): ManualPriority | null | undefined {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || editing || overlayOpen || !hasSelection) return undefined;
  return event.key === '1' ? 'p1' : event.key === '2' || event.key === '3' ? 'p2' : event.key === '0' ? null : undefined;
}

export function prioritizedCanvasRecords(records: readonly CanvasNodeRecord[]): CanvasNodeRecord[] {
  return records.map(record => ({ record, priority: displayedPriority(record) }))
    .filter(item => item.priority)
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
    .map(item => item.record);
}

export function projectPriorityMap(board: BoardState, records: readonly CanvasNodeRecord[]): Map<string, ManualPriority> {
  return new Map(records.flatMap((record) => record.kind === 'task' && record.projectKey && record.manualPriority
    ? [[record.projectKey, manualLevel(record.manualPriority)!] as const] : []));
}

export function portfolioActions(board: BoardState, records: readonly CanvasNodeRecord[], projectKey = 'all') {
  const priorities = projectPriorityMap(board, records);
  const sidebar = (a: ProjectAction) => a.todo?.sidebarIndex ?? a.sources[0]?.sidebarIndex ?? Number.MAX_SAFE_INTEGER;
  const threads = byProject(board.threads), todos = byProject(board.todos);
  return board.projects.filter(p => projectKey === 'all' || p.projectKey === projectKey)
    .sort((a,b) => priorityRank(priorities.get(a.projectKey)) - priorityRank(priorities.get(b.projectKey)) ||
      (a.sidebarIndex ?? Number.MAX_SAFE_INTEGER) - (b.sidebarIndex ?? Number.MAX_SAFE_INTEGER))
    .flatMap(p => projectActions({threads:threads.get(p.projectKey) ?? [],todos:todos.get(p.projectKey) ?? []})
      .sort((a,b)=>sidebar(a)-sidebar(b)).map(action=>({projectKey:p.projectKey,action})));
}

function byProject<T extends { projectKey?: string }>(items: T[]) {
  const groups = new Map<string,T[]>();
  for (const item of items) if (item.projectKey) {
    const group = groups.get(item.projectKey);
    if (group) group.push(item); else groups.set(item.projectKey,[item]);
  }
  return groups;
}

export function priorityRank(priority: ManualPriority | null | undefined): number {
  return priority ? manualPriorityOrder[priority] : 3;
}
