import { manualLevel } from '../shared/notePriority.js';
import type { CanvasNodeRecord, SnapshotProject } from '../shared/schema.js';

export type ProjectDrawerStatus = 'all' | 'action' | 'uncertain' | 'closed';
export type ProjectDrawerPriority = 'all' | 'p1' | 'p2' | 'unset';

export interface DrawerProjectSignal {
  actionRequired: boolean;
  uncertain: boolean;
  closed: boolean;
}

export function compactP1Projects(projects: readonly SnapshotProject[], records: readonly CanvasNodeRecord[], limit = 4): { items: SnapshotProject[]; overflow: number } {
  const priority = priorityByProject(records);
  const matches = projects.filter((project) => priority.get(project.projectKey) === 'p1');
  return { items: matches.slice(0, limit), overflow: Math.max(0, matches.length - limit) };
}

export function filterDrawerProjects(input: {
  projects: readonly SnapshotProject[];
  records: readonly CanvasNodeRecord[];
  signals: ReadonlyMap<string, DrawerProjectSignal>;
  search: string;
  priority: ProjectDrawerPriority;
  status: ProjectDrawerStatus;
}): SnapshotProject[] {
  const priority = priorityByProject(input.records);
  const search = input.search.trim().toLocaleLowerCase('zh-CN');
  return input.projects.filter((project) => {
    const manualPriority = priority.get(project.projectKey) ?? null;
    const signal = input.signals.get(project.projectKey);
    const priorityMatches = input.priority === 'all' || (input.priority === 'unset' ? !manualPriority : manualPriority === input.priority);
    const statusMatches = input.status === 'all' || signal?.[input.status === 'action' ? 'actionRequired' : input.status];
    return priorityMatches && Boolean(statusMatches) && project.name.toLocaleLowerCase('zh-CN').includes(search);
  });
}

function priorityByProject(records: readonly CanvasNodeRecord[]): Map<string, CanvasNodeRecord['manualPriority']> {
  return new Map(records.filter((record) => record.kind === 'task' && record.projectKey).map((record) => [record.projectKey!, manualLevel(record.manualPriority)]));
}
