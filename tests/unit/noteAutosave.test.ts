import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoteAutosave, noteRequestNodeId } from '../../src/web/noteAutosave.js';
import type { CanvasNodeRecord } from '../../src/shared/schema.js';

const record: CanvasNodeRecord = { id: 'note:a', kind: 'note', threadKey: null, title: '', body: 'old', x: 0, y: 0, width: 220, height: 150, zIndex: 1, revision: 0, createdAt: '', updatedAt: '', lastViewedAt: null };
function setup() {
  let server = { ...record };
  const dependencies = {
    create: vi.fn(async (input: { body: string }) => server = { ...server, body: input.body }),
    update: vi.fn(async (_id: string, input: Record<string, unknown>) => {
      if (input.revision !== server.revision) throw { status: 409 };
      return server = { ...server, body: String(input.body), revision: server.revision + 1 };
    }),
    persist: vi.fn(async () => {}), changed: vi.fn(), accepted: vi.fn(), online: () => true, storageError: vi.fn()
  };
  return { saver: new NoteAutosave(dependencies), dependencies };
}
afterEach(() => vi.useRealTimers());

describe('per-note autosave', () => {
  it('acknowledges a lost save response when the conflict record already has exactly our text', async () => {
    const { saver, dependencies } = setup();
    dependencies.update.mockRejectedValueOnce(new TypeError('response lost'))
      .mockRejectedValueOnce({ status: 409, current: { ...record, body: 'local', revision: 1, x: 80 } });
    saver.edit(record, 'local');
    expect(await saver.flush(record.id)).toBe(false);
    expect(await saver.flush(record.id)).toBe(true);
    expect(saver.dirty(record.id)).toBe(false);
    expect(dependencies.update).toHaveBeenCalledTimes(2);
    expect(saver.entries.get(record.id)?.record.x).toBe(80);
    expect(dependencies.persist).toHaveBeenLastCalledWith([]);
  });
  it('acknowledges a recovered draft already present remotely without another write', async () => {
    const { saver, dependencies } = setup();
    saver.restore([{ record, body: 'local', sequence: 1, savedSequence: 0, sessionId: 's', status: 'conflict' }]);
    saver.reconcile([{ ...record, revision: 1, body: 'local' }]);
    expect(saver.dirty(record.id)).toBe(false);
    expect(await saver.flushAll()).toEqual([true]);
    expect(dependencies.update).not.toHaveBeenCalled();
  });
  it('does not write unchanged text or reverted input, which would clear redo', async () => {
    const { saver, dependencies } = setup();
    saver.edit(record, record.body);
    expect(await saver.flush(record.id)).toBe(true);
    saver.edit(record, 'temporary'); saver.edit(record, record.body);
    expect(await saver.flush(record.id)).toBe(true);
    expect(dependencies.update).not.toHaveBeenCalled();
    expect(saver.dirty(record.id)).toBe(false);
  });
  it('finishes a blurred editor with its final DOM text even if compositionend was lost', async () => {
    const { saver, dependencies } = setup();
    saver.edit(record, '中文组'); saver.composition(record.id, true);
    expect(await saver.flushAll()).toEqual([false]);
    expect(await saver.finishEditing(record.id, '中文组字完成')).toBe(true);
    expect(saver.isComposing(record.id)).toBe(false);
    expect(dependencies.update.mock.calls[0][1].body).toBe('中文组字完成');
    expect(await saver.flushAll()).toEqual([true]);
  });
  it('waits for an in-flight write before treating a revert as unchanged', async () => {
    const { saver, dependencies } = setup();
    let release!: () => void;
    dependencies.update.mockImplementationOnce(async () => { await new Promise<void>(resolve => release = resolve); return { ...record, body: 'first', revision: 1 }; })
      .mockResolvedValueOnce({ ...record, body: record.body, revision: 2 });
    saver.edit(record, 'first'); const saving = saver.flush(record.id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    saver.edit(record, record.body); release(); await saving;
    expect(dependencies.update).toHaveBeenCalledTimes(2);
    expect(saver.entries.get(record.id)?.record.body).toBe(record.body);
  });
  it('does not acknowledge equal text from a wrong or archived record', async () => {
    for (const remote of [{ ...record, id: 'note:other', body: 'local', revision: 1 }, { ...record, body: 'local', revision: 1, archivedAt: '2026-09-21T08:00:00Z' }]) {
      const { saver, dependencies } = setup();
      dependencies.update.mockRejectedValue({ status: 409, current: remote });
      saver.edit(record, 'local'); expect(await saver.flush(record.id)).toBe(false);
      saver.reconcile([remote]); expect(saver.dirty(record.id)).toBe(true);
    }
  });
  it('never treats a failed acknowledgement of an older body as saving later text', async () => {
    const { saver, dependencies } = setup(); let release!: () => void;
    dependencies.update.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => release = resolve);
      throw { status: 409, current: { ...record, body: 'first', revision: 1 } };
    }).mockResolvedValueOnce({ ...record, body: 'second', revision: 2 });
    saver.edit(record, 'first'); const saving = saver.flush(record.id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    saver.edit(record, 'second'); release(); await saving;
    expect(dependencies.update.mock.calls[1][1]).toMatchObject({ body: 'second', revision: 1 });
    expect(saver.entries.get(record.id)?.record.body).toBe('second');
  });
  it('retries a layout-only revision conflict without overwriting the new layout', async () => {
    const { saver, dependencies } = setup();
    const moved = { ...record, x: 200, revision: 1 };
    dependencies.update.mockRejectedValueOnce({ status: 409, current: moved })
      .mockResolvedValueOnce({ ...moved, body: 'local', revision: 2 });
    saver.edit(record, 'local');
    expect(await saver.flush(record.id)).toBe(true);
    expect(dependencies.update.mock.calls[1][1]).toMatchObject({ body: 'local', revision: 1 });
    expect(dependencies.update.mock.calls[1][1]).not.toHaveProperty('x');
    expect(saver.entries.get(record.id)?.record.x).toBe(200);
  });
  it('does not block global history for a clean note left in composition state', async () => {
    const { saver } = setup(); saver.edit(record, 'saved'); await saver.flush(record.id);
    saver.composition(record.id, true);
    expect(await saver.flushAll()).toEqual([true]);
  });
  it('rejects changed text, archived nodes and wrong ids instead of auto-rebasing', async () => {
    for (const remote of [{ ...record, body: 'remote', revision: 1 }, { ...record, archivedAt: '2026-09-08', revision: 1 }, { ...record, id: 'note:other', revision: 1 }]) {
      const { saver, dependencies } = setup();
      dependencies.update.mockRejectedValue({ status: 409, current: remote }); saver.edit(record, 'local');
      expect(await saver.flush(record.id)).toBe(false); expect(dependencies.update).toHaveBeenCalledTimes(1);
      expect(saver.overlay(remote).body).toBe(remote.id === record.id ? 'local' : remote.body);
    }
  });
  it('bounds layout-conflict retry to one attempt and preserves unsaved text', async () => {
    const { saver, dependencies } = setup();
    dependencies.update.mockRejectedValue({ status: 409, current: { ...record, revision: 1 } });
    saver.edit(record, 'local'); expect(await saver.flush(record.id)).toBe(false);
    expect(dependencies.update).toHaveBeenCalledTimes(2); expect(saver.dirty(record.id)).toBe(true);
  });
  it('reconciles a recovered metadata-only conflict but never a competing body', async () => {
    const { saver, dependencies } = setup();
    saver.restore([{ record, body: 'local', sequence: 1, savedSequence: 0, sessionId: 's', status: 'conflict' }]);
    saver.reconcile([{ ...record, revision: 1, body: 'other' }]);
    expect(saver.entries.get(record.id)?.status).toBe('conflict');
    saver.reconcile([{ ...record, revision: 2, x: 30 }]);
    expect(saver.entries.get(record.id)?.status).toBe('pending');
    dependencies.update.mockResolvedValue({ ...record, revision: 3, x: 30, body: 'local' });
    expect(await saver.flush(record.id)).toBe(true);
  });
  it('waits 600ms, preserves whitespace and pauses during composition', async () => {
    vi.useFakeTimers(); const { saver, dependencies } = setup();
    saver.edit(record, '  中文\n'); saver.composition(record.id, true);
    await vi.advanceTimersByTimeAsync(900); expect(dependencies.update).not.toHaveBeenCalled();
    saver.composition(record.id, false);
    await vi.advanceTimersByTimeAsync(599); expect(dependencies.update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(dependencies.update.mock.calls[0][1].body).toBe('  中文\n');
    expect(saver.dirty(record.id)).toBe(false);
  });
  it('creates empty notes and uses deterministic idempotency keys', async () => {
    const { saver, dependencies } = setup();
    saver.edit({ ...record, body: '' }, '', 'request-a'); await saver.finish(record.id);
    expect(dependencies.create).toHaveBeenCalledWith(expect.objectContaining({ body: '', clientRequestId: 'request-a' }));
    expect(dependencies.create.mock.calls[0][0]).not.toHaveProperty('revision');
    expect(await noteRequestNodeId('request-a')).toMatch(/^note:request:[a-f0-9]{32}$/);
    expect(await noteRequestNodeId('request-a')).toBe(await noteRequestNodeId('request-a'));
  });
  it('serializes edits arriving during acknowledgement without losing the latest body', async () => {
    const { saver, dependencies } = setup();
    let release!: () => void;
    dependencies.update.mockImplementationOnce(async () => { await new Promise<void>((resolve) => release = resolve); return { ...record, body: 'first', revision: 0 }; });
    saver.edit(record, 'first'); const saving = saver.flush(record.id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    saver.edit(record, 'second'); release(); await saving;
    expect(dependencies.update).toHaveBeenCalledTimes(2);
    expect(dependencies.update.mock.calls[1][1].body).toBe('second');
    expect(saver.entries.get(record.id)?.record.body).toBe('second');
  });
  it('keeps conflict text over remote refresh and never retries by silently rebasing', async () => {
    const { saver, dependencies } = setup();
    dependencies.update.mockRejectedValue({ status: 409 }); saver.edit(record, 'local');
    expect(await saver.finish(record.id)).toBe(false);
    expect(saver.overlay({ ...record, body: 'remote', revision: 3 }).body).toBe('local');
    await saver.flush(record.id); expect(dependencies.update).toHaveBeenCalledTimes(1);
    expect(dependencies.persist).toHaveBeenCalled();
  });
  it('recovers canonical revision after idempotent create then a failed patch', async () => {
    const { saver, dependencies } = setup();
    dependencies.create.mockResolvedValue({ ...record, body: 'older', revision: 4 });
    dependencies.update.mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce({ ...record, body: 'latest', revision: 5 });
    saver.edit(record, 'latest', 'request'); await saver.flush(record.id); await saver.flush(record.id);
    expect(dependencies.create).toHaveBeenCalledTimes(1);
    expect(dependencies.update.mock.calls[1][1].revision).toBe(4);
  });
  it('saves independent nodes by id, and restores unsaved drafts without a second database', async () => {
    const { saver, dependencies } = setup();
    saver.restore([{ record, body: 'recovered', sequence: 2, savedSequence: 1, sessionId: 'session', status: 'pending' }]);
    expect(saver.overlay(record).body).toBe('recovered'); await saver.flushAll();
    expect(dependencies.update.mock.calls[0][0]).toBe(record.id);
    expect(dependencies.persist).toHaveBeenLastCalledWith([]);
  });
});
