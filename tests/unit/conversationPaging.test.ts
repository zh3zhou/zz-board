import { describe, expect, it, vi } from 'vitest';
import type { ConversationColumn, ConversationTurn } from '../../src/shared/conversationHistory.js';
import { mergeEarlierConversationPage, readEarlierConversationPage } from '../../src/web/conversationPaging.js';

const turn = (id: string, ordinal: number): ConversationTurn => ({ turnId: id, ordinal, previousTurnId: null,
  continuesPrevious: false, title: id, summary: '合成讨论', occurredAt: null, sourceRefs: [id], reference: null,
  revision: 1, unread: false, sequence: ordinal, sourceFingerprint: id });
const column = (revision = 1, turns = [turn('b', 1)]): ConversationColumn => ({ threadKey: 'local:synthetic',
  title: '合成对话', sourceUpdatedAt: null, checkedAt: null, coverage: [], orderingRevision: revision,
  turns, hasEarlier: true, hasStoredEarlier: true, nextCursor: 'source-cursor' });

describe('stored conversation pagination races', () => {
  it('re-reads an old ordering response without duplicating or misordering turns', async () => {
    let current = column();
    const read = vi.fn(async () => {
      if (read.mock.calls.length === 1) { current = column(2, [turn('b', 4)]); return column(1, [turn('a', 0)]); }
      return column(2, [turn('a', 3)]);
    });
    const result = await readEarlierConversationPage(() => current, read, () => true);
    expect(read.mock.calls).toEqual([['b'], ['b']]); expect(result.status).toBe('loaded');
    if (result.status === 'loaded') expect(mergeEarlierConversationPage(current, result.page).turns.map(t => [t.turnId, t.ordinal])).toEqual([['a', 3], ['b', 4]]);
  });
  it('re-anchors if another page was committed while awaiting this page', async () => {
    let current = column(); const read = vi.fn(async () => {
      if (read.mock.calls.length === 1) current = column(1, [turn('a', 0), turn('b', 1)]);
      return column(1, [turn('earlier', -1)]);
    });
    expect((await readEarlierConversationPage(() => current, read, () => true)).status).toBe('loaded');
    expect(read.mock.calls).toEqual([['b'], ['a']]);
  });
  it('distinguishes stale from empty, so a rejected page cannot authorize a model request', async () => {
    const read = vi.fn(async () => column(1, []));
    expect(await readEarlierConversationPage(() => column(2), read, () => true)).toEqual({ status: 'stale' });
    expect(read).toHaveBeenCalledTimes(2);
    expect(await readEarlierConversationPage(() => column(), read, () => true)).toEqual({ status: 'empty' });
  });
  it('does not use pages after unmount or disconnection', async () => {
    let active = true;
    const read = vi.fn(async () => { active = false; return column(1, []); });
    expect(await readEarlierConversationPage(() => column(), read, () => active)).toEqual({ status: 'stale' });
    expect(await readEarlierConversationPage(() => column(), read, () => active)).toEqual({ status: 'stale' });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('refuses a page from a different source', async () => {
    await expect(readEarlierConversationPage(() => column(), async () => ({ ...column(), threadKey: 'other' }), () => true)).rejects.toThrow('source mismatch');
  });
  it('checks the ordering again at commit without changing current cursor or flags', () => {
    const current = column(3), stale = { ...column(2), hasEarlier: false, hasStoredEarlier: false, nextCursor: null };
    expect(mergeEarlierConversationPage(current, stale)).toBe(current);
    expect(mergeEarlierConversationPage(current, { ...column(3), threadKey: 'other' })).toBe(current);
  });
  it('preserves the newer existing content when a page repeats a turn', () => {
    const current = column(1, [{ ...turn('b', 1), revision: 3, summary: '已修订' }]);
    const merged = mergeEarlierConversationPage(current, { ...column(1, [turn('a', 0), turn('b', 1)]), hasStoredEarlier: false });
    expect(merged.turns.map(t => t.turnId)).toEqual(['a', 'b']); expect(merged.turns[1].summary).toBe('已修订');
    expect(merged.hasStoredEarlier).toBe(false);
  });
  it('rejects an old source cursor even when ordering revision has not changed', async () => {
    let current = column(2); const old = column(2, [turn('a', 0)]);
    const read = vi.fn(async () => { current = { ...current, hasEarlier: false, nextCursor: null }; return old; });
    expect(await readEarlierConversationPage(() => current, read, () => true)).toEqual({ status: 'stale' });
    expect(read).toHaveBeenCalledTimes(2); expect(mergeEarlierConversationPage(current, old)).toBe(current);
    const advanced = { ...column(2), nextCursor: 'advanced' };
    expect(mergeEarlierConversationPage(advanced, old)).toBe(advanced);
  });
});
