import { describe, expect, it } from 'vitest';
import type { BoardProjectBrief, BoardState, BoardThread, BoardTodo, CanvasNodeRecord, SnapshotProject } from '../../src/shared/schema.js';
import {
  canvasLinks, contextForNode, hasLinkBetween, linkTouchesSelection, persistedLinkEndpoint, projectNodeForThread, projectSignals,
  visibleCanvasRecords, type ProjectBubbleContext
} from '../../src/web/projectCanvas.js';

const now = '2026-08-31T12:00:00.000Z';
function project(key: string, sidebarIndex = 0): SnapshotProject {
  return { projectKey: key, name: `项目 ${key}`, sidebarIndex, observedAt: now };
}
function thread(key: string, projectKey?: string, patch: Partial<BoardThread> = {}): BoardThread {
  return {
    threadKey: key, projectKey, threadId: key, title: `来源 ${key}`, displayTitle: `对话 ${key}`,
    sourceKind: 'snapshot', runtimeState: 'idle', workState: 'in_progress', humanAction: 'none', actionStrength: 'none',
    stopPoint: '已完成当前修改，继续检查。', evidence: '合成测试证据', confidence: 'high', observedAt: now,
    lastObservedAt: now, missingSince: null, ...patch
  };
}
function node(id: string, patch: Partial<CanvasNodeRecord> = {}): CanvasNodeRecord {
  return {
    id, kind: 'task', threadKey: null, projectKey: null, archivedAt: null, title: '旧名称', body: '',
    x: 40, y: 90, width: 180, height: 180, zIndex: 1, lastViewedAt: null, revision: 2, createdAt: now, updatedAt: now, ...patch
  };
}
function board(patch: Partial<BoardState> = {}): BoardState {
  return {
    boardRevision: 1, projects: [], threads: [], projectBriefs: [], todos: [], nodes: [], annotations: [], links: [], inkStrokes: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { theme: 'archive-paper', activeSkinRef: null, skinComponents: {}, keyBindings: {}, drawingPreferences: { penColor: '#000', penSize: 4, highlighterColor: '#ff0', highlighterSize: 18, eraserMode: 'whole', lassoMode: 'ink', layer: 'background', paletteCollapsed: true }, curatorThreadId: null, lastDailyReviewDate: null, lastGlobalSnapshotAt: now },
    historyStatus: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null }, ...patch
  };
}
function brief(patch: Partial<BoardProjectBrief> = {}): BoardProjectBrief {
  return {
    projectKey: 'a', overview: '项目简报', currentStage: '当前阶段', workState: 'in_progress', stopPoint: '等待后续核验',
    codexOrExternalNext: '继续工作', evidenceLevel: 'deep_read', evidenceReason: '读取两条对话', confidence: 'high',
    observedAt: now, lastObservedAt: now, missingSince: null, ...patch
  };
}
function context(patch: Partial<ProjectBubbleContext> = {}): ProjectBubbleContext {
  return { project: project('a'), threads: [], todos: [], memberNodeIds: ['project:a'], ...patch };
}
function todo(patch: Partial<BoardTodo> = {}): BoardTodo {
  return {
    todoKey: 'decision', projectKey: 'a', sourceThreadKeys: ['one'], kind: 'decide', strength: 'blocking', title: '选择方案',
    minimumAction: '比较两个选项', whyNow: '下一步依赖选择', unlocks: '实现下一阶段', evidence: '明确要求用户选择',
    confidence: 'high', observedAt: now, lastObservedAt: now, missingSince: null, ...patch
  };
}

describe('project canvas projection', () => {
  it('locates a saved source on its own page even when both project titles, thread titles and native IDs match', () => {
    const local = thread('source:local', 'a', { sourceKind:'codex', hostId:'local', title:'验收', threadId:'same-id' });
    const remote = thread('source:remote', 'b', { sourceKind:'codex', hostId:'other', title:'验收', threadId:'same-id' });
    const value = board({ projects:[{...project('a'), name:'同名项目'}, {...project('b'), name:'同名项目'}], threads:[local, remote],
      nodes:[node('project:a',{projectKey:'a',pageId:'page:first'}), node('project:b',{projectKey:'b',pageId:'page:other'})] });
    expect(projectNodeForThread(value, remote.threadKey)).toMatchObject({ id:'project:b', pageId:'page:other' });
    const previousPage = visibleCanvasRecords(value).filter(record=>record.pageId==='page:first');
    expect(projectNodeForThread(value, remote.threadKey, previousPage)).toBeUndefined();
    expect(projectNodeForThread(value, 'missing')).toBeUndefined();
  });
  it('renders exactly one node per saved project in sidebar order, with standalone conversations and active notes', () => {
    const value = board({
      projects: [project('a', 2), project('b', 0)],
      threads: [thread('one', 'a'), thread('two', 'a'), thread('loose')],
      nodes: [node('task:one', { threadKey: 'one' }), node('task:two', { threadKey: 'two' }),
        node('project:a', { projectKey: 'a', x: 300 }), node('project:b', { projectKey: 'b' }),
        node('task:loose', { threadKey: 'loose' }), node('note:active', { kind: 'note', body: '还在画布' }),
        node('note:archived', { kind: 'note', archivedAt: now })]
    });
    const before = structuredClone(value);
    const visible = visibleCanvasRecords(value);
    expect(visible.map((item) => item.id)).toEqual(['project:b', 'project:a', 'task:loose', 'note:active']);
    expect(visible[1]).toMatchObject({ title: '项目 a', x: 300, revision: 2, threadKey: null });
    expect(value).toEqual(before);
    expect(projectNodeForThread(value, 'two')?.id).toBe('project:a');
    expect(projectNodeForThread(value, 'loose')?.id).toBe('task:loose');
  });

  it('uses a persisted legacy anchor for old offline caches without losing per-conversation membership or ordering', () => {
    const value = board({
      projects: [project('a')],
      threads: [thread('one', 'a', { sidebarIndex: 2 }), thread('two', 'a', { sidebarIndex: 0, missingSince: now })],
      nodes: [node('task:one', { threadKey: 'one' }), node('task:two', { threadKey: 'two', x: 420 })]
    });
    const projected = visibleCanvasRecords(value)[0];
    expect(projected).toMatchObject({ id: 'task:two', threadKey: null, projectKey: 'a', x: 420 });
    expect(value.nodes.some((saved) => saved.id === projected.id)).toBe(true);
    const source = contextForNode(value, projected)!;
    expect(source.threads.map((item) => item.threadKey)).toEqual(['two', 'one']);
    expect(source.memberNodeIds).toEqual(['project:a', 'task:two', 'task:one']);
    expect(contextForNode(value, value.nodes[0])?.project.projectKey).toBe('a');
  });

  it('keeps an evidence-poor saved project visible even without a persisted node', () => {
    const value = board({ projects: [project('empty')] });
    const first = visibleCanvasRecords(value)[0];
    expect(first).toMatchObject({ id: 'project:empty', projectKey: 'empty', threadKey: null });
    expect(value.nodes.some((saved) => saved.id === first.id)).toBe(false);
    expect(visibleCanvasRecords(value)).toEqual([first]);
    expect(projectSignals(contextForNode(value, first)!, new Date(now))).toMatchObject({
      workState: 'insufficient_evidence', runtimeState: 'unknown', humanAction: 'uncertain', confidence: 'low'
    });
  });

  it('does not fold a conversation into a missing project or create a context for a note', () => {
    const value = board({ threads: [thread('orphan', 'not-saved')], nodes: [node('task:orphan', { threadKey: 'orphan' })] });
    expect(visibleCanvasRecords(value).map((item) => item.id)).toEqual(['task:orphan']);
    expect(contextForNode(value, value.nodes[0])).toBeUndefined();
    expect(contextForNode(value, node('note', { kind: 'note' }))).toBeUndefined();
  });

  it('omits superseded briefs and todos from current project detail while retaining marked conversation sources', () => {
    const value = board({
      projects: [project('a')], nodes: [node('project:a', { projectKey: 'a' })],
      threads: [thread('one', 'a', { missingSince: now })],
      projectBriefs: [brief({ missingSince: now })], todos: [todo({ missingSince: now })]
    });
    const source = contextForNode(value, value.nodes[0])!;
    expect(source.brief).toBeUndefined();
    expect(source.todos).toEqual([]);
    expect(source.threads[0].missingSince).toBe(now);
  });

  it('maps legacy links to project nodes, preserving link metadata and dropping internal or archived endpoints', () => {
    const makeLink = (id: string, sourceNodeId: string, targetNodeId: string) => ({ id, sourceNodeId, targetNodeId, label: '关联说明', revision: 3, createdAt: now });
    const value = board({
      projects: [project('a'), project('b')], threads: [thread('one', 'a'), thread('two', 'a'), thread('three', 'b')],
      nodes: [node('project:a', { projectKey: 'a' }), node('project:b', { projectKey: 'b' }),
        node('task:one', { threadKey: 'one' }), node('task:two', { threadKey: 'two' }), node('task:three', { threadKey: 'three' }),
        node('note:hidden', { kind: 'note', archivedAt: now })],
      links: [makeLink('between', 'task:two', 'task:three'), makeLink('internal', 'task:one', 'task:two'), makeLink('hidden', 'task:one', 'note:hidden')]
    });
    expect(canvasLinks(value, visibleCanvasRecords(value))).toEqual([{ ...value.links[0], sourceNodeId: 'project:a', targetNodeId: 'project:b' }]);
    expect(value.links[0].sourceNodeId).toBe('task:two');
  });

  it('resolves projected bubbles to writable endpoints and treats soft links as undirected duplicates', () => {
    const value = board({
      projects: [project('a')], threads: [thread('one', 'a')],
      nodes: [node('task:one', { threadKey: 'one' }), node('note:idea', { kind: 'note', body: '想法' })]
    });
    const projected = visibleCanvasRecords(value).find((item) => item.projectKey === 'a')!;
    expect(projected.id).toBe('task:one');
    expect(persistedLinkEndpoint(value, projected)).toBe('task:one');
    expect(persistedLinkEndpoint(value, node('project:missing', { projectKey: 'missing' }))).toBeUndefined();
    value.links.push({ id: 'soft', sourceNodeId: 'task:one', targetNodeId: 'note:idea', label: '', revision: 0, createdAt: now });
    expect(hasLinkBetween(value, 'task:one', 'note:idea')).toBe(true);
    expect(hasLinkBetween(value, 'note:idea', 'task:one')).toBe(true);
    expect(linkTouchesSelection(value.links[0]!, ['note:idea'])).toBe(true);
    expect(linkTouchesSelection(value.links[0]!, ['unrelated'])).toBe(false);
  });
});

describe('conservative project signals', () => {
  it('retains a required decision even while a different conversation runs', () => {
    const value = context({
      brief: brief(), threads: [thread('one', 'a', { runtimeState: 'running' }), thread('two', 'a', { workState: 'waiting_for_user', humanAction: 'decide', actionStrength: 'blocking' })]
    });
    expect(projectSignals(value, new Date(now))).toMatchObject({
      running: true, runtimeState: 'running', workState: 'waiting_for_user', humanAction: 'decide', actionStrength: 'blocking', actionRequired: true
    });
  });

  it('uses project todos even if a completed child or brief could hide the action', () => {
    const value = context({ brief: brief({ workState: 'complete' }), threads: [thread('one', 'a', { workState: 'complete' })], todos: [todo()] });
    expect(projectSignals(value, new Date(now))).toMatchObject({ workState: 'waiting_for_user', humanAction: 'decide', actionRequired: true });
  });

  it('does not revive a zero-strength action attached to an explicitly closed conversation', () => {
    const value = context({ brief: brief({ workState: 'complete' }), threads: [thread('one', 'a', { workState: 'complete', humanAction: 'review', actionStrength: 'none' })] });
    expect(projectSignals(value, new Date(now))).toMatchObject({ workState: 'complete', humanAction: 'none', actionRequired: false });
  });

  it('does not equate completed conversations with project completion or hide conflicting unknown evidence', () => {
    const completed = thread('one', 'a', { workState: 'complete' });
    expect(projectSignals(context({ threads: [completed] }), new Date(now)).workState).toBe('stage_closed');
    expect(projectSignals(context({ brief: brief({ workState: 'complete' }), threads: [completed] }), new Date(now)).workState).toBe('complete');
    expect(projectSignals(context({ brief: brief({ workState: 'complete' }), threads: [completed, thread('unknown', 'a', { workState: 'insufficient_evidence', confidence: 'low' })] }), new Date(now)))
      .toMatchObject({ workState: 'insufficient_evidence', confidence: 'low' });
    expect(projectSignals(context({ brief: brief({ workState: 'complete' }), threads: [thread('running', 'a', { runtimeState: 'running' })] }), new Date(now)))
      .toMatchObject({ workState: 'insufficient_evidence', running: true });
  });

  it('ignores uncovered historical rows for current signals but retains them as individual sources', () => {
    const value = context({
      brief: brief({ workState: 'complete' }), threads: [thread('old', 'a', { runtimeState: 'running', humanAction: 'approve', missingSince: now })],
      todos: [todo({ missingSince: now })]
    });
    expect(projectSignals(value, new Date(now))).toMatchObject({ workState: 'complete', runtimeState: 'unknown', running: false, actionRequired: false });
    expect(value.threads).toHaveLength(1);
  });

  it('does not turn a stale running snapshot into a live running glow', () => {
    const value = context({ threads: [thread('old', 'a', { runtimeState: 'running', observedAt: '2026-08-30T12:00:00.000Z' })] });
    expect(projectSignals(value, new Date(now))).toMatchObject({ runtimeState: 'running', running: false, staleRuntime: true });
  });

  it('requires closure evidence even when the project has no conversation', () => {
    expect(projectSignals(context({ brief: brief({ workState: 'intentionally_closed', evidenceLevel: 'file_verified' }) }), new Date(now)).workState).toBe('intentionally_closed');
    expect(projectSignals(context({ brief: brief({ workState: 'complete', evidenceLevel: 'none' }) }), new Date(now)).workState).toBe('insufficient_evidence');
    expect(projectSignals(context(), new Date(now)).workState).toBe('insufficient_evidence');
  });
});
