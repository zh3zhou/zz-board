import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { PassThrough } from 'node:stream';
const fixture = vi.hoisted(() => ({ child: null as unknown as ChildProcessWithoutNullStreams, children: [] as ChildProcessWithoutNullStreams[], calls: [] as unknown[][] }));
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: (...args: unknown[]) => {
    fixture.calls.push(args);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null, kill: vi.fn(() => { child.exitCode = 0; child.emit('exit', 0); return true; }) });
    fixture.child = child as unknown as ChildProcessWithoutNullStreams;
    fixture.children.push(fixture.child);
    return child;
  } };
});
import { RuntimeClient } from '../../src/server/codex/summaryRuntime.js';

describe('summary subprocess lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); fixture.calls = []; fixture.children = []; });
  afterEach(() => { for (const child of fixture.children) { child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); } vi.useRealTimers(); });
  const client = () => new RuntimeClient('synthetic-executable', '/synthetic', {}, {});
  const respond = (child: ChildProcessWithoutNullStreams, id: number, result: unknown) => (child.stdout as PassThrough).write(JSON.stringify({ id, result }) + '\n');
  it('allows a 20-second cold initialize instead of the former 15-second timeout', async () => {
    const runtime = client(); const connected = runtime.connect();
    await vi.advanceTimersByTimeAsync(20_000);
    (fixture.child.stdout as PassThrough).write(JSON.stringify({ id: 1, result: {} }) + '\n');
    await connected; expect(fixture.child.kill).not.toHaveBeenCalled();
    await runtime.dispose();
  });
  it('waits through split backfill diagnostics and preserves the reason on early exit', async () => {
    const runtime = client(); const result = runtime.connect().catch(e => e);
    (fixture.child.stderr as PassThrough).write('state db back'); (fixture.child.stderr as PassThrough).write('fill is running');
    expect(fixture.child.kill).not.toHaveBeenCalled();
    fixture.child.emit('exit', 1);
    expect((await result).code).toBe('runtime_busy'); await runtime.dispose();
  });
  it('cancels initialization immediately, before a thread or model request exists', async () => {
    const runtime = client(); const controller = new AbortController();
    const result = runtime.connect(controller.signal).catch(e => e); controller.abort();
    expect((await result).code).toBe('cancelled'); expect(fixture.child.kill).toHaveBeenCalledOnce();
    await expect(runtime.request('config/read', {})).rejects.toMatchObject({ code: 'cancelled' });
    await runtime.dispose();
  });
  it('does not spawn for already cancelled work', async () => {
    await expect(client().connect(AbortSignal.abort())).rejects.toThrow(); expect(fixture.calls).toHaveLength(0);
  });
  it('closes its pipes even if the child has exited, without closing a sibling runtime', async () => {
    const sibling = client(); const siblingConnected = sibling.connect(); const siblingChild = fixture.child;
    respond(siblingChild, 1, {}); await siblingConnected;
    const runtime = client(); const connected = runtime.connect(); const child = fixture.child;
    respond(child, 1, {}); await connected;
    Object.assign(child, { exitCode: 0 }); child.emit('exit', 0);
    try {
      await runtime.dispose(); await runtime.dispose();
      expect([child.stdin.destroyed, child.stdout.destroyed, child.stderr.destroyed]).toEqual([true, true, true]);
      expect([siblingChild.stdin.destroyed, siblingChild.stdout.destroyed, siblingChild.stderr.destroyed]).toEqual([false, false, false]);
      expect(child.kill).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    } finally { await sibling.dispose(); }
  });
  it('releases its pipes after the bounded wait if the killed child never reports exit', async () => {
    const runtime = client(); const connected = runtime.connect(); const child = fixture.child;
    respond(child, 1, {}); await connected;
    vi.mocked(child.kill).mockImplementation(() => true);
    const disposed = runtime.dispose(); await vi.advanceTimersByTimeAsync(3000); await disposed;
    expect([child.stdin.destroyed, child.stdout.destroyed, child.stderr.destroyed]).toEqual([true, true, true]);
    expect(child.kill).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('reports the initialize phase and disposes only its own process at the bounded deadline', async () => {
    const runtime = client(); const result = runtime.connect().catch(e => e);
    await vi.advanceTimersByTimeAsync(600_000);
    expect((await result).code).toBe('initialization_timeout'); await runtime.dispose();
    expect(fixture.child.kill).toHaveBeenCalledOnce();
  });
  it('contains an initialize stdin EPIPE, rejects all pending work, and kills only its own child', async () => {
    const sibling = client(); const siblingConnected = sibling.connect(); const siblingChild = fixture.child;
    respond(siblingChild, 1, {}); await siblingConnected;
    const runtime = client(); const connecting = runtime.connect().catch(error => error); const ownedChild = fixture.child;
    const pending = runtime.request('config/read', {}).catch(error => error);
    const pipeError = Object.assign(new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC write failed'), { code: 'EPIPE' });
    try {
      expect(() => ownedChild.stdin.emit('error', pipeError)).not.toThrow();
      expect(await connecting).toMatchObject({ code: 'runtime_unavailable' });
      expect(await pending).toMatchObject({ code: 'runtime_unavailable' });
      expect((await pending as Error).message).not.toContain('SYNTHETIC_PRIVATE_DIAGNOSTIC');
      expect(() => ownedChild.stdin.emit('error', pipeError)).not.toThrow();
      expect(ownedChild.kill).toHaveBeenCalledOnce(); expect(siblingChild.kill).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { await runtime.dispose(); await sibling.dispose(); }
  });
  it.each([false, true])('contains a turn stdin EPIPE and clears RPC, turn, and completion deadlines (completion received: %s)', async completionReceived => {
    const runtime = client(); const connected = runtime.connect(); const child = fixture.child;
    respond(child, 1, {}); await connected;
    const starting = runtime.start('synthetic-model', 'openai');
    respond(child, 2, { thread: { id: 'synthetic-thread', ephemeral: true, path: null }, model: 'synthetic-model' });
    await starting;
    const turning = runtime.turn('synthetic-thread', { model: 'synthetic-model', effort: 'medium', prompt: 'Synthetic evidence only.', outputSchema: {} }).catch(error => error);
    if (completionReceived) {
      respond(child, 3, { turn: { id: 'synthetic-turn' } });
      (child.stdout as PassThrough).write([
        { method: 'item/completed', params: { threadId: 'synthetic-thread', item: { type: 'agentMessage', text: '{"ok":true}' } } },
        { method: 'turn/completed', params: { threadId: 'synthetic-thread', turn: { id: 'synthetic-turn', status: 'completed' } } },
      ].map(message => JSON.stringify(message)).join('\n') + '\n');
    }
    const reading = runtime.request('config/read', {}).catch(error => error);
    const pipeError = Object.assign(new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC turn write failed'), { code: 'EPIPE' });
    try {
      expect(() => child.stdin.emit('error', pipeError)).not.toThrow();
      const error = await turning;
      expect(error).toMatchObject({ code: 'runtime_unavailable' }); expect(error.message).not.toContain('SYNTHETIC_PRIVATE_DIAGNOSTIC');
      expect(await reading).toMatchObject({ code: 'runtime_unavailable' });
      expect(() => child.stdin.emit('error', pipeError)).not.toThrow();
      expect(child.kill).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    } finally { await runtime.dispose(); }
  });
});
