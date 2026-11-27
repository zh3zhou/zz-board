import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FEEDBACK_RETENTION_MS, FEEDBACK_RETRY_MS } from '../../src/shared/feedback.js';
import type { FeedbackDiagnostics, FeedbackReceipt } from '../../src/shared/feedback.js';
import { createFeedbackTransport, deleteFeedback, deletionCredential, feedbackDraftText, feedbackPreview, prepareFeedback, readFeedbackDiagnostics, submitFeedback } from '../../src/web/feedbackClient.js';
import { changeFeedbackState, emptyFeedbackDraft } from '../../src/web/feedbackStore.js';
import type { FeedbackPersistence, FeedbackState } from '../../src/web/feedbackStore.js';

const fields = { kind: 'problem' as const, goal: '输入合成文字', actual: '末字未显示', expected: '文字完整', dataImpact: 'unknown' as const };
function memoryStore() {
  let state: FeedbackState = { draft: null, receipts: [] };
  const calls: string[] = [];
  const store: FeedbackPersistence = {
    load: async () => structuredClone(state),
    saveDraft: async draft => { state = changeFeedbackState(state, { kind: 'draft', draft }); },
    savePrepared: async draft => { calls.push('persist'); state = changeFeedbackState(state, { kind: 'prepare', draft }); },
    markUncertain: async reportId => { state = changeFeedbackState(state, { kind: 'uncertain', reportId }); },
    markReceived: async receipt => {
      state = changeFeedbackState(state, { kind: 'received', receipt });
      const status = state.receipts.find(record => record.reportId === receipt.reportId)?.state;
      if (status === 'received' || status === 'deleting' || status === 'deleted') return status;
      throw new Error('unexpected receipt state');
    },
    markDeleting: async reportId => { calls.push('deleting'); state = changeFeedbackState(state, { kind: 'deleting', reportId }); },
    markDeleted: async reportId => { state = changeFeedbackState(state, { kind: 'deleted', reportId }); },
    clearDeletedReceipts: async () => { state = changeFeedbackState(state, { kind: 'clear-deleted', now: Date.now() }); }
  };
  return { store, calls, state: () => state };
}
function receipt(reportId: string): FeedbackReceipt {
  const now = Date.now();
  return { schemaVersion: 1, reportId, acceptedAt: new Date(now).toISOString(), retainedUntil: new Date(now + FEEDBACK_RETENTION_MS).toISOString() };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('feedback preparation and transport', () => {
  it('creates an independent deletion secret before submission, hashes its text, and bounds retry to one day', async () => {
    const prepared = await prepareFeedback(fields);
    expect(prepared.deleteToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(prepared.submission.deleteTokenHash).toBe(createHash('sha256').update(prepared.deleteToken).digest('hex'));
    expect(Date.parse(prepared.submission.retryUntil) - Date.parse(prepared.submission.createdAt)).toBe(FEEDBACK_RETRY_MS);
    expect(prepared.submission).not.toHaveProperty('diagnostics');
    expect(JSON.stringify(prepared.submission)).not.toContain(prepared.deleteToken);
    expect((await prepareFeedback(fields)).deleteToken).not.toBe(prepared.deleteToken);
  });
  it('never leaks unselected extra source fields through a draft copy', () => {
    const text = feedbackDraftText({ ...fields, contact: 'optional contact', title: 'private-synthetic-title', path: 'private-path', deleteToken: 'private-token' } as typeof fields);
    expect(text).toContain('optional contact'); expect(text).not.toContain('private-'); expect(text).not.toContain('diagnostics');
  });
  it.each([false, true])('previews the exact frozen submission sent by transport, diagnostics selected: %s', async includeDiagnostics => {
    const diagnostics: FeedbackDiagnostics = { schemaVersion: 1, generatedAt: new Date().toISOString(), uiVersion: '0.10.6', service: { state: 'unavailable' } };
    const prepared = await prepareFeedback({ ...fields, contact: 'optional contact' }, includeDiagnostics ? diagnostics : undefined);
    const preview = feedbackPreview(prepared.submission), displayed = JSON.parse(preview), memory = memoryStore();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(receipt(prepared.submission.reportId))));
    await submitFeedback({ ...emptyFeedbackDraft(), fields, includeDiagnostics, prepared }, memory.store, createFeedbackTransport(fetcher));
    const sent = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(displayed).toStrictEqual(prepared.submission);
    expect(sent).toStrictEqual(displayed);
    expect(displayed).toMatchObject({ reportId: prepared.submission.reportId, createdAt: prepared.submission.createdAt, retryUntil: prepared.submission.retryUntil, deleteTokenHash: prepared.submission.deleteTokenHash });
    expect(preview).not.toContain(prepared.deleteToken); expect(displayed).not.toHaveProperty('deleteToken');
  });
  it('rejects diagnostics with private or unknown fields, then labels the local fallback unavailable', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), uiVersion: '0.10.6', service: { state: 'connected', version: '0.10.6' }, dataStoreId: 'private-sentinel' })));
    const result = await readFeedbackDiagnostics(fetcher);
    expect(result.unavailable).toBe(true); expect(result.diagnostics.service.state).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('private-sentinel'); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/feedback/diagnostics');
  });
  it('uses the local deliberate mutation header and never places content or tokens in a URL', async () => {
    const prepared = await prepareFeedback(fields);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(receipt(prepared.submission.reportId)))).mockResolvedValueOnce(new Response(JSON.stringify({ schemaVersion: 1, reportId: prepared.submission.reportId, deleted: true })));
    const transport = createFeedbackTransport(fetcher);
    await transport.submit(prepared.submission); await transport.remove(prepared.submission.reportId, prepared.deleteToken);
    for (const [url, options] of fetcher.mock.calls) {
      expect(String(url)).toMatch(/^\/api\/feedback\/(reports|delete)$/);
      expect(options?.headers).toEqual({ 'content-type': 'application/json', 'x-zz-board-mutation': '1' });
      expect(options?.method).toBe('POST');
    }
    expect(fetcher.mock.calls[0]?.[1]?.body).not.toContain(prepared.deleteToken);
    expect(fetcher.mock.calls[1]?.[1]?.body).toContain(prepared.deleteToken);
  });
  it('does not accept a wrong report id, malformed success, or unconfirmed deletion', async () => {
    const prepared = await prepareFeedback(fields);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(receipt(crypto.randomUUID())))).mockResolvedValueOnce(new Response('{}')).mockResolvedValueOnce(new Response('{}'));
    const transport = createFeedbackTransport(fetcher);
    await expect(transport.submit(prepared.submission)).rejects.toMatchObject({ code: 'uncertain' });
    await expect(transport.submit(prepared.submission)).rejects.toMatchObject({ code: 'uncertain' });
    await expect(transport.remove(prepared.submission.reportId, prepared.deleteToken)).rejects.toMatchObject({ code: 'uncertain' });
  });
  it('returns safe errors without reflecting an upstream body, path, or exception', async () => {
    const prepared = await prepareFeedback(fields);
    for (const status of [429, 503, 413, 410]) {
      const transport = createFeedbackTransport(vi.fn<typeof fetch>().mockResolvedValue(new Response('private-upstream-sentinel', { status })));
      await expect(transport.submit(prepared.submission)).rejects.not.toThrow('private-upstream-sentinel');
    }
    const transport = createFeedbackTransport(vi.fn<typeof fetch>().mockRejectedValue(new Error('private-secret-path')));
    await expect(transport.submit(prepared.submission)).rejects.toMatchObject({ code: 'uncertain' });
  });
  it.each(['feedback_timeout', 'invalid_receipt', 'feedback_unavailable'])('keeps 502 %s submission and deletion outcomes explicitly uncertain', async code => {
    const prepared = await prepareFeedback(fields), memory = memoryStore();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ code, error: 'private-upstream-sentinel' }), { status: 502 }));
    const transport = createFeedbackTransport(fetcher);
    const draft = { ...emptyFeedbackDraft(), fields, prepared };
    await expect(submitFeedback(draft, memory.store, transport)).rejects.toMatchObject({ code: 'uncertain', message: expect.stringContaining('结果未确认') });
    expect(memory.state().receipts[0]).toMatchObject({ state: 'uncertain', deleteToken: prepared.deleteToken });
    await expect(deleteFeedback(memory.state().receipts[0]!, memory.store, transport)).rejects.toMatchObject({ code: 'uncertain', message: expect.stringContaining('结果未确认') });
    expect(memory.state().receipts[0]).toMatchObject({ state: 'deleting', deleteToken: prepared.deleteToken });
    await expect(transport.submit(prepared.submission)).rejects.not.toThrow('private-upstream-sentinel');
  });
  it('only treats the allowlisted local unconfigured response as proof the current request was not forwarded', async () => {
    const prepared = await prepareFeedback(fields);
    for (const code of ['feedback_unavailable', 'feedback_rejected', 'unexpected-code']) {
      const transport = createFeedbackTransport(vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ code, error: 'private-upstream-sentinel' }), { status: 503 })));
      await expect(transport.submit(prepared.submission)).rejects.toMatchObject({ code: 'uncertain', message: expect.stringContaining('结果未确认') });
    }
    const transport = createFeedbackTransport(vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ code: 'feedback_unconfigured', error: 'private-upstream-sentinel' }), { status: 503 })));
    await expect(transport.submit(prepared.submission)).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('本次请求未转发') });
    await expect(transport.submit(prepared.submission)).rejects.not.toThrow('private-upstream-sentinel');
  });
  it('rejects empty or oversized text before preparing a request', async () => {
    await expect(prepareFeedback(emptyFeedbackDraft().fields)).rejects.toMatchObject({ code: 'invalid' });
    await expect(prepareFeedback({ ...fields, actual: 'x'.repeat(8001) })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('feedback durable submission and deletion', () => {
  it('persists the draft and capability before sending, then preserves the frozen request for a lost-ack retry', async () => {
    const prepared = await prepareFeedback(fields), draft = { ...emptyFeedbackDraft(), fields, prepared };
    const memory = memoryStore();
    const sent: string[] = [];
    const transport = { submit: vi.fn(async input => { memory.calls.push('network'); sent.push(JSON.stringify(input)); if (sent.length === 1) throw new Error('lost acknowledgement'); return receipt(input.reportId); }), remove: vi.fn() };
    await expect(submitFeedback(draft, memory.store, transport)).rejects.toThrow('lost acknowledgement');
    expect(memory.calls).toEqual(['persist', 'network']);
    expect(memory.state().receipts[0]).toMatchObject({ deleteToken: prepared.deleteToken, state: 'uncertain' });
    await expect(submitFeedback(draft, memory.store, transport)).resolves.toMatchObject({ state: 'received', receipt: { reportId: prepared.submission.reportId } });
    expect(sent[0]).toBe(sent[1]); expect(memory.state().draft).toBeNull(); expect(memory.state().receipts[0]?.state).toBe('received');
  });
  it('makes zero network calls when durable preparation fails or the retry deadline passed', async () => {
    const memory = memoryStore(), transport = { submit: vi.fn(), remove: vi.fn() };
    const prepared = await prepareFeedback(fields);
    memory.store.savePrepared = vi.fn().mockRejectedValue(new Error('storage unavailable'));
    await expect(submitFeedback({ ...emptyFeedbackDraft(), fields, prepared }, memory.store, transport)).rejects.toThrow('storage unavailable');
    const expired = await prepareFeedback(fields, undefined, new Date(Date.now() - FEEDBACK_RETRY_MS - 1));
    await expect(submitFeedback({ ...emptyFeedbackDraft(), fields, prepared: expired }, memory.store, transport)).rejects.toMatchObject({ code: 'expired' });
    expect(transport.submit).not.toHaveBeenCalled();
  });
  it('persists deletion intent and removes the pending draft before network; a failure permits only delete retry', async () => {
    const memory = memoryStore(), prepared = await prepareFeedback(fields), draft = { ...emptyFeedbackDraft(), fields, prepared };
    await memory.store.savePrepared(draft);
    const record = memory.state().receipts[0]!;
    const transport = { submit: vi.fn(), remove: vi.fn(async (): Promise<void> => { memory.calls.push('delete-network'); expect(memory.state().draft).toBeNull(); throw new Error('lost delete acknowledgement'); }) };
    await expect(deleteFeedback(record, memory.store, transport)).rejects.toThrow('lost delete acknowledgement');
    expect(memory.calls.slice(-2)).toEqual(['deleting', 'delete-network']);
    expect(memory.state().receipts[0]?.state).toBe('deleting');
    await expect(submitFeedback(draft, memory.store, transport)).rejects.toThrow('正在删除');
    expect(transport.submit).not.toHaveBeenCalled();
    transport.remove.mockResolvedValueOnce(undefined);
    await deleteFeedback(memory.state().receipts[0]!, memory.store, transport);
    expect(memory.state().receipts[0]?.state).toBe('deleted');
  });
  it.each(['deleting', 'deleted'] as const)('returns %s when a second client deletes before the first client receives its submission acknowledgement', async deletionState => {
    const memory = memoryStore(), submitClientStore = { ...memory.store }, deleteClientStore = { ...memory.store };
    const prepared = await prepareFeedback(fields), started = deferred<void>(), acknowledgement = deferred<FeedbackReceipt>();
    const submitting = submitFeedback({ ...emptyFeedbackDraft(), fields, prepared }, submitClientStore, {
      submit: async () => { started.resolve(undefined); return acknowledgement.promise; }, remove: vi.fn()
    });
    await started.promise;
    const record = (await deleteClientStore.load()).receipts[0]!;
    const deletion = deleteFeedback(record, deleteClientStore, {
      submit: vi.fn(), remove: async () => { if (deletionState === 'deleting') throw new Error('delete acknowledgement lost'); }
    });
    if (deletionState === 'deleting') await expect(deletion).rejects.toThrow('delete acknowledgement lost');
    else await deletion;
    expect((await deleteClientStore.load()).draft).toBeNull();
    const newerDraft = { ...emptyFeedbackDraft(), fields: { ...fields, actual: 'separate newer draft' } };
    await deleteClientStore.saveDraft(newerDraft);
    acknowledgement.resolve(receipt(prepared.submission.reportId));
    await expect(submitting).resolves.toStrictEqual({ state: deletionState });
    const final = await submitClientStore.load();
    expect(final.receipts[0]?.state).toBe(deletionState);
    expect(final.receipts[0]?.receipt).toBeUndefined();
    expect(final.draft).toStrictEqual(newerDraft);
  });
  it('exports a deletion credential without report text, contact or diagnostics', async () => {
    const memory = memoryStore(), prepared = await prepareFeedback(fields);
    await memory.store.savePrepared({ ...emptyFeedbackDraft(), fields, prepared });
    const exported = JSON.parse(deletionCredential(memory.state().receipts[0]!));
    expect(Object.keys(exported)).toEqual(['schemaVersion', 'reportId', 'deleteToken']);
    expect(exported.deleteToken).toBe(prepared.deleteToken);
  });
  it('does not send a stale draft after an eligible deleted receipt has been cleared', async () => {
    const memory = memoryStore(), prepared = await prepareFeedback(fields, undefined, new Date(Date.now() - FEEDBACK_RETRY_MS - 1));
    const draft = { ...emptyFeedbackDraft(), fields, prepared }, transport = { submit: vi.fn(), remove: vi.fn() };
    await memory.store.savePrepared(draft);
    await memory.store.markDeleted(prepared.submission.reportId);
    await memory.store.clearDeletedReceipts();
    expect(memory.state().receipts).toEqual([]);
    await expect(submitFeedback(draft, memory.store, transport)).rejects.toMatchObject({ code: 'expired' });
    expect(transport.submit).not.toHaveBeenCalled();
  });
});
