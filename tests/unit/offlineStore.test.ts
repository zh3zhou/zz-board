import { describe, expect, it } from 'vitest';
import type { BoardState } from '../../src/shared/schema.js';
import { overlayQueuedNotes, patchQueuedNode, removeQueuedNode, type QueuedNote } from '../../src/web/offlineStore.js';

function emptyBoard(): BoardState {
  return {
    boardRevision: 0,
    projects: [],
    threads: [],
    projectBriefs: [],
    todos: [],
    nodes: [],
    annotations: [],
    links: [],
    inkStrokes: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: {
      theme: 'archive-paper',
      activeSkinRef: null,
      skinComponents: {},
      keyBindings: {},
      drawingPreferences: { penColor: '#000', penSize: 4, highlighterColor: '#ff0', highlighterSize: 18, eraserMode: 'whole', lassoMode: 'ink', layer: 'background', paletteCollapsed: true },
      curatorThreadId: null,
      lastDailyReviewDate: null,
      lastGlobalSnapshotAt: null
    },
    historyStatus: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null }
  };
}

function queued(id = 'one'): QueuedNote {
  return {
    id,
    tempNodeId: `offline-note:${id}`,
    createdAt: '2026-08-20T04:00:00.000Z',
    input: { title: '', body: '先记住这句话', x: 42, y: 84, width: 220, height: 150 }
  };
}

describe('offline note projection', () => {
  it('adds queued notes once and drops stale projections', () => {
    const first = overlayQueuedNotes(emptyBoard(), [queued()]);
    expect(first.nodes).toHaveLength(1);
    expect(first.nodes[0]).toMatchObject({ id: 'offline-note:one', body: '先记住这句话', x: 42 });

    const repeated = overlayQueuedNotes(first, [queued()]);
    expect(repeated.nodes).toHaveLength(1);

    const cleared = overlayQueuedNotes(first, []);
    expect(cleared.nodes).toHaveLength(0);
  });

  it('patches and removes only the projected note', () => {
    const board = overlayQueuedNotes(emptyBoard(), [queued()]);
    const changed = patchQueuedNode(board, 'offline-note:one', { body: '改过的内容', x: 120 });
    expect(changed.nodes[0]).toMatchObject({ body: '改过的内容', x: 120, revision: 1 });
    expect(removeQueuedNode(changed, 'offline-note:one').nodes).toHaveLength(0);
  });
});
