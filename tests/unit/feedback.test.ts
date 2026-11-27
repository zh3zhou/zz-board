import { describe, expect, it, vi } from 'vitest';
import { buildFeedbackDiagnostics, FeedbackTransport, parseFeedbackPublicConfig } from '../../src/server/feedback.js';
import { APP_VERSION } from '../../src/shared/version.js';
import { canonicalFeedback, feedbackDiagnosticsSchema, feedbackReceiptSchema, feedbackSubmissionSchema, FEEDBACK_RETENTION_MS, FEEDBACK_RETRY_MS } from '../../src/shared/feedback.js';

const id = 'bdc66a87-f05a-465b-9f83-c3bf9ed4d053';
const createdAt = new Date().toISOString();
const payload = { schemaVersion: 1 as const, reportId: id, createdAt, retryUntil: new Date(Date.parse(createdAt) + FEEDBACK_RETRY_MS).toISOString(), kind: 'problem' as const, goal: '', actual: 'Synthetic report', expected: '', dataImpact: 'none' as const, deleteTokenHash: 'a'.repeat(64) };
const receipt = { schemaVersion: 1, reportId: id, acceptedAt: createdAt, retainedUntil: new Date(Date.parse(createdAt) + FEEDBACK_RETENTION_MS).toISOString() };
const publicKey = `e30.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.synthetic`;
const config = { envId: 'synthetic-env', publishableKey: publicKey };

describe('feedback contracts and transport', () => {
  it('rejects unexpected fields, invalid retry windows and private diagnostic fields', () => {
    expect(feedbackSubmissionSchema.safeParse(payload).success).toBe(true);
    expect(feedbackSubmissionSchema.safeParse({ ...payload, url: 'https://attacker.invalid' }).success).toBe(false);
    expect(feedbackSubmissionSchema.safeParse({ ...payload, retryUntil: createdAt }).success).toBe(false);
    expect(feedbackDiagnosticsSchema.safeParse({ ...buildFeedbackDiagnostics(), dataStoreId: 'PRIVATE_CANARY' }).success).toBe(false);
    expect(feedbackReceiptSchema.safeParse({ ...receipt, retainedUntil: createdAt }).success).toBe(false);
  });
  it('projects runtime metadata without paths, credentials or file inventories', () => {
    const value = buildFeedbackDiagnostics({ appVersion: APP_VERSION, nodeVersion: 'v24.18.0', platform: 'win32', arch: 'x64', files: [{ path: 'PRIVATE_PATH_CANARY' }], token: 'PRIVATE_TOKEN_CANARY', dataStoreId: 'PRIVATE_STORE_CANARY' });
    const text = JSON.stringify(value);
    expect(value.runtime?.appVersion).toBe(APP_VERSION);
    expect(text).not.toContain('PRIVATE_');
    expect(value.runtime).not.toHaveProperty('files');
    expect(buildFeedbackDiagnostics({ appVersion: APP_VERSION, nodeVersion: 'v24.18.0', platform: 'win32', arch: 'x64' }).runtime?.fingerprint).toBe(value.runtime?.fingerprint);
  });
  it('canonicalizes object key order without changing whitespace in user content', () => {
    expect(canonicalFeedback({ b: 1, a: '  text\n' })).toBe(canonicalFeedback({ a: '  text\n', b: 1 }));
    expect(canonicalFeedback({ a: 'text' })).not.toBe(canonicalFeedback({ a: ' text ' }));
  });
  it('rejects service credentials and makes no request until explicitly submitted', async () => {
    const fetcher = vi.fn();
    const serviceKey = `e30.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.synthetic`;
    expect(parseFeedbackPublicConfig({ ...config, publishableKey: serviceKey })).toBeUndefined();
    const transport = new FeedbackTransport(undefined, fetcher);
    buildFeedbackDiagnostics(); expect(fetcher).not.toHaveBeenCalled();
    await expect(transport.submit(payload)).rejects.toMatchObject({ code: 'feedback_unconfigured' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses a fixed upstream, rejects redirecting responses, and validates the matching receipt', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: receipt }), { headers: { 'content-type': 'application/json' } }));
    const transport = new FeedbackTransport(config, fetcher);
    await expect(transport.submit(payload)).resolves.toEqual(receipt);
    expect(fetcher.mock.calls[0][0]).toBe('https://synthetic-env.api.tcloudbasegateway.com/v1/functions/zzb-feedback?webfn=true');
    expect(fetcher.mock.calls[0][1].redirect).toBe('error');
    fetcher.mockResolvedValue(new Response(JSON.stringify({ ...receipt, reportId: '871979e6-02f2-4a19-99f2-bc5cbf625eba' }), { headers: { 'content-type': 'application/json' } }));
    await expect(transport.submit(payload)).rejects.toMatchObject({ code: 'invalid_receipt' });
  });
  it('does not echo upstream bodies and releases its concurrent gate after failure', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('PRIVATE_UPSTREAM_CANARY', { status: 429 }));
    const transport = new FeedbackTransport(config, fetcher);
    await expect(transport.submit(payload)).rejects.toMatchObject({ status: 429, code: 'feedback_rejected' });
    fetcher.mockResolvedValue(new Response(JSON.stringify(receipt), { headers: { 'content-type': 'application/json' } }));
    await expect(transport.submit(payload)).resolves.toEqual(receipt);
  });
  it.each([409, 410, 413, 429])('preserves definite upstream rejection status %s', async status => {
    const transport = new FeedbackTransport(config, vi.fn().mockResolvedValue(new Response('PRIVATE_UPSTREAM_CANARY', { status })));
    await expect(transport.submit(payload)).rejects.toMatchObject({ status });
  });
  it.each([{ code: 'EXCEED_AUTHORITY' }, { ret: 1 }, { success: false }])('rejects platform failure even when a matching receipt is included (%j)', async platform => {
    const transport = new FeedbackTransport(config, vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...platform, result: receipt }), { headers: { 'content-type': 'application/json' } })));
    await expect(transport.submit(payload)).rejects.toMatchObject({ status: 502, code: 'invalid_receipt' });
  });
  it('keeps uncertain upstream outcomes uncertain and bounds its timeout', async () => {
    const failed = new FeedbackTransport(config, vi.fn().mockResolvedValue(new Response('PRIVATE', { status: 500 })));
    await expect(failed.submit(payload)).rejects.toMatchObject({ status: 502 });
    const fetcher = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('PRIVATE')))));
    const pending = new FeedbackTransport(config, fetcher as typeof fetch, 10);
    const first = pending.submit(payload);
    await expect(pending.submit(payload)).rejects.toMatchObject({ status: 429, code: 'feedback_busy' });
    await expect(first).rejects.toMatchObject({ status: 502, code: 'feedback_timeout' });
    await expect(pending.submit(payload)).rejects.toMatchObject({ code: 'feedback_timeout' });
  });
  it('rejects oversized and non-JSON acknowledgements without reflecting their contents', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('PRIVATE'.repeat(10_000), { headers: { 'content-type': 'application/json' } }));
    const transport = new FeedbackTransport(config, fetcher);
    await expect(transport.submit(payload)).rejects.toMatchObject({ code: 'invalid_receipt' });
    fetcher.mockResolvedValue(new Response('PRIVATE'));
    await expect(transport.submit(payload)).rejects.toMatchObject({ code: 'invalid_receipt' });
  });
});
