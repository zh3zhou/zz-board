import { describe, expect, it } from 'vitest';
import { flushQueuedNotes, type QueuedNote } from '../../src/web/offlineStore.js';

function queue() {
  const items: QueuedNote[] = ['deleted-request', 'live-request'].map((id) => ({ id, tempNodeId: `offline-note:${id}`, createdAt: '2026-08-01', input: { clientRequestId: id, title: '', body: '合成内容', x: 0, y: 0, width: 180, height: 150 } }));
  return { items, async list() { return [...items]; }, async remove(id: string) { items.splice(items.findIndex((item) => item.id === id), 1); } };
}

describe('offline retries after permanent deletion', () => {
  it('consumes only terminal-deleted retries and continues syncing live notes', async () => {
    const storage = queue();
    const result = await flushQueuedNotes(async (input) => {
      if (input.clientRequestId === 'deleted-request') throw Object.assign(new Error('Permanently deleted'), { status: 410 });
      return {};
    }, storage);
    expect(result).toEqual({ sent: 1, discarded: 1, remaining: 0, blockedBy: undefined });
  });
  it('keeps retries on transient errors instead of discarding user input', async () => {
    const storage = queue();
    const result = await flushQueuedNotes(async () => { throw Object.assign(new Error('temporarily unavailable'), { status: 503 }); }, storage);
    expect(result).toMatchObject({ sent: 0, discarded: 0, remaining: 2 });
  });
  it('retains a tombstoned request when local queue removal itself fails', async () => {
    const storage = queue();
    const result = await flushQueuedNotes(async () => { throw { status: 410 }; }, { ...storage, async remove() { throw new Error('storage unavailable'); } });
    expect(result).toMatchObject({ sent: 0, discarded: 0, remaining: 2, blockedBy: 'storage unavailable' });
  });
});
