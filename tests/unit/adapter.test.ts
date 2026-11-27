import { describe, expect, it } from 'vitest';
import { appServerThreadsToSnapshot } from '../../src/server/codex/adapter.js';

describe('Codex App Server adapter', () => {
  it('maps the current thread/list envelope without inventing semantic state', () => {
    const snapshot = appServerThreadsToSnapshot({ data: [{ id: 'thr_1', preview: 'Inspect a prototype', cwd: 'E:\\project', updatedAt: 1_787_000_000, status: { type: 'active', activeFlags: [] } }] }, '2026-08-20T00:00:00.000Z');
    expect(snapshot.threads[0]).toMatchObject({ threadId: 'thr_1', title: 'Inspect a prototype', runtimeState: 'running', workState: 'insufficient_evidence', humanAction: 'uncertain' });
    expect(snapshot.projects[0].cwd).toBe('E:\\project');
  });
});
