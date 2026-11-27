import { describe, expect, it } from 'vitest';
import type { BoardThread, CanvasNodeRecord } from '../../src/shared/schema.js';
import { matchesCanvasView } from '../../src/web/canvasVisibility.js';

const note: CanvasNodeRecord = { id: 'note:sample', kind: 'note', threadKey: null, x: 0, y: 0, width: 220, height: 150, zIndex: 1, title: '', body: '', lastViewedAt: null, revision: 0, createdAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z' };
const thread: BoardThread = { threadKey: 'test', threadId: 'source', projectKey: 'project', title: '合成任务', displayTitle: '合成任务', sourceKind: 'snapshot', runtimeState: 'running', workState: 'in_progress', humanAction: 'none', actionStrength: 'none', stopPoint: '', evidence: '', confidence: 'high', observedAt: note.createdAt, lastObservedAt: note.createdAt, missingSince: null };

describe('canvas filters, not record lifecycle', () => {
  it('includes user-prioritized notes and images in My priorities without Codex assignment', () => {
    for (const priority of ['p1', 'p2', 'p3'] as const) for (const notePresentation of ['note', 'image'] as const) {
      const record = { ...note, notePresentation, manualPriority: priority };
      expect(matchesCanvasView({ record }, 'all', 'priority')).toBe(true);
      expect(matchesCanvasView({ record }, 'project', 'priority')).toBe(true);
    }
    expect(matchesCanvasView({ record: note }, 'all', 'priority')).toBe(false);
  });
  it('shows all local notes in the notes view even after selecting a project', () => {
    expect(matchesCanvasView({ record: note }, 'project', 'notes')).toBe(true);
    expect(matchesCanvasView({ record: { ...note, kind: 'task' }, thread }, 'project', 'notes')).toBe(false);
  });
  it('preserves project, evidence and blank draft filtering regardless of runtime', () => {
    const task = { record: { ...note, kind: 'task' as const, manualPriority: 'p1' as const }, thread };
    expect(matchesCanvasView(task, 'other', 'all')).toBe(false);
    expect(matchesCanvasView(task, 'project', 'priority')).toBe(true);
    expect(matchesCanvasView(task, 'project', 'all')).toBe(true);
    expect(matchesCanvasView(task, 'project', 'uncertain')).toBe(false);
    expect(matchesCanvasView({ ...task, thread: { ...thread, confidence: 'low' } }, 'project', 'uncertain')).toBe(true);
    expect(matchesCanvasView({ record: note, isDraft: true }, 'other', 'uncertain')).toBe(true);
    expect(matchesCanvasView({ record: note }, 'project', 'all')).toBe(false);
    expect(note.body).toBe(''); expect(note.archivedAt).toBeUndefined();
  });
});
