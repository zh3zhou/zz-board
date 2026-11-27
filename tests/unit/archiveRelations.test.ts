import { describe, expect, it } from 'vitest';
import type { BoardState, CanvasNodeRecord, LocalLinkRecord } from '../../src/shared/schema.js';
import { archivedNoteRelations, archivedRelationsForNode } from '../../src/web/archiveRelations.js';
import { canvasLinks, visibleCanvasRecords } from '../../src/web/projectCanvas.js';

const now = '2026-09-01T00:00:00.000Z';
const node = (id: string, patch: Partial<CanvasNodeRecord> = {}): CanvasNodeRecord => ({
  id, kind: 'note', threadKey: null, projectKey: null, archivedAt: null, manualPriority: null,
  x: 0, y: 0, width: 180, height: 150, zIndex: 1, title: '', body: id, lastViewedAt: null, revision: 0, createdAt: now, updatedAt: now, ...patch
});
const link = (id: string, sourceNodeId: string, targetNodeId: string): LocalLinkRecord => ({
  id, sourceNodeId, targetNodeId, label: '', revision: 0, createdAt: now
});

function board(): BoardState {
  return {
    boardRevision: 1,
    projects: [{ projectKey: 'alpha', name: 'Alpha 项目', sidebarIndex: 0, observedAt: now }],
    threads: [{ threadKey: 'old-thread', threadId: 'old-thread', projectKey: 'alpha', title: '旧来源', displayTitle: '旧对话', sourceKind: 'snapshot',
      observedAt: now, runtimeState: 'idle', workState: 'in_progress', humanAction: 'none', actionStrength: 'none', stopPoint: '', evidence: '', confidence: 'medium', lastObservedAt: now, missingSince: null }],
    projectBriefs: [], todos: [],
    nodes: [
      node('project:alpha', { kind: 'task', projectKey: 'alpha', width: 180, height: 180, title: 'Alpha 项目' }),
      node('task:old-thread', { kind: 'task', threadKey: 'old-thread', width: 180, height: 180, title: '旧来源' }),
      node('note:archived', { archivedAt: now, body: '早先记录的关键假设' }),
      node('note:active', { x: 300, body: '仍在画布上的补充' }),
      node('note:other-archived', { archivedAt: now, body: '另一张归档便签' })
    ],
    annotations: [],
    links: [
      { id: 'legacy-project-link', sourceNodeId: 'task:old-thread', targetNodeId: 'note:archived', label: '', revision: 0, createdAt: now },
      { id: 'note-link', sourceNodeId: 'note:archived', targetNodeId: 'note:active', label: '', revision: 0, createdAt: now },
      { id: 'archived-note-link', sourceNodeId: 'note:archived', targetNodeId: 'note:other-archived', label: '', revision: 0, createdAt: now }
    ],
    inkStrokes: [], viewport: { x: 0, y: 0, zoom: 1 },
    settings: { theme: 'archive-paper', activeSkinRef: null, skinComponents: {}, keyBindings: {}, drawingPreferences: { penColor: '#000', penSize: 4, highlighterColor: '#ff0', highlighterSize: 18, eraserMode: 'whole', lassoMode: 'ink', layer: 'background', paletteCollapsed: true }, curatorThreadId: null, lastDailyReviewDate: null, lastGlobalSnapshotAt: null },
    historyStatus: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null }
  };
}

function foldedBoard(): BoardState {
  const value = board();
  value.nodes = [
    ...value.nodes.filter((item) => item.kind === 'task'),
    node('note:host', { body: '已收纳的宿主', foldedIntoNodeId: 'project:alpha' }),
    node('note:archived', { body: '归档子便签', archivedAt: now })
  ];
  value.links = [
    link('source-host', 'task:old-thread', 'note:host'),
    link('host-archived', 'note:host', 'note:archived')
  ];
  return value;
}

describe('archived relation projection', () => {
  it('maps a legacy conversation endpoint back to its project and preserves note relations', () => {
    const value = board();
    const relation = archivedNoteRelations(value).find((item) => item.note.id === 'note:archived')!;
    expect(relation.linkCount).toBe(3);
    expect(relation.related).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'task:old-thread', canvasNodeId: 'project:alpha', kind: 'task', title: 'Alpha 项目' }),
      expect.objectContaining({ canvasNodeId: 'note:active', kind: 'note', title: '仍在画布上的补充' }),
      expect.objectContaining({ canvasNodeId: null, kind: 'note', title: '另一张归档便签' })
    ]));
    const projectNode = visibleCanvasRecords(value).find((item) => item.id === 'project:alpha')!;
    expect(archivedRelationsForNode(value, projectNode).map((item) => item.note.id)).toEqual(['note:archived']);
  });

  it('projects an archived child through its valid folded host without changing persisted endpoints', () => {
    const value = foldedBoard();
    const before = structuredClone(value);
    const relation = archivedNoteRelations(value).find((item) => item.note.id === 'note:archived')!;
    expect(relation.linkCount).toBe(1);
    expect(relation.related).toEqual([
      { nodeId: 'note:host', canvasNodeId: 'project:alpha', kind: 'task', title: 'Alpha 项目' }
    ]);
    const project = visibleCanvasRecords(value).find((item) => item.id === 'project:alpha')!;
    expect(archivedRelationsForNode(value, project).map((item) => item.note.id)).toEqual(['note:archived']);
    expect(archivedRelationsForNode(value, value.nodes.find((item) => item.id === 'note:host')!).map((item) => item.note.id))
      .toEqual(['note:archived']);
    expect(value).toEqual(before);
  });

  it('uses the saved legacy source ID when an old cache has no project node', () => {
    const value = foldedBoard();
    value.nodes = value.nodes.filter((item) => item.id !== 'project:alpha');
    value.nodes.find((item) => item.id === 'note:host')!.foldedIntoNodeId = 'task:old-thread';
    const savedLinks = structuredClone(value.links);
    expect(archivedNoteRelations(value)[0]!.related).toEqual([
      { nodeId: 'note:host', canvasNodeId: 'task:old-thread', kind: 'task', title: 'Alpha 项目' }
    ]);
    const project = visibleCanvasRecords(value).find((item) => item.projectKey === 'alpha')!;
    expect(archivedRelationsForNode(value, project).map((item) => item.note.id)).toEqual(['note:archived']);
    expect(value.links).toEqual(savedLinks);
  });

  it('follows nested valid folds and stops at the first unfolded host', () => {
    const value = foldedBoard();
    value.nodes.push(node('note:inner', { body: '第二层宿主', foldedIntoNodeId: 'note:host' }));
    value.links = [
      link('source-host', 'task:old-thread', 'note:host'),
      link('host-inner', 'note:inner', 'note:host'),
      link('inner-archived', 'note:archived', 'note:inner')
    ];
    const project = visibleCanvasRecords(value).find((item) => item.id === 'project:alpha')!;
    expect(archivedNoteRelations(value)[0]!.related).toEqual([
      { nodeId: 'note:inner', canvasNodeId: 'project:alpha', kind: 'task', title: 'Alpha 项目' }
    ]);
    expect(archivedRelationsForNode(value, project).map((item) => item.note.id)).toEqual(['note:archived']);

    value.nodes.find((item) => item.id === 'note:host')!.foldedIntoNodeId = null;
    expect(archivedNoteRelations(value)[0]!.related).toEqual([
      { nodeId: 'note:inner', canvasNodeId: 'note:host', kind: 'note', title: '已收纳的宿主' }
    ]);
    expect(archivedRelationsForNode(value, project)).toEqual([]);
    expect(archivedRelationsForNode(value, value.nodes.find((item) => item.id === 'note:host')!).map((item) => item.note.id))
      .toEqual(['note:archived']);
  });

  it('does not follow ordinary note connections without a saved fold', () => {
    const value = foldedBoard();
    value.nodes.find((item) => item.id === 'note:host')!.foldedIntoNodeId = null;
    const project = visibleCanvasRecords(value).find((item) => item.id === 'project:alpha')!;
    expect(archivedNoteRelations(value)[0]!.related).toEqual([
      { nodeId: 'note:host', canvasNodeId: 'note:host', kind: 'note', title: '已收纳的宿主' }
    ]);
    expect(archivedRelationsForNode(value, project)).toEqual([]);
  });

  it.each<{ name: string; invalidate: (value: BoardState) => void }>([
    { name: 'missing upstream edge', invalidate: (value) => { value.links = value.links.filter((item) => item.id !== 'source-host'); } },
    { name: 'wrong immediate host', invalidate: (value) => {
      value.nodes.push(node('note:unrelated'));
      value.nodes.find((item) => item.id === 'note:host')!.foldedIntoNodeId = 'note:unrelated';
    } },
    { name: 'cycle', invalidate: (value) => {
      value.nodes.push(node('note:cycle'));
      value.links.push(link('root-cycle', 'project:alpha', 'note:cycle'), link('cycle-host', 'note:cycle', 'note:host'));
    } },
    { name: 'multiple project roots', invalidate: (value) => {
      value.projects.push({ projectKey: 'beta', name: 'Beta 项目', sidebarIndex: 1, observedAt: now });
      value.nodes.push(node('project:beta', { kind: 'task', projectKey: 'beta' }));
      value.links.push(link('beta-host', 'project:beta', 'note:host'));
    } },
    { name: 'archived host', invalidate: (value) => { value.nodes.find((item) => item.id === 'note:host')!.archivedAt = now; } }
  ])('does not project an invalid fold: $name', ({ invalidate }) => {
    const value = foldedBoard();
    invalidate(value);
    const host = value.nodes.find((item) => item.id === 'note:host')!;
    const relation = archivedNoteRelations(value).find((item) => item.note.id === 'note:archived')!;
    expect(relation.related).toEqual([
      { nodeId: host.id, canvasNodeId: host.archivedAt ? null : host.id, kind: 'note', title: host.body }
    ]);
    const project = visibleCanvasRecords(value).find((item) => item.id === 'project:alpha')!;
    expect(archivedRelationsForNode(value, project).some((item) => item.note.id === 'note:archived')).toBe(false);
  });

  it('deduplicates historical projected targets while preserving link counts and each direct lookup', () => {
    const value = foldedBoard();
    value.links = [
      link('source-host', 'task:old-thread', 'note:host'),
      link('parallel-source-host', 'note:host', 'project:alpha'),
      link('legacy-archived', 'task:old-thread', 'note:archived'),
      link('project-archived', 'note:archived', 'project:alpha'),
      link('host-archived', 'note:host', 'note:archived'),
      link('parallel-host-archived', 'note:archived', 'note:host')
    ];
    const savedLinks = structuredClone(value.links);
    const relation = archivedNoteRelations(value)[0]!;
    expect(relation.linkCount).toBe(4);
    expect(relation.related).toEqual([
      { nodeId: 'task:old-thread', canvasNodeId: 'project:alpha', kind: 'task', title: 'Alpha 项目' }
    ]);
    for (const id of ['project:alpha', 'task:old-thread', 'note:host']) {
      expect(archivedRelationsForNode(value, value.nodes.find((item) => item.id === id)!).map((item) => item.note.id))
        .toEqual(['note:archived']);
    }
    expect(value.links).toEqual(savedLinks);
  });

  it('removes a restored note from archived projection and makes its canvas line visible again', () => {
    const value = board();
    const restored = value.nodes.find((item) => item.id === 'note:archived')!;
    restored.archivedAt = null;
    expect(archivedNoteRelations(value).some((item) => item.note.id === restored.id)).toBe(false);
    expect(canvasLinks(value, visibleCanvasRecords(value))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'legacy-project-link', sourceNodeId: 'project:alpha', targetNodeId: 'note:archived' }),
      expect.objectContaining({ id: 'note-link', sourceNodeId: 'note:archived', targetNodeId: 'note:active' })
    ]));
  });
});
