import type { ActionStrength, BoardThread, BoardTodo, HumanAction } from '../shared/schema.js';
import { recapNeedsUpdate, recordedWorkState } from '../shared/projectProgress.js';
import { actionLabel } from './labels.js';
import { sourceEventTime } from './projectContextReading.js';

export type ProjectAction = { kind: HumanAction; strength: BoardTodo['strength']; text: string; sources: BoardThread[]; todo?: BoardTodo };

/** Narrower than all recorded actions. Badge and default response list use the same evidence. */
export function awaitsResponse(action: ProjectAction): boolean {
  return action.strength === 'blocking' && action.sources.some(thread => {
    const state = recordedWorkState(thread);
    return currentForSource(action, thread) &&
      (state === 'waiting_for_user' || state === 'needs_validation' && action.kind === 'test');
  });
}

function currentForSource(action: ProjectAction, thread: BoardThread): boolean {
  if (thread.missingSince || recapNeedsUpdate(thread)) return false;
  if (!thread.recap) return true;
  const step = thread.recap.summary.nextStep;
  return step?.kind === action.kind && step.text === action.text &&
    step.strength === action.strength && ['user_request', 'accepted_plan', 'explicit_handoff'].includes(step.origin) &&
    step.sourceRefs.some(ref => thread.recap!.sources.some(source => source.id === ref));
}

export function historicalAction(action: ProjectAction): boolean {
  return !action.sources.some(thread => currentForSource(action, thread));
}

/** Ref IDs are local to one recap. Removing an unavailable source cannot establish their ownership. */
export function actionEvidenceThread({sources, todo}: ProjectAction): BoardThread | undefined {
  const thread = sources[0];
  if (sources.length !== 1 || !thread || thread.missingSince) return;
  if (todo && (todo.sourceThreadKeys.length !== 1 || todo.sourceThreadKeys[0] !== thread.threadKey ||
    thread.projectKey !== undefined && thread.projectKey !== todo.projectKey)) return;
  return thread;
}

export function actionRecordTime(action: ProjectAction): string | undefined {
  const thread = actionEvidenceThread(action);
  const refs = action.todo ? action.todo.actionEvidence?.sourceRefs : thread?.recap?.summary.nextStep?.sourceRefs;
  const citedAt = thread?.recap && refs ? sourceEventTime(thread.recap, refs) : undefined;
  if (action.todo) return citedAt ?? action.todo.observedAt;
  if (thread?.recap) return citedAt;
  const updatedAt = thread?.sourceUpdatedAt;
  return updatedAt && Number.isFinite(Date.parse(updatedAt)) ? updatedAt : undefined;
}
const rank: Record<ActionStrength, number> = { blocking: 0, recommended: 1, optional: 2, none: 3 };
const human = (kind: HumanAction) => kind !== 'none' && kind !== 'wait' && kind !== 'uncertain';

export function threadAction(thread: BoardThread): ProjectAction | undefined {
  if (thread.missingSince) return;
  const step = thread.recap?.summary.nextStep;
  if (thread.recap) return step && human(step.kind) ? { kind: step.kind, strength: step.strength, text: step.text, sources:[thread] } : undefined;
  if (thread.actionStrength === 'blocking' && human(thread.humanAction))
    return { kind: thread.humanAction, strength: thread.actionStrength, text: actionLabel(thread.humanAction), sources:[thread] };
}

type ActionContext = { threads: BoardThread[]; todos: BoardTodo[] };
export function retainedProjectTodos({threads,todos}: ActionContext) {
  const active = new Map(threads.filter(t => !t.missingSince).map(t => [t.threadKey,t]));
  return todos.flatMap(todo => {
    if (todo.missingSince) return [];
    const sources = todo.sourceThreadKeys.flatMap(key => active.get(key) ?? []);
    if ((todo.sourceThreadKeys.length && !sources.length) ||
        sources.some(t => t.recap?.summary.resolvedTodos.some(r => r.todoKey === todo.todoKey))) return [];
    return [{todo,sources}];
  });
}

/** The dot, preview and detail draw from the same attributable, unresolved actions. */
export function projectActions(context: ActionContext, retained = retainedProjectTodos(context)): ProjectAction[] {
  const actions: ProjectAction[] = [];
  const legacy: ProjectAction[] = [];
  for (const thread of context.threads) {
    const action = threadAction(thread);
    if (action) (thread.recap ? actions : legacy).push(action);
  }
  for (const {todo,sources} of retained) {
    if (!human(todo.kind) || todo.strength === 'optional' ||
        (todo.strength !== 'blocking' && !todo.actionEvidence)) continue;
    if (sources.some(t => t.recap?.summary.nextStep?.kind === todo.kind && t.recap.summary.nextStep.text === todo.minimumAction)) continue;
    actions.push({ kind: todo.kind, strength: todo.strength, text: todo.minimumAction, todo, sources });
  }
  for (const action of legacy) {
    if (!actions.some(a => a.todo?.sourceThreadKeys.includes(action.sources[0]!.threadKey) && a.kind === action.kind && rank[a.strength] <= rank[action.strength]))
      actions.push(action);
  }
  return actions.sort((a, b) => rank[a.strength] - rank[b.strength]);
}
