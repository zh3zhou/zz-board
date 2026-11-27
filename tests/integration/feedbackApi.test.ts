import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { loadConfig } from '../../src/server/config.js';
import { BoardDatabase } from '../../src/server/database.js';
import { FeedbackTransport } from '../../src/server/feedback.js';
import { FEEDBACK_RETRY_MS } from '../../src/shared/feedback.js';

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });
async function start(config?: { envId: string; publishableKey: string }) {
  fs.mkdirSync(path.resolve('.tmp'), { recursive: true });
  const dataDir = fs.mkdtempSync(path.resolve('.tmp/feedback-api-'));
  const fetcher = vi.fn();
  const db = new BoardDatabase(':memory:');
  app = await buildApp({ ...loadConfig({ ZZ_BOARD_DATA_DIR: dataDir }), databasePath: ':memory:' }, { db, feedback: new FeedbackTransport(config, fetcher) });
  return { fetcher, db };
}
describe('local feedback privacy boundary', () => {
  it.each([false, true])('exposes only the local private transport configuration flag (%s)', async configured => {
    const { fetcher } = await start(configured ? { envId: 'synthetic-env', publishableKey: `header.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.signature` } : undefined);
    const response = await app!.inject('/api/feedback/status');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ privateSubmissionConfigured: configured });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps diagnostics independent of board content and makes no remote request', async () => {
    const { fetcher } = await start();
    const response = await app!.inject('/api/feedback/diagnostics');
    expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).not.toHaveProperty('dataStoreId');
    expect(response.json()).not.toHaveProperty('publicFeedback');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires explicit same-origin writes and safely retains unconfigured reports', async () => {
    const { fetcher, db } = await start();
    const createdAt = new Date().toISOString();
    const payload = { schemaVersion: 1, reportId: 'ddcac3d6-a20f-4058-89ed-fdb080fe7a76', createdAt, retryUntil: new Date(Date.parse(createdAt) + FEEDBACK_RETRY_MS).toISOString(), kind: 'idea', goal: '', actual: 'Private user input canary', expected: '', dataImpact: 'none', deleteTokenHash: 'a'.repeat(64) };
    expect((await app!.inject({ method: 'POST', url: '/api/feedback/reports', payload })).statusCode).toBe(403);
    expect((await app!.inject({ method: 'POST', url: '/api/feedback/reports', headers: { 'x-zz-board-mutation': '1', origin: 'https://attacker.invalid' }, payload })).statusCode).toBe(403);
    const response = await app!.inject({ method: 'POST', url: '/api/feedback/reports', headers: { 'x-zz-board-mutation': '1' }, payload });
    expect(response.statusCode).toBe(503); expect(response.json().code).toBe('feedback_unconfigured');
    expect(response.body).not.toContain('canary'); expect(db.getBoard().nodes).toHaveLength(0); expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not echo malformed input from the global error handler', async () => {
    await start();
    const response = await app!.inject({ method: 'POST', url: '/api/feedback/reports', headers: { 'x-zz-board-mutation': '1', 'content-type': 'application/json' }, payload: '{PRIVATE_PARSE_CANARY' });
    expect(response.statusCode).toBe(400); expect(response.body).not.toContain('PRIVATE_PARSE_CANARY');
  });
});
