import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

type Mode = 'success' | 'failed' | 'interrupted' | 'missing-id' | 'waiting' | 'waiting-start' | 'start-rejected';
const fixture = vi.hoisted(() => ({
  child: null as unknown as ChildProcessWithoutNullStreams,
  requests: [] as Array<{ id: number; method: string; params: Record<string, unknown> }>,
  mode: 'success' as Mode, holdReads: false,
  answer: { kind: 'answer', answer: '合成回答', relatedThreadKeys: [], reason: null, targetThreadKey: null, draft: null },
}));
vi.mock('../../src/server/codex/summaryRuntime.js', () => ({ resolveCodexExecutable: async (executable: string) => executable }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { EventEmitter } = await import('node:events'); const { PassThrough } = await import('node:stream');
  return { ...actual, spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
    });
    child.stdin.on('data', (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString());
      if (request.id == null) return;
      fixture.requests.push(request);
      if (fixture.holdReads && request.method === 'thread/read') return;
      if (fixture.mode === 'waiting-start' && request.method === 'turn/start') return;
      queueMicrotask(() => {
        if (request.method !== 'turn/start') { child.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\n'); return; }
        if (fixture.mode === 'start-rejected') { child.stdout.write(JSON.stringify({ id: request.id, error: { message: 'Synthetic start refusal.' } }) + '\n'); return; }
        const result = fixture.mode === 'missing-id' ? {} : { turn: { id: 'synthetic-turn' } };
        const messages: unknown[] = [{ id: request.id, result }];
        if (fixture.mode !== 'waiting') messages.push(
          { method: 'item/completed', params: { threadId: request.params.threadId, turnId: 'synthetic-turn', item: { type: 'agentMessage', text: JSON.stringify(fixture.answer) } } },
          { method: 'turn/completed', params: { threadId: request.params.threadId, turn: { id: 'synthetic-turn', status: fixture.mode === 'failed' || fixture.mode === 'interrupted' ? fixture.mode : 'completed' } } },
        );
        // One stdout chunk: promise continuations cannot register after the
        // response but before either completion notification is received.
        child.stdout.write(messages.map(message => JSON.stringify(message)).join('\n') + '\n');
      });
    });
    fixture.child = child as unknown as ChildProcessWithoutNullStreams; return child;
  } };
});
import { CodexAppServerClient } from '../../src/server/codex/appServerClient.js';

describe('curator app-server lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); fixture.requests = []; fixture.mode = 'success'; fixture.holdReads = false; });
  afterEach(() => { fixture.child?.stdin.destroy(); fixture.child?.stdout.destroy(); fixture.child?.stderr.destroy(); vi.useRealTimers(); });
  const client = () => new CodexAppServerClient('synthetic-executable');
  it('rejects and clears its own turn waiter on revoke without interrupting the task', async () => {
    fixture.mode = 'waiting'; const reader = client(); const abort = new AbortController(); let permitted = true;
    const operation = { signal: abort.signal, check: () => { if (!permitted) throw Object.assign(new Error('Synthetic access revoked.'), { code: 'CODEX_ACCESS_REQUIRED' }); } };
    const work = reader.sendCuratorTurn('synthetic-thread', 'Synthetic prompt.', operation).catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(1); expect(fixture.requests.at(-1)?.method).toBe('turn/start');
      permitted = false; abort.abort(); expect(await work).toMatchObject({ code: 'CODEX_ACCESS_REQUIRED' });
      expect(vi.getTimerCount()).toBe(0); expect(fixture.requests.some(request => request.method === 'turn/interrupt')).toBe(false);
    } finally { reader.dispose(); }
  });
  it('receives a fast structured answer when turn/start and both completion events share one chunk', async () => {
    const reader = client(); let outcome: unknown;
    const work = reader.sendCuratorTurn('synthetic-thread', 'Synthetic prompt.').then(value => { outcome = value; }, error => { outcome = error; });
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toEqual(fixture.answer); await work;
      expect(fixture.requests.map(request => request.method)).toEqual(['initialize', 'thread/resume', 'turn/start']);
      expect(fixture.requests[2]?.params).toMatchObject({ threadId: 'synthetic-thread', approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } });
      expect(vi.getTimerCount()).toBe(0);
    } finally { reader.dispose(); await work; }
  });
  it.each(['failed', 'interrupted'] as const)('rejects a fast %s turn without waiting for its deadline', async mode => {
    fixture.mode = mode; const reader = client(); let outcome: unknown;
    const work = reader.sendCuratorTurn('synthetic-thread', 'Synthetic prompt.').then(value => { outcome = value; }, error => { outcome = error; });
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toMatchObject({ message: `Curator turn ${mode}.` }); await work;
      expect(vi.getTimerCount()).toBe(0);
    } finally { reader.dispose(); await work; }
  });
  it('rejects a turn/start response without an id and leaves no provisional waiter deadline', async () => {
    fixture.mode = 'missing-id'; const reader = client();
    const work = reader.sendCuratorTurn('synthetic-thread', 'Synthetic prompt.').catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(await work).toMatchObject({ message: 'Codex App Server did not return a turn id.' });
      expect(vi.getTimerCount()).toBe(0);
    } finally { reader.dispose(); }
  });
  it('rejects turn/start RPC failure without retaining its provisional waiter deadline', async () => {
    fixture.mode = 'start-rejected'; const reader = client();
    const work = reader.sendCuratorTurn('synthetic-thread', 'Synthetic prompt.').catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(await work).toMatchObject({ message: 'Synthetic start refusal.' });
      expect(vi.getTimerCount()).toBe(0);
    } finally { reader.dispose(); }
  });
  it('dispose rejects an active curator turn and pending RPC, and removes every deadline', async () => {
    fixture.mode = 'waiting'; const reader = client();
    const turning = reader.sendCuratorTurn('synthetic-thread', 'Synthetic prompt.').catch(error => error);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.requests.at(-1)?.method).toBe('turn/start');
    fixture.holdReads = true; const reading = reader.request('thread/read', { threadId: 'synthetic-other' }).catch(error => error);
    reader.dispose();
    expect(await turning).toMatchObject({ message: expect.stringContaining('closed') });
    expect(await reading).toMatchObject({ message: expect.stringContaining('closed') });
    expect(fixture.child.kill).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    reader.dispose(); expect(fixture.child.kill).toHaveBeenCalledOnce();
  });
  it('dispose before turn/start returns rejects startup and clears provisional waiter and RPC timers', async () => {
    fixture.mode = 'waiting-start'; const reader = client();
    const turning = reader.sendCuratorTurn('synthetic-thread', 'Synthetic prompt.').catch(error => error);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.requests.at(-1)?.method).toBe('turn/start');
    reader.dispose();
    expect(await turning).toMatchObject({ message: expect.stringContaining('closed') });
    expect(fixture.child.kill).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});
