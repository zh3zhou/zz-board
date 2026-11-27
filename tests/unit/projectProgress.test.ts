import { describe, expect, it } from 'vitest';
import { orderedProjectThreads, projectProgress, recentProjectThreads, threadSourceTime } from '../../src/shared/projectProgress.js';
import type { BoardThread } from '../../src/shared/schema.js';
const thread = (id: string, patch: Partial<BoardThread> = {}): BoardThread => ({
  threadKey: id, threadId: id, title: id, displayTitle: id, sourceKind: 'codex', observedAt: '2026-09-21T00:00:00Z', lastObservedAt: '2026-09-21T00:00:00Z',
  missingSince: null, runtimeState: 'unknown', workState: 'in_progress', humanAction: 'none', actionStrength: 'none', stopPoint: '', evidence: '', confidence: 'low', ...patch
});
describe('project-wide progress projection', () => {
  it('keeps recorded conversation order regardless of recency, state and coverage', () => {
    const sources = [thread('second', {sidebarIndex:2,sourceUpdatedAt:'2026-09-22'}),thread('first',{sidebarIndex:0,sourceUpdatedAt:'2026-09-07',missingSince:'2026-09-22'}),thread('new-one'),thread('new-two')];
    expect(orderedProjectThreads(sources).map(t=>t.threadKey)).toEqual(['first','second','new-one','new-two']);
    expect(sources[0].threadKey).toBe('second');
  });
  it('orders source recency, not sidebar priority or last fetch time', () => {
    const sources = [thread('pinned', { sidebarIndex: 0, sourceUpdatedAt: '2026-08-01' }), thread('new', { sidebarIndex: 9, sourceUpdatedAt: '2026-09-20' }), thread('unknown'), thread('missing', { sourceUpdatedAt: '2026-09-21', missingSince: '2026-09-21' })];
    expect(recentProjectThreads(sources).map(t => t.threadKey)).toEqual(['new', 'pinned', 'unknown', 'missing']);
    expect(sources[0].threadKey).toBe('pinned'); expect(threadSourceTime(sources[2])).toBeUndefined();
  });
  it('keeps older unresolved work visible beside a newer completed source', () => {
    const progress = projectProgress([thread('old-decision', { workState: 'waiting_for_user', sourceUpdatedAt: '2026-09-01' }), thread('new-complete', { workState: 'complete', sourceUpdatedAt: '2026-09-20' })]);
    expect(progress.workState).toBe('waiting_for_user'); expect(progress.latest?.title).toBe('new-complete');
    expect(progress.stage).toContain('1 条等你行动'); expect(progress.stage).toContain('1 条已完成');
  });
  it('does not infer completion from absent/missing histories', () => {
    expect(projectProgress([thread('delivered', { workState: 'complete' })]).workState).toBe('stage_closed');
    expect(projectProgress([]).workState).toBe('insufficient_evidence');
    const p = projectProgress([thread('old', { workState: 'complete', missingSince: '2026-09-21' })]);
    expect(p.missingCount).toBe(1); expect(p.latest).toBeUndefined(); expect(p.workState).toBe('insufficient_evidence');
  });
  it('does not turn a legacy optional suggestion into a current human blocker', () => {
    for (const actionStrength of ['optional', 'recommended'] as const) {
      const p = projectProgress([thread('legacy', { workState: 'waiting_for_user', humanAction: 'review', actionStrength })]);
      expect(p.workState).toBe('insufficient_evidence'); expect(p.stage).not.toContain('等你行动');
    }
  });
});
