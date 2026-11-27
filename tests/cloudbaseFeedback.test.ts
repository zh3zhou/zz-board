import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
vi.mock('postgres', () => ({ default: vi.fn() }));
import { createFeedbackHandler, processFeedback } from '../cloudbase/feedback/service.js';
import { createFeedbackRpc, type FeedbackRpc } from '../cloudbase/feedback/rpc.js';
import { cleanupFeedback, main as runCleanup } from '../cloudbase/feedback/cleanup.js';
import { FEEDBACK_RETENTION_MS, FEEDBACK_RETRY_MS, MAX_FEEDBACK_BYTES, type FeedbackSubmission } from '../src/shared/feedback.js';

const reportId = '0d0ddaae-163b-4b78-b928-dc8e9b81b71c';
const token = 'x'.repeat(43);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const report = (): FeedbackSubmission => {
  const now = Date.now();
  return { schemaVersion: 1, reportId, createdAt: new Date(now).toISOString(), retryUntil: new Date(now + FEEDBACK_RETRY_MS).toISOString(), kind: 'problem', goal: 'Synthetic goal', actual: 'Synthetic observation', expected: '', dataImpact: 'none', deleteTokenHash: hash(token) };
};
const receipt = () => { const now = Date.now(); return { schemaVersion: 1 as const, reportId, acceptedAt: new Date(now).toISOString(), retainedUntil: new Date(now + FEEDBACK_RETENTION_MS).toISOString() }; };
const servers: Server[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
async function endpoint(rpc: FeedbackRpc, enabled = true) {
  const server = createServer(createFeedbackHandler(rpc, enabled)); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing synthetic server address.');
  return `http://127.0.0.1:${address.port}`;
}

describe('independent feedback backend', () => {
  it('validates the shared strict contract before any RPC', async () => {
    const rpc = vi.fn();
    for (const value of [null, [], { action: 'unknown' }, { action: 'submit', ...report(), privateCanvas: 'must not be accepted' }, { action: 'submit', ...report(), diagnostics: { schemaVersion: 1, path: 'private-path' } }]) {
      expect((await processFeedback(value, rpc)).status).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
  it('returns only a bounded receipt for accepted and repeated reports', async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ status: 'accepted', receipt: receipt() }).mockResolvedValueOnce({ status: 'duplicate', receipt: receipt() });
    const request = { action: 'submit', ...report() };
    expect((await processFeedback(request, rpc)).status).toBe(201);
    expect((await processFeedback(request, rpc)).status).toBe(200);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_report_id: reportId, p_delete_token_hash: hash(token) });
    expect(rpc.mock.calls[0][1].p_payload_hash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('hashes withdrawal proof server-side and does not forward the raw token', async () => {
    const rpc = vi.fn().mockResolvedValue({ status: 'deleted' });
    const response = await processFeedback({ action: 'delete', schemaVersion: 1, reportId, deleteToken: token }, rpc);
    expect(response).toEqual({ status: 200, body: { schemaVersion: 1, reportId, deleted: true } });
    expect(rpc).toHaveBeenCalledWith('zzb_feedback_delete', { p_report_id: reportId, p_delete_token_hash: hash(token) });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(token);
  });
  it.each([['conflict', 409], ['expired', 410], ['forbidden', 403], ['rate_limited', 429], ['invalid', 400]] as const)('maps %s without exposing data', async (status, expected) => {
    const result = await processFeedback({ action: 'submit', ...report() }, vi.fn().mockResolvedValue({ status }));
    expect(result.status).toBe(expected); expect(Object.keys(result.body)).toEqual(['code']);
  });
  it('rejects wrong-report, extra-field, and wrong-action provider receipts', async () => {
    const request = { action: 'submit', ...report() };
    for (const result of [{ status: 'accepted', receipt: { ...receipt(), reportId: 'b65aaf4c-1dc0-45a3-baf6-6a241f63134c' } }, { status: 'accepted', receipt: { ...receipt(), secret: 'private' } }, { status: 'accepted' }]) expect((await processFeedback(request, vi.fn().mockResolvedValue(result))).status).toBe(503);
    expect((await processFeedback({ action: 'delete', schemaVersion: 1, reportId, deleteToken: token }, vi.fn().mockResolvedValue({ status: 'accepted', receipt: receipt() }))).status).toBe(503);
  });
  it('does not echo or log privacy canaries from headers, bodies, or provider errors', async () => {
    const canary = 'SYNTHETIC_PRIVATE_RUNTIME_CANARY';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {}); const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rpc = vi.fn().mockRejectedValue(new Error(canary));
    const base = await endpoint(rpc);
    const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cloudbase-context': canary, 'X-Forwarded-For': canary }, body: JSON.stringify({ action: 'submit', ...report(), contact: canary }) });
    expect(response.status).toBe(503); expect(await response.text()).not.toContain(canary);
    expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('x-cloudbase-context');
  });
  it('bounds the complete raw HTTP body at exactly 64 KiB including the action', async () => {
    const rpc = vi.fn().mockResolvedValue({ status: 'accepted', receipt: receipt() });
    const base = await endpoint(rpc);
    const body = JSON.stringify({ action: 'submit', ...report() });
    const atLimit = body + ' '.repeat(MAX_FEEDBACK_BYTES - Buffer.byteLength(body));
    expect(Buffer.byteLength(atLimit)).toBe(MAX_FEEDBACK_BYTES);
    expect((await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: atLimit })).status).toBe(201);
    expect((await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: atLimit + ' ' })).status).toBe(413);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it('pauses new collection while retaining validated withdrawal', async () => {
    const rpc = vi.fn(); const base = await endpoint(rpc);
    expect((await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(66_000) })).status).toBe(413);
    expect((await fetch(base, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
    const disabled = await endpoint(rpc, false);
    expect((await fetch(disabled, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'submit', ...report() }) })).status).toBe(503);
    expect(await (await fetch(disabled + '/health')).json()).toEqual({ ok: true }); expect(rpc).not.toHaveBeenCalled();
    rpc.mockResolvedValue({ status: 'deleted' });
    const withdrawal = await fetch(disabled, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', schemaVersion: 1, reportId, deleteToken: token }) });
    expect(withdrawal.status).toBe(200); expect(await withdrawal.json()).toEqual({ schemaVersion: 1, reportId, deleted: true });
    expect(rpc).toHaveBeenCalledWith('zzb_feedback_delete', { p_report_id: reportId, p_delete_token_hash: hash(token) });
    expect((await fetch(disabled, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', schemaVersion: 1, reportId, deleteToken: 'invalid' }) })).status).toBe(400);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe('private PostgreSQL feedback transport and cleanup', () => {
  const config = { ZZB_FEEDBACK_PG_HOST: '127.0.0.1', ZZB_FEEDBACK_PG_PORT: '5432',
    ZZB_FEEDBACK_PG_DATABASE: 'fixture', ZZB_FEEDBACK_PG_USER: 'fixture_intake', ZZB_FEEDBACK_PG_PASSWORD: 'synthetic-secret' };

  it('opens a verified private TLS connection and sends the withdrawal values as bound parameters', async () => {
    const query = vi.fn().mockResolvedValue([{result:{status:'deleted'}}]);
    vi.mocked(postgres).mockReturnValue(query as unknown as ReturnType<typeof postgres>);
    const rpc = createFeedbackRpc('intake', config);
    expect(await rpc('zzb_feedback_delete', { p_report_id:reportId, p_delete_token_hash:hash(token) })).toEqual({status:'deleted'});
    expect(postgres).toHaveBeenCalledWith(expect.objectContaining({host:'127.0.0.1', ssl:expect.objectContaining({rejectUnauthorized:true})}));
    expect(query.mock.calls[0][0].join('?')).toContain('zzb_feedback_private.zzb_feedback_delete(?::uuid');
    expect(query.mock.calls[0].slice(1)).toEqual([reportId, hash(token)]);
  });
  it('rejects the other function scope before connecting and never falls back to a service key', async () => {
    await expect(createFeedbackRpc('intake', config)('zzb_feedback_cleanup', {})).rejects.toThrow('scope');
    await expect(createFeedbackRpc('retention', config)('zzb_feedback_delete', {})).rejects.toThrow('scope');
    const legacy = {ZZB_FEEDBACK_ENV_ID:'fake',ZZB_FEEDBACK_API_KEY:'synthetic-key'};
    await expect(createFeedbackRpc('intake', legacy)('zzb_feedback_submit', {})).rejects.toThrow('Feedback database request failed');
    await expect(createFeedbackRpc('retention', {...config,ZZB_FEEDBACK_PG_HOST:'192.0.2.10'})('zzb_feedback_cleanup',{})).rejects.toThrow('Feedback database request failed');
  });
  it('does not expose raw driver errors or SQL arguments', async () => {
    const query = vi.fn().mockRejectedValue(new Error('sensitive-test-message'));
    vi.mocked(postgres).mockReturnValue(query as unknown as ReturnType<typeof postgres>);
    await expect(createFeedbackRpc('retention',config)('zzb_feedback_cleanup', {})).rejects.toThrow(/^Feedback database request failed\.$/);
  });
  it('cleanup exposes counts only', async () => {
    expect(await cleanupFeedback(vi.fn().mockResolvedValue({ reportsDeleted: 1, tombstonesDeleted: 2, countersDeleted: 3 }))).toEqual({ reportsDeleted: 1, tombstonesDeleted: 2, countersDeleted: 3 });
    await expect(cleanupFeedback(vi.fn().mockResolvedValue({ reportsDeleted: 1, tombstonesDeleted: 2, countersDeleted: 3, payload: 'private' }))).rejects.toThrow();
  });
  it('keeps scheduled retention cleanup running while collection is paused', async () => {
    vi.stubEnv('ZZB_FEEDBACK_ENABLED', 'false');
    for (const [key,value] of Object.entries(config)) vi.stubEnv(key,value);
    const counts = { reportsDeleted: 1, tombstonesDeleted: 2, countersDeleted: 3 };
    const query = vi.fn().mockResolvedValue([{result:counts}]);
    vi.mocked(postgres).mockReturnValue(query as unknown as ReturnType<typeof postgres>);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runCleanup()).toEqual(counts);
    expect(query).toHaveBeenCalledTimes(1); expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(counts));
  });
});
