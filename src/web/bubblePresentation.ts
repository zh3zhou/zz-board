import type { BoardThread, CanvasNodeRecord, SnapshotProject } from '../shared/schema.js';

export function noteDisplayText(record: Pick<CanvasNodeRecord, 'title' | 'body'>): string {
  return record.body;
}

export function taskDisplayTitle(thread: BoardThread | undefined, record: Pick<CanvasNodeRecord, 'title'>, project?: Pick<SnapshotProject, 'name'>): string {
  if (project) return project.name.trim() || '未命名项目';
  const compatible = thread as (BoardThread & { displayTitle?: string }) | undefined;
  return compatible?.displayTitle?.trim() || record.title.trim() || '未命名任务';
}
