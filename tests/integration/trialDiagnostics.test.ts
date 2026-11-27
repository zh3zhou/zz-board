import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { loadConfig } from '../../src/server/config.js';
import { TrialDiagnostics } from '../../src/server/trialDiagnostics.js';
import { trialEventSchema } from '../../src/shared/trialDiagnostics.js';
import type { SyncJob } from '../../src/shared/summarySync.js';

const secret = 'synthetic-task-token.E:\\sandbox-only\\exception:https://example.invalid';
const mutates = { 'x-zz-board-mutation': '1' };
let app: FastifyInstance | undefined;
let directory: string | undefined;

function sandbox() {
  fs.mkdirSync(path.resolve('.tmp'), { recursive: true });
  directory = fs.mkdtempSync(path.resolve('.tmp/trial-api-'));
  return directory;
}
async function start(dataDir: string, trialDiagnostics?: boolean) {
  app = await buildApp({ ...loadConfig({ ZZ_BOARD_DATA_DIR: dataDir }), trialDiagnostics, databasePath: ':memory:' });
  await app.ready();
  return app;
}
function load(directory: string, layer: 'server' | 'web') {
  return fs.readFileSync(path.join(directory, 'logs', 'trial', layer + '.jsonl'), 'utf8');
}
afterEach(async () => {
  await app?.close();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  app = undefined;
  directory = undefined;
});

describe('packaged trial event diagnostics', () => {
  it('collects allowed metadata and rejects missing mutation headers, cross-origin writes and payload fields', async () => {
    const dataDir = sandbox();
    const app = await start(dataDir, true);
    const send = (headers: Record<string, string>, extra?: { raw: string }) =>
      app.inject({ method: 'POST', url: '/api/trial/diagnostics/events',
        headers, payload: { event: 'feedback_copy', outcome: 'ok', ...extra } });
    expect((await send({})).statusCode).toBe(403);
    expect((await send({ ...mutates, origin: 'https://example.invalid' })).statusCode).toBe(403);
    expect((await send(mutates, { raw: secret })).statusCode).toBe(400);
    expect((await send(mutates)).statusCode).toBe(204);
    const response = await app.inject({ method: 'PATCH', url: '/api/nodes/private-test-id?query=private-query', headers: mutates,
      payload: { title: secret, body: secret, revision: 1 } });
    expect(response.statusCode).toBe(404);
    const health = await app.inject('/api/health');
    expect(health.json().trialDiagnostics).toBe('active');
    const web = load(dataDir, 'web');
    const server = load(dataDir, 'server');
    expect(web.trim().split('\n').map(value => trialEventSchema.parse(JSON.parse(value))))
      .toEqual([expect.objectContaining({ event: 'feedback_copy', outcome: 'ok', layer: 'web' })]);
    expect(server.trim().split('\n').map(value => trialEventSchema.parse(JSON.parse(value))))
      .toContainEqual(expect.objectContaining({ route: 'notes', event: 'api', status: 404 }));
    for (const privateText of [secret, 'private-test-id', 'private-query', 'example.invalid', '/api/nodes']) {
      expect(server + web).not.toContain(privateText);
    }
  });

  it('keeps the diagnostics endpoint and files absent on the normal application', async () => {
    const dataDir = sandbox();
    const app = await start(dataDir);
    expect((await app.inject('/api/health')).json()).not.toHaveProperty('trialDiagnostics');
    expect((await app.inject({ method: 'POST', url: '/api/trial/diagnostics/events', headers: mutates,
      payload: { event: 'window_loaded', outcome: 'ok' } })).statusCode).toBe(404);
    expect(fs.existsSync(path.join(dataDir, 'logs/trial'))).toBe(false);
  });

  it('reports a local write failure and continues serving the board', async () => {
    const dataDir = sandbox();
    fs.mkdirSync(path.join(dataDir, 'logs'));
    fs.writeFileSync(path.join(dataDir, 'logs/trial'), 'synthetic path failure');
    const app = await start(dataDir, true);
    expect((await app.inject('/api/health')).json().trialDiagnostics).toBe('write_failed');
    expect((await app.inject({ method: 'POST', url: '/api/trial/diagnostics/events', headers: mutates,
      payload: { event: 'window_loaded', outcome: 'ok' } })).statusCode).toBe(503);
    expect((await app.inject('/api/board')).statusCode).toBe(200);
  });

  it('observes model calls, safe usage and job counts without model inputs, outputs or error text', async () => {
    const dataDir = sandbox();
    const logger = new TrialDiagnostics(dataDir);
    const summarize = vi.fn().mockResolvedValueOnce({ value: secret, model: secret,
      usage: { inputTokens: 5, cachedInputTokens: 1, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 8 } })
      .mockRejectedValueOnce(new Error(secret));
    const model = logger.wrapModel({ summarize });
    const input = { model: secret, effort: secret, prompt: secret, outputSchema: {} };
    await expect(model.summarize(input)).resolves.toMatchObject({ value: secret });
    await expect(model.summarize(input)).rejects.toThrow(secret);
    logger.observeSyncJob({ id: secret, model: secret, state: 'paused', completed: 1, skipped: 2, failures: [{ threadKey: secret, code: secret }], error: secret } as SyncJob);
    const file = load(dataDir, 'server');
    const entries = file.trim().split('\n').map(line => trialEventSchema.parse(JSON.parse(line)));
    expect(entries).toEqual([
      expect.objectContaining({ event: 'model', outcome: 'start' }),
      expect.objectContaining({ event: 'model', outcome: 'ok', inputTokens: 5, outputTokens: 3 }),
      expect.objectContaining({ event: 'model', outcome: 'start' }),
      expect.objectContaining({ event: 'model', outcome: 'failed', code: 'model_error' }),
      expect.objectContaining({ event: 'sync_job', jobState: 'paused', outcome: 'blocked', completed: 1, skipped: 2, failed: 1 })
    ]);
    expect(file).not.toContain(secret);
  });
});
