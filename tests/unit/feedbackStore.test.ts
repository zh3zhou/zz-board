import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_RETENTION_MS, FEEDBACK_RETRY_MS } from '../../src/shared/feedback.js';
import { prepareFeedback } from '../../src/web/feedbackClient.js';
import { changeFeedbackState, emptyFeedbackDraft, feedbackStore, parseFeedbackState } from '../../src/web/feedbackStore.js';
import type { FeedbackState } from '../../src/web/feedbackStore.js';

const fields = { ...emptyFeedbackDraft().fields, actual: 'synthetic issue' };
afterEach(() => vi.unstubAllGlobals());

describe('feedback local state', () => {
  it('keeps blank offline drafts separate from the board and note outbox', () => {
    const empty = parseFeedbackState(undefined);
    const next = changeFeedbackState(empty, { kind: 'draft', draft: emptyFeedbackDraft() });
    expect(next.draft?.fields.actual).toBe(''); expect(next.receipts).toEqual([]); expect(empty.draft).toBeNull();
    expect(() => parseFeedbackState({ ...next, board: {} })).toThrow();
  });
  it('preserves an earlier capability when the user edits and prepares a different report', async () => {
    const first = await prepareFeedback(fields), second = await prepareFeedback({ ...fields, actual: 'corrected report' });
    let state = changeFeedbackState(parseFeedbackState(undefined), { kind: 'prepare', draft: { ...emptyFeedbackDraft(), fields, prepared: first } });
    state = changeFeedbackState(state, { kind: 'draft', draft: { ...emptyFeedbackDraft(), fields } });
    state = changeFeedbackState(state, { kind: 'prepare', draft: { ...emptyFeedbackDraft(), fields, prepared: second } });
    expect(state.receipts.map(record => record.deleteToken)).toEqual([first.deleteToken, second.deleteToken]);
    expect(state.draft?.prepared?.submission.reportId).toBe(second.submission.reportId);
  });
  it('does not let a delayed acknowledgement resurrect a deleted report or clear a newer draft', async () => {
    const prepared = await prepareFeedback(fields);
    let state = changeFeedbackState(parseFeedbackState(undefined), { kind: 'prepare', draft: { ...emptyFeedbackDraft(), fields, prepared } });
    state = changeFeedbackState(state, { kind: 'deleting', reportId: prepared.submission.reportId });
    state = changeFeedbackState(state, { kind: 'deleted', reportId: prepared.submission.reportId });
    state = changeFeedbackState(state, { kind: 'draft', draft: { ...emptyFeedbackDraft(), fields: { ...fields, actual: 'newer draft' } } });
    const now = Date.now();
    state = changeFeedbackState(state, { kind: 'received', receipt: { schemaVersion: 1, reportId: prepared.submission.reportId, acceptedAt: new Date(now).toISOString(), retainedUntil: new Date(now + FEEDBACK_RETENTION_MS).toISOString() } });
    expect(state.receipts[0]?.state).toBe('deleted'); expect(state.draft?.fields.actual).toBe('newer draft');
    expect(() => changeFeedbackState(state, { kind: 'prepare', draft: { ...emptyFeedbackDraft(), fields, prepared } })).toThrow();
  });
  it('does not manufacture a capability when local state is missing or corrupt', () => {
    expect(() => changeFeedbackState(parseFeedbackState(undefined), { kind: 'deleting', reportId: crypto.randomUUID() })).toThrow();
    expect(() => parseFeedbackState({ draft: null, receipts: [{ reportId: 'bad' }] })).toThrow();
  });
  it('preserves more than 200 receipts and can still prepare another report without evicting credentials', async () => {
    const prepared = await prepareFeedback(fields);
    const receipts = Array.from({ length: 205 }, (_, index) => ({ schemaVersion: 1 as const, reportId: crypto.randomUUID(), deleteToken: String(index).padStart(43, 'x'), createdAt: prepared.submission.createdAt, state: 'uncertain' as const }));
    const state = changeFeedbackState({ draft: null, receipts }, { kind: 'prepare', draft: { ...emptyFeedbackDraft(), fields, prepared } });
    expect(state.receipts).toHaveLength(206);
    expect(state.receipts.slice(0, 205)).toEqual(receipts);
    expect(state.draft?.prepared?.submission.reportId).toBe(prepared.submission.reportId);
    expect(parseFeedbackState(state).receipts).toHaveLength(206);
  });
  it('only clears confirmed deletion receipts after their original retry deadline', async () => {
    const now = Date.now(), oldCreatedAt = new Date(now - FEEDBACK_RETENTION_MS - FEEDBACK_RETRY_MS).toISOString();
    const records = (['prepared', 'uncertain', 'received', 'deleting', 'deleted'] as const).map(state => ({ schemaVersion: 1 as const, reportId: crypto.randomUUID(), deleteToken: 'x'.repeat(43), createdAt: oldCreatedAt, state }));
    const recentDeleted = { ...records[4]!, reportId: crypto.randomUUID(), createdAt: new Date(now - FEEDBACK_RETRY_MS + 1).toISOString() };
    const draft = { ...emptyFeedbackDraft(), fields };
    const cleaned = changeFeedbackState({ draft, receipts: [...records, recentDeleted] }, { kind: 'clear-deleted', now });
    expect(cleaned.receipts).toEqual([...records.slice(0, 4), recentDeleted]);
    expect(cleaned.draft).toEqual(draft);
    const afterDeadline = changeFeedbackState(cleaned, { kind: 'clear-deleted', now: now + 1 });
    expect(afterDeadline.receipts).toEqual(records.slice(0, 4));
  });
});

/** Small controllable IndexedDB boundary: request success is deliberately earlier than durable commit. */
function idbBoundary(initial?: FeedbackState) {
  let current = initial, staged: FeedbackState | undefined, tx: any;
  const close = vi.fn();
  const database = { close, onversionchange: null, transaction: vi.fn(() => {
    const objectStore = {
      get: () => { const request: any = { result: current }; queueMicrotask(() => request.onsuccess()); return request; },
      put: (value: FeedbackState) => { staged = structuredClone(value); return {}; }
    };
    tx = { objectStore: () => objectStore, abort: () => queueMicrotask(() => tx.onabort()) };
    return tx;
  }) };
  const open = vi.fn(() => { const request: any = { result: database }; queueMicrotask(() => request.onsuccess()); return request; });
  vi.stubGlobal('indexedDB', { open });
  return { open, close, saved: () => current, commit: () => { current = staged; tx.oncomplete(); }, abort: () => tx.onabort() };
}

describe('feedback IndexedDB durability boundary', () => {
  it('opens its own database and resolves only after the draft and receipt transaction commits', async () => {
    const prepared = await prepareFeedback(fields), harness = idbBoundary();
    let complete = false;
    const operation = feedbackStore.savePrepared({ ...emptyFeedbackDraft(), fields, prepared }).then(() => { complete = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(harness.open).toHaveBeenCalledWith('zz-board-feedback', 1);
    expect(complete).toBe(false); expect(harness.saved()).toBeUndefined();
    harness.commit(); await operation;
    expect(harness.saved()?.draft?.prepared?.deleteToken).toBe(prepared.deleteToken);
    expect(harness.saved()?.receipts[0]?.deleteToken).toBe(prepared.deleteToken);
    expect(harness.close).toHaveBeenCalledOnce();
  });
  it('rejects an aborted transaction even after its write request succeeded', async () => {
    const prepared = await prepareFeedback(fields), harness = idbBoundary();
    const operation = feedbackStore.savePrepared({ ...emptyFeedbackDraft(), fields, prepared });
    const rejected = expect(operation).rejects.toThrow('未能保存');
    await new Promise(resolve => setImmediate(resolve));
    harness.abort(); await rejected;
    expect(harness.saved()).toBeUndefined(); expect(harness.close).toHaveBeenCalledOnce();
  });
  it.each(['received', 'deleting', 'deleted'] as const)('returns the committed %s state when applying a submission acknowledgement', async expectedState => {
    const prepared = await prepareFeedback(fields), now = Date.now();
    const initial: FeedbackState = { draft: null, receipts: [{ schemaVersion: 1, reportId: prepared.submission.reportId, deleteToken: prepared.deleteToken, createdAt: prepared.submission.createdAt, state: expectedState === 'received' ? 'uncertain' : expectedState }] };
    const harness = idbBoundary(initial);
    let complete = false;
    const operation = feedbackStore.markReceived({ schemaVersion: 1, reportId: prepared.submission.reportId, acceptedAt: new Date(now).toISOString(), retainedUntil: new Date(now + FEEDBACK_RETENTION_MS).toISOString() }).then(result => { complete = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    expect(complete).toBe(false);
    harness.commit();
    await expect(operation).resolves.toBe(expectedState);
    expect(harness.saved()?.receipts[0]?.state).toBe(expectedState);
  });
});
