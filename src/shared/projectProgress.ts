import type { BoardThread, WorkState } from './schema.js';

const labels: Record<WorkState, string> = {
  in_progress: '进行中', stage_closed: '阶段收口', intentionally_closed: '主动收口',
  waiting_for_user: '等你行动', waiting_external: '等外部条件', needs_validation: '待验证',
  complete: '已完成', insufficient_evidence: '证据不足'
};
const validTime = (value?: string): number => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;

/** Source time, never the time a cache was checked or a summary was generated. */
export function threadSourceTime(thread: BoardThread): string | undefined {
  if (validTime(thread.sourceUpdatedAt)) return thread.sourceUpdatedAt;
  return thread.recap?.sources.map(s => s.occurredAt).filter(t => validTime(t)).sort((a, b) => validTime(b) - validTime(a))[0];
}

export function recapNeedsUpdate(thread: BoardThread): boolean {
  if (!thread.recap) return false;
  return thread.recapOutdated ?? (validTime(thread.recap.evidenceCheckedAt) > 0 &&
    validTime(thread.sourceUpdatedAt) > validTime(thread.recap.evidenceCheckedAt));
}

export function recordedWorkState(thread: BoardThread): WorkState {
  if (thread.recap) {
    const { workState, nextStep } = thread.recap.summary;
    return workState === 'waiting_for_user' && nextStep?.kind === 'wait' ? 'waiting_external' : workState;
  }
  return thread.workState === 'waiting_for_user' && ['optional', 'recommended'].includes(thread.actionStrength)
    ? 'insufficient_evidence' : thread.workState;
}

export function recentProjectThreads(threads: BoardThread[]): BoardThread[] {
  return [...threads].sort((a, b) => Number(Boolean(a.missingSince)) - Number(Boolean(b.missingSince)) ||
    validTime(threadSourceTime(b)) - validTime(threadSourceTime(a)) ||
    (a.sidebarIndex ?? Number.MAX_SAFE_INTEGER) - (b.sidebarIndex ?? Number.MAX_SAFE_INTEGER) || a.threadKey.localeCompare(b.threadKey));
}

/** Preserve recorded native order. Unindexed discoveries retain insertion order;
 * checking, age and inferred work state must not reshuffle this reading list. */
export function orderedProjectThreads(threads: BoardThread[]): BoardThread[] {
  return [...threads].sort((a, b) => (a.sidebarIndex ?? Number.MAX_SAFE_INTEGER) - (b.sidebarIndex ?? Number.MAX_SAFE_INTEGER));
}

/** Deterministic portfolio of work lines, not another model's inferred project plan. */
export function projectProgress(threads: BoardThread[]) {
  const recent = recentProjectThreads(threads);
  const active = recent.filter(t => !t.missingSince);
  const groups = (Object.keys(labels) as WorkState[]).flatMap(state => {
    const members = active.filter(t => recordedWorkState(t) === state);
    return members.length ? [{ state, label: labels[state], threads: members }] : [];
  });
  const order: WorkState[] = ['waiting_for_user', 'in_progress', 'needs_validation', 'waiting_external', 'insufficient_evidence'];
  // Even all covered conversations being complete does not close the whole project.
  const workState = order.find(s => groups.some(g => g.state === s)) ?? (active.length ? 'stage_closed' : 'insufficient_evidence');
  return {
    recent, groups, latest: active[0], workState: workState as WorkState,
    stage: groups.length ? groups.map(g => `${g.threads.length} 条${g.label}`).join(' · ') : '暂无可判断的对话证据',
    missingCount: threads.length - active.length,
    summarizedCount: active.filter(t => t.recap).length
  };
}
