import type { BoardThread, SnapshotProject, ThreadRecap } from './schema.js';

export type ExcerptSource = ThreadRecap['sources'][number];
export type SourceExcerptResult = { status: 'found'; text: string; partial: boolean }
  | { status: 'unavailable'; reason: 'scope' | 'window' | 'content' | 'read' };

export const excerptUnavailable = {
  scope: '这条引用没有可核对的本机对话来源。',
  window: '在最近可读取的 40 个回合内没有找到这条记录。',
  content: '没有找到可按原样展示的这段文字。',
  read: '暂时无法读取本机来源。'
};

export function hasAbsoluteExcerptDirectory(cwd?: string): boolean {
  return Boolean(cwd && (/^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('/') || /^\\\\[^\\]+\\[^\\]+/.test(cwd)));
}

export function canLocateExcerpt(project: SnapshotProject | undefined, thread: BoardThread, source: ExcerptSource): boolean {
  return Boolean(project && project.projectKey === thread.projectKey && (!project.hostId || project.hostId === 'local')
    && (hasAbsoluteExcerptDirectory(project.cwd) || project.projectId?.trim())
    && thread.sourceKind === 'codex' && (thread.hostId === 'local' || !thread.hostId && thread.threadKey === `codex:local:${thread.threadId}`)
    && source.turnId && !source.path && (source.role === 'user' || source.role === 'assistant'));
}
