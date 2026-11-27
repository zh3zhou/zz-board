import type { BoardDatabase } from './database.js';

export interface ProjectCheckOptions { automatic?: boolean }
export type ProjectPagePauseReason = 'page_archived' | 'page_auto_paused';

export function projectPagePauseReason(db: BoardDatabase, projectKey: string, options: ProjectCheckOptions = {}): ProjectPagePauseReason | null {
  const policy = db.getProjectPagePolicy(projectKey);
  return policy.archived ? 'page_archived' : options.automatic && policy.autoCheckPaused ? 'page_auto_paused' : null;
}

export function projectPagePauseMessage(reason: ProjectPagePauseReason): string {
  return reason === 'page_archived' ? '页面已归档，相关项目未开始的读取与总结已跳过。' : '页面自动检查已暂停，相关项目未开始的读取与总结已跳过。';
}

export class ProjectPagePausedError extends Error {
  readonly statusCode = 409;
  readonly code = 'PROJECT_PAGE_PAUSED';
  constructor(readonly reason: ProjectPagePauseReason) { super(projectPagePauseMessage(reason)); this.name = 'ProjectPagePausedError'; }
}

export function requireProjectPageCheck(db: BoardDatabase, projectKey: string, options: ProjectCheckOptions = {}): void {
  const reason = projectPagePauseReason(db, projectKey, options);
  if (reason) throw new ProjectPagePausedError(reason);
}

/** A temporary suspension retires an old collection even if the page is restored before its next await returns. */
export function watchProjectPageCheck(db: BoardDatabase, projectKey: string, options: ProjectCheckOptions = {}) {
  let blocked = projectPagePauseReason(db, projectKey, options);
  const unsubscribe = db.onMutation(() => { blocked ||= projectPagePauseReason(db, projectKey, options); });
  return {
    check() {
      blocked ||= projectPagePauseReason(db, projectKey, options);
      if (blocked) throw new ProjectPagePausedError(blocked);
    },
    dispose: unsubscribe
  };
}
