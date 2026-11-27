import { describe, expect, it } from 'vitest';
import type { BoardState, BoardTodo, CanvasNodeRecord } from '../../src/shared/schema.js';
import { prioritizedCanvasRecords, priorityFromShortcut, portfolioActions } from '../../src/web/manualPriority.js';

const now = '2026-09-01T00:00:00.000Z';
const node = (id: string, manualPriority: CanvasNodeRecord['manualPriority'], projectKey: string | null = null): CanvasNodeRecord => ({
  id, kind: projectKey ? 'task' : 'note', threadKey: null, projectKey, archivedAt: null, manualPriority,
  x: 0, y: 0, width: 180, height: 180, zIndex: 1, title: id, body: '', lastViewedAt: null, revision: 0, createdAt: now, updatedAt: now
});
const todo = (projectKey: string, sidebarIndex: number, strength: BoardTodo['strength'], deadline?: string): BoardTodo => ({
  todoKey: `${projectKey}:${sidebarIndex}`, projectKey, sourceThreadKeys: [], kind: 'decide', strength, title: projectKey,
  minimumAction: '行动', whyNow: '依据', unlocks: '结果', evidence: '证据', explicitDeadline: deadline, confidence: 'high', sidebarIndex,
  observedAt: now, lastObservedAt: now, missingSince: null
});

describe('manual priority policy', () => {
  it('owns only unmodified 1/2/3/0 canvas shortcuts outside editors and overlays', () => {
    const key = { key: '1', defaultPrevented: false, repeat: false, isComposing: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    expect(priorityFromShortcut(key, false, false, true)).toBe('p1');
    expect(priorityFromShortcut({ ...key, key: '3' }, false, false, true)).toBe('p2');
    expect(priorityFromShortcut({ ...key, key: '0' }, false, false, true)).toBeNull();
    expect(priorityFromShortcut({ ...key, key: '4' }, false, false, true)).toBeUndefined();
    expect(priorityFromShortcut(key, true, false, true)).toBeUndefined();
    expect(priorityFromShortcut(key, false, true, true)).toBeUndefined();
    expect(priorityFromShortcut({ ...key, ctrlKey: true }, false, false, true)).toBeUndefined();
  });

  it('groups legacy P3 with attention and keeps canvas order within each level', () => {
    const records = [node('p2-a', 'p2'), node('p1-a', 'p1'), node('unset', null), node('p3-a', 'p3'), node('p2-b', 'p2')];
    expect(prioritizedCanvasRecords(records).map((item) => item.id)).toEqual(['p1-a', 'p2-a', 'p3-a', 'p2-b']);
  });

  it('sorts todos by inherited project priority then sidebar order, ignoring suggested strength and deadlines', () => {
    const board: BoardState = {
      boardRevision: 1,
      projects: [{ projectKey: 'a', name: 'A', sidebarIndex: 1, observedAt: now }, { projectKey: 'b', name: 'B', sidebarIndex: 0, observedAt: now }, { projectKey: 'c', name: 'C', sidebarIndex: 2, observedAt: now }],
      threads: [], projectBriefs: [],
      todos: [todo('a', 1, 'blocking', '2020-01-01'), todo('b', 2, 'optional'), {...todo('b', 0, 'recommended'),actionEvidence:{origin:'accepted_plan',sourceRefs:['accepted']}},
        todo('b', 1, 'blocking'),todo('c', 0, 'blocking', '2019-01-01')],
      nodes: [], annotations: [], links: [], inkStrokes: [], viewport: { x: 0, y: 0, zoom: 1 },
      settings: { theme: 'archive-paper', activeSkinRef: null, skinComponents: {}, keyBindings: {}, drawingPreferences: { penColor: '#000', penSize: 4, highlighterColor: '#ff0', highlighterSize: 18, eraserMode: 'whole', lassoMode: 'ink', layer: 'background', paletteCollapsed: true }, curatorThreadId: null, lastDailyReviewDate: null, lastGlobalSnapshotAt: null },
      historyStatus: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null }
    };
    const records = [node('project:a', 'p2', 'a'), node('project:b', 'p1', 'b'), node('project:c', null, 'c')];
    expect(portfolioActions(board, records).map(item => item.action.todo?.todoKey)).toEqual(['b:0', 'b:1', 'a:1', 'c:0']);
  });
});
