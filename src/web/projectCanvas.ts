import type {
  ActionStrength, BoardProjectBrief, BoardState, BoardThread, BoardTodo, CanvasNodeRecord,
  Confidence, HumanAction, LocalLinkRecord, RuntimeState, SnapshotProject, WorkState
} from '../shared/schema.js';
import { deriveVisualSignals, findInboxPosition } from '../shared/layout.js';
import { projectActions, retainedProjectTodos } from './projectActions.js';
import { recapNeedsUpdate, recordedWorkState } from '../shared/projectProgress.js';

export interface ProjectBubbleContext {
  project: SnapshotProject;
  brief?: BoardProjectBrief;
  /** Preserve each source conversation, including explicitly missing coverage. */
  threads: BoardThread[];
  todos: BoardTodo[];
  /** Includes the project node and legacy conversation nodes for local annotations. */
  memberNodeIds: string[];
}

export interface ProjectSignals {
  workState: WorkState;
  runtimeState: RuntimeState;
  humanAction: HumanAction;
  actionStrength: ActionStrength;
  confidence: Confidence;
  running: boolean;
  actionRequired: boolean;
  staleRuntime: boolean;
}

function bySidebar<T extends { sidebarIndex?: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.sidebarIndex ?? Number.MAX_SAFE_INTEGER) - (b.sidebarIndex ?? Number.MAX_SAFE_INTEGER));
}

function memberRecords(board: BoardState, projectKey: string): CanvasNodeRecord[] {
  const threadKeys = new Set(board.threads.filter((thread) => thread.projectKey === projectKey).map((thread) => thread.threadKey));
  return board.nodes.filter((node) => node.kind === 'task' &&
    (node.projectKey === projectKey || Boolean(node.threadKey && threadKeys.has(node.threadKey))));
}

export function contextForNode(board: BoardState, node: CanvasNodeRecord): ProjectBubbleContext | undefined {
  if (node.kind !== 'task') return undefined;
  const projectKey = node.projectKey || board.threads.find((thread) => thread.threadKey === node.threadKey)?.projectKey;
  const project = board.projects.find((item) => item.projectKey === projectKey);
  if (!project) return undefined;
  const threads = bySidebar(board.threads.filter((thread) => thread.projectKey === project.projectKey));
  const members = memberRecords(board, project.projectKey);
  const orderedMemberIds = threads.flatMap((thread) => members.filter((member) => member.threadKey === thread.threadKey).map((member) => member.id));
  return {
    project,
    brief: board.projectBriefs?.find((brief) => brief.projectKey === project.projectKey && !brief.missingSince),
    threads,
    todos: bySidebar((board.todos || []).filter((todo) => todo.projectKey === project.projectKey && !todo.missingSince)),
    memberNodeIds: [...new Set([`project:${project.projectKey}`, node.id, ...orderedMemberIds, ...members.map((member) => member.id)])]
  };
}

/** A view projection only: legacy nodes and their saved coordinates remain untouched. */
export function visibleCanvasRecords(board: BoardState): CanvasNodeRecord[] {
  const records: CanvasNodeRecord[] = [];
  const projectKeys = new Set(board.projects.map((project) => project.projectKey));
  const threadProjects = new Map(board.threads.map((thread) => [thread.threadKey, thread.projectKey]));
  for (const project of bySidebar(board.projects)) {
    const members = memberRecords(board, project.projectKey).filter((node) => !node.archivedAt);
    const projectNode = members.find((node) => node.id === `project:${project.projectKey}` && node.projectKey === project.projectKey) ||
      members.find((node) => node.projectKey === project.projectKey && !node.threadKey);
    const orderedThreads = bySidebar(board.threads.filter((thread) => thread.projectKey === project.projectKey));
    const anchor = projectNode || orderedThreads.map((thread) => members.find((node) => node.threadKey === thread.threadKey)).find(Boolean);
    if (anchor) {
      records.push({ ...anchor, projectKey: project.projectKey, threadKey: null, title: project.name });
    } else {
      // Old offline caches may not yet have a project node. App treats this as read-only.
      const place = findInboxPosition([...board.nodes, ...records]);
      records.push({
        id: `project:${project.projectKey}`, kind: 'task', projectKey: project.projectKey, threadKey: null, archivedAt: null,
        ...place, width: 180, height: 180, zIndex: 1, title: project.name, body: '',
        lastViewedAt: null, revision: 0, createdAt: project.observedAt, updatedAt: project.observedAt
      });
    }
  }
  for (const node of board.nodes) {
    if (node.archivedAt) continue;
    if (node.kind === 'note') { records.push(node); continue; }
    const projectKey = node.projectKey || (node.threadKey ? threadProjects.get(node.threadKey) : undefined);
    if (projectKey && projectKeys.has(projectKey)) continue;
    // Project nodes without a current saved project are historical, not standalone conversations.
    if (node.projectKey && !node.threadKey) continue;
    records.push(node);
  }
  return records;
}

export function projectNodeForThread(board: BoardState, threadKey: string, records = visibleCanvasRecords(board)): CanvasNodeRecord | undefined {
  const thread = board.threads.find((item) => item.threadKey === threadKey);
  if (!thread) return undefined;
  if (thread.projectKey && board.projects.some((project) => project.projectKey === thread.projectKey)) {
    return records.find((node) => node.projectKey === thread.projectKey);
  }
  return records.find((node) => node.threadKey === threadKey);
}

/** Resolve a projected project bubble back to one concrete persisted node for local writes. */
export function persistedLinkEndpoint(board: BoardState, record: CanvasNodeRecord): string | undefined {
  const direct = board.nodes.find((node) => node.id === record.id && !node.archivedAt);
  if (direct) return direct.id;
  const context = contextForNode(board, record);
  return context?.memberNodeIds.find((id) => board.nodes.some((node) => node.id === id && !node.archivedAt));
}

export function hasLinkBetween(board: BoardState, sourceNodeId: string, targetNodeId: string): boolean {
  return board.links.some((link) =>
    (link.sourceNodeId === sourceNodeId && link.targetNodeId === targetNodeId) ||
    (link.sourceNodeId === targetNodeId && link.targetNodeId === sourceNodeId));
}

export function linkTouchesSelection(link: Pick<LocalLinkRecord, 'sourceNodeId' | 'targetNodeId'>, selectedIds: readonly string[]): boolean {
  return selectedIds.includes(link.sourceNodeId) || selectedIds.includes(link.targetNodeId);
}

/** Keep each local link's identity/label; only remap displayed endpoints. */
export function canvasLinks(board: BoardState, records: CanvasNodeRecord[]): LocalLinkRecord[] {
  const visibleIds = new Set(records.map((node) => node.id));
  const mapping = new Map<string, string>();
  for (const record of records) {
    mapping.set(record.id, record.id);
    const context = contextForNode(board, record);
    for (const memberId of context?.memberNodeIds || []) mapping.set(memberId, record.id);
  }
  return board.links.flatMap((link) => {
    const sourceNodeId = mapping.get(link.sourceNodeId);
    const targetNodeId = mapping.get(link.targetNodeId);
    if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId || !visibleIds.has(sourceNodeId) || !visibleIds.has(targetNodeId)) return [];
    return [{ ...link, sourceNodeId, targetNodeId }];
  });
}

const terminalStates = new Set<WorkState>(['complete', 'stage_closed', 'intentionally_closed']);

export function projectSignals(context: ProjectBubbleContext, now = new Date()): ProjectSignals {
  const threads = context.threads.filter(thread => !thread.missingSince).map(thread => ({
    ...thread, workState: recordedWorkState(thread), confidence: thread.recap?.summary.confidence ?? thread.confidence
  }));
  const brief = !threads.some(t => t.recap) && context.brief && !context.brief.missingSince ? context.brief : undefined;
  const retained = retainedProjectTodos(context);
  const todos = retained.map(item => item.todo);
  const threadSignals = threads.map((thread) => deriveVisualSignals(thread, null, now));
  const runtimeState: RuntimeState = threads.some((thread) => thread.runtimeState === 'running') ? 'running'
    : threads.some((thread) => thread.runtimeState === 'error') ? 'error'
      : threads.some((thread) => thread.runtimeState === 'interrupted') ? 'interrupted'
        : !threads.length || threads.some((thread) => thread.runtimeState === 'unknown') ? 'unknown' : 'idle';
  const action = projectActions(context, retained)[0];
  let workState: WorkState;
  if (action?.strength === 'blocking') workState = action.kind === 'test' ? 'needs_validation' : 'waiting_for_user';
  else if ((brief?.workState === 'waiting_for_user' && !threads.some(thread => ['optional', 'recommended'].includes(thread.actionStrength))) || threads.some(thread => thread.workState === 'waiting_for_user')) workState = 'waiting_for_user';
  else if ((brief?.workState === 'needs_validation' && !threads.some(thread => ['optional', 'recommended'].includes(thread.actionStrength))) || threads.some((thread) => thread.workState === 'needs_validation' && (thread.recap || !['optional', 'recommended'].includes(thread.actionStrength)))) workState = 'needs_validation';
  else if (brief && terminalStates.has(brief.workState)) {
    // A completed turn (or an idle process) is never sufficient to close a whole project.
    const supported = brief.evidenceLevel !== 'none' && brief.confidence !== 'low' &&
      threads.every((thread) => !recapNeedsUpdate(thread) && terminalStates.has(thread.workState) && thread.runtimeState !== 'running' && thread.runtimeState !== 'error' && thread.runtimeState !== 'interrupted');
    workState = supported ? brief.workState : 'insufficient_evidence';
  } else if (brief && !['insufficient_evidence', 'waiting_for_user', 'needs_validation'].includes(brief.workState) && brief.evidenceLevel !== 'none') workState = brief.workState;
  else if (threads.some(thread => thread.workState === 'in_progress') || threadSignals.some(s => s.running)) workState = 'in_progress';
  else if (threads.some((thread) => thread.workState === 'waiting_external') || todos.some((todo) => todo.kind === 'wait')) workState = 'waiting_external';
  else if (threads.length && threads.every(thread => !recapNeedsUpdate(thread) && terminalStates.has(thread.workState))) workState = 'stage_closed';
  else workState = 'insufficient_evidence';

  const evidenceConfidence = [brief?.confidence, ...threads.map((thread) => thread.confidence), ...todos.map((todo) => todo.confidence)].filter(Boolean) as Confidence[];
  const confidence: Confidence = workState === 'insufficient_evidence' || !evidenceConfidence.length || evidenceConfidence.includes('low') ? 'low'
    : evidenceConfidence.includes('medium') ? 'medium' : 'high';
  return {
    workState, runtimeState,
    humanAction: action?.kind || (workState === 'waiting_external' ? 'wait' : workState === 'waiting_for_user' || workState === 'needs_validation' || workState === 'insufficient_evidence' ? 'uncertain' : 'none'),
    actionStrength: action?.strength || 'none', confidence,
    running: threadSignals.some((signals) => signals.running),
    actionRequired: Boolean(action),
    staleRuntime: threadSignals.some((signals) => signals.staleRuntime)
  };
}
