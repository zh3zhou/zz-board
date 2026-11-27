import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { loadConfig } from '../../src/server/config.js';
import { BoardDatabase } from '../../src/server/database.js';
import { CodexAppServerClient } from '../../src/server/codex/appServerClient.js';
import { SummaryJobs, sourceFingerprint } from '../../src/server/summaryJobs.js';
import { ProjectRefresh } from '../../src/server/projectRefresh.js';
import { AutoCheck } from '../../src/server/autoCheck.js';
import { DEFAULT_SUMMARY_SETTINGS } from '../../src/shared/summarySync.js';
import { initialCodexAccess } from '../../src/shared/codexAccess.js';
import { bundle, source, summary } from '../fixtures/summary.js';
import { grantSyntheticCodexAccess } from '../fixtures/codexAccess.js';

const headers = { 'x-zz-board-mutation': '1' };
const databases: BoardDatabase[] = [];
const disposables: Array<{ dispose(): void }> = [];
const apps: FastifyInstance[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const disposable of disposables) disposable.dispose();
  for (const app of apps) await app.close();
  for (const db of databases) db.close();
  for (const directory of directories) await fs.rm(directory, { recursive: true, force: true });
  disposables.length = apps.length = databases.length = directories.length = 0;
});
function database(): BoardDatabase { const db = new BoardDatabase(':memory:'); databases.push(db); return db; }
async function fixture(codexOverride?: CodexAppServerClient) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zzb-consent-')); directories.push(directory);
  const db = new BoardDatabase(':memory:');
  const models = vi.fn(async () => [{ id: 'synthetic', efforts: ['medium'] }]);
  const summarize = vi.fn(async () => ({ value: summary(), usage: null, model: 'synthetic' }));
  const codex = { dispose: vi.fn(), listThreads: vi.fn(async () => ({ data: [], nextCursor: null })), sendCuratorTurn: vi.fn(),
    listProjectThreads: vi.fn(async () => ({ data: [], nextCursor: null })), readThread: vi.fn() };
  const app = await buildApp({ ...loadConfig({ ZZ_BOARD_DATA_DIR: directory }), databasePath: ':memory:' },
    { db, summaryRuntime: { models, summarize }, codex: codexOverride ?? codex as unknown as CodexAppServerClient });
  apps.push(app); return { db, app, models, summarize, codex };
}
describe('explicit first-use Codex access', () => {
  it('fails closed for every source/model entry while board and local settings stay usable', async () => {
    const { app, models, summarize, codex } = await fixture();
    expect((await app.inject({ url: '/api/codex/access' })).json()).toEqual(initialCodexAccess());
    expect((await app.inject({ url: '/api/board' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/summary/settings' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/sync/jobs' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/sync/auto-check' })).json().enabled).toBe(false);
    const denied: Array<{ method: 'GET' | 'POST' | 'PATCH'; url: string; payload?: Record<string, unknown> }> = [
      { method: 'GET', url: '/api/summary/models' }, { method: 'POST', url: '/api/codex/prepare' },
      { method: 'PATCH', url: '/api/summary/settings', payload: { model: 'synthetic', effort: 'medium' } },
      { method: 'POST', url: '/api/sync/local' }, { method: 'POST', url: '/api/projects/example/refresh' },
      { method: 'POST', url: '/api/projects/example/conversations/refresh' }, { method: 'POST', url: '/api/projects/example/conversations/earlier' },
      { method: 'GET', url: '/api/projects/example/history/preview' }, { method: 'POST', url: '/api/projects/example/history' },
      { method: 'POST', url: '/api/sync/jobs', payload: { bundle: bundle() } },
      { method: 'POST', url: '/api/sync/jobs/00000000-0000-4000-8000-000000000000/resume' },
      { method: 'POST', url: '/api/curator/ask', payload: { question: 'synthetic' } },
      { method: 'PATCH', url: '/api/sync/auto-check', payload: { enabled: true } }, { method: 'POST', url: '/api/sync/auto-check/run' }
    ];
    for (const request of denied) {
      const response = await app.inject({ ...request, headers });
      expect(response.statusCode, request.url).toBe(403);
      expect(response.json()).toMatchObject({ code: 'CODEX_ACCESS_REQUIRED', required: 'localRead' });
    }
    expect(models).not.toHaveBeenCalled(); expect(summarize).not.toHaveBeenCalled();
    expect(codex.listThreads).not.toHaveBeenCalled(); expect(codex.listProjectThreads).not.toHaveBeenCalled(); expect(codex.sendCuratorTurn).not.toHaveBeenCalled();
  });
  it('requires deliberate, strict consent; read-only preparation cannot spend model tokens', async () => {
    const { app, db, models, summarize } = await fixture();
    const before = db.getHistoryStatus(); const revision = db.getBoardRevision();
    expect((await app.inject({ method: 'PATCH', url: '/api/codex/access', payload: { localRead: true, modelUse: false } })).statusCode).toBe(403);
    for (const payload of [{ localRead: false, modelUse: true }, { localRead: true, modelUse: false, extra: true }, { localRead: 'true', modelUse: false }]) {
      expect((await app.inject({ method: 'PATCH', url: '/api/codex/access', headers, payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'PATCH', url: '/api/codex/access', headers: { ...headers, origin: 'https://synthetic.invalid' }, payload: { localRead: true, modelUse: false } })).statusCode).toBe(403);
    const consent = await app.inject({ method: 'PATCH', url: '/api/codex/access', headers, payload: { localRead: true, modelUse: false } });
    expect(consent.json()).toMatchObject({ schemaVersion: 1, localRead: true, modelUse: false, decidedAt: expect.any(String) });
    expect(db.getHistoryStatus()).toEqual(before); expect(db.getBoardRevision()).toBe(revision);
    const prepared = await app.inject({ method: 'POST', url: '/api/codex/prepare', headers });
    expect(prepared.json()).toMatchObject({ available: true, models: [{ id: 'synthetic', efforts: ['medium'] }] });
    expect(models).toHaveBeenCalledTimes(1); expect(summarize).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'POST', url: '/api/sync/jobs', headers, payload: { bundle: bundle() } })).json()).toMatchObject({ code: 'CODEX_ACCESS_REQUIRED', required: 'modelUse' });
    expect((await app.inject({ method: 'PATCH', url: '/api/sync/auto-check', headers, payload: { enabled: false } })).statusCode).toBe(200);
  });
  it('requires new consent for an existing store, retains preferences, and persists outside undo', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zzb-consent-store-')); directories.push(directory);
    const filename = path.join(directory, 'synthetic.sqlite'); let db = new BoardDatabase(filename);
    db.saveAutoCheck({ ...db.getAutoCheck(), enabled: true }); db.prepareEvidence(bundle([]), new Map());
    db.close(); db = new BoardDatabase(filename); databases.push(db);
    expect(db.getCodexAccess()).toEqual(initialCodexAccess()); expect(db.getAutoCheck().enabled).toBe(true);
    const refresh = vi.fn(async () => ({ projectKey: 'example', checkedAt: new Date().toISOString(), scope: 'local-codex' as const, readCount: 0, gaps: [], job: null }));
    const scheduler = new AutoCheck(db, { refresh }, { list: () => [] }); disposables.push(scheduler);
    await scheduler.tick(); expect(refresh).not.toHaveBeenCalled(); expect(scheduler.status()).toMatchObject({ enabled: true, state: 'paused', lastCompletedAt: null });
    db.createNote({ body: 'synthetic', title: '', x: 0, y: 0, width: 180, height: 140 });
    grantSyntheticCodexAccess(db); db.undo(); expect(db.getCodexAccess().modelUse).toBe(true);
    db.setSetting('codexAccessV1', '{"schemaVersion":1,"localRead":false,"modelUse":true,"decidedAt":null}');
    expect(db.getCodexAccess()).toEqual(initialCodexAccess());
  });
  it('aborts preparation and rejects a stale catalog even when access is granted again', async () => {
    const { app, db, models, summarize } = await fixture(); grantSyntheticCodexAccess(db);
    let release!: (value: Array<{ id: string; efforts: string[] }>) => void;
    models.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = app.inject({ method: 'POST', url: '/api/codex/prepare', headers }).then(response => response);
    await vi.waitFor(() => expect(models).toHaveBeenCalledTimes(1));
    const signal = (models.mock.calls[0] as unknown as [AbortSignal])[0];
    db.saveCodexAccess({ schemaVersion: 1, localRead: false, modelUse: false, decidedAt: new Date().toISOString() });
    grantSyntheticCodexAccess(db); expect(signal.aborted).toBe(true);
    release([{ id: 'synthetic', efforts: ['medium'] }]); const result = await pending;
    expect(result.statusCode).toBe(403); expect(result.json()).toMatchObject({ code: 'CODEX_ACCESS_REQUIRED', required: 'localRead' });
    expect(summarize).not.toHaveBeenCalled();
  });
  it.each(['connect', 'resume'] as const)('does not send a curator turn when access is revoked during %s', async stage => {
    const client = new CodexAppServerClient('synthetic-unused-executable');
    let release!: () => void; const pause = new Promise<void>(resolve => { release = resolve; });
    const connect = vi.spyOn(client, 'connect').mockImplementation(() => stage === 'connect' ? pause : Promise.resolve());
    const request = vi.spyOn(client, 'request').mockImplementation(async method => {
      if (method === 'thread/resume') { if (stage === 'resume') await pause; return {}; }
      throw new Error('Synthetic unexpected request, no model started.');
    });
    const { app, db } = await fixture(client); grantSyntheticCodexAccess(db); db.setSetting('curatorThreadId', 'synthetic-curator');
    const pending = app.inject({ method: 'POST', url: '/api/curator/ask', headers, payload: { question: 'synthetic' } }).then(response => response);
    await vi.waitFor(() => expect(stage === 'connect' ? connect : request).toHaveBeenCalledTimes(1));
    db.saveCodexAccess({ schemaVersion: 1, localRead: false, modelUse: false, decidedAt: new Date().toISOString() });
    release(); const result = await pending; expect(result.statusCode).toBe(403);
    expect(result.json()).toMatchObject({ code: 'CODEX_ACCESS_REQUIRED' });
    expect(request.mock.calls.map(call => call[0])).toEqual(stage === 'connect' ? [] : ['thread/resume']);
  });
  it('clears and pauses running and queued evidence on revocation, without committing a late result', async () => {
    const db = database(); grantSyntheticCodexAccess(db); let release!: (value: { value: unknown; usage: null; model: string }) => void;
    const summarize = vi.fn(() => new Promise<{ value: unknown; usage: null; model: string }>(resolve => { release = resolve; }));
    const jobs = new SummaryJobs(db, { summarize }); disposables.push(jobs);
    const first = jobs.create(bundle([source('a')]), DEFAULT_SUMMARY_SETTINGS);
    const second = jobs.create(bundle([source('b')]), DEFAULT_SUMMARY_SETTINGS);
    expect(summarize).toHaveBeenCalledTimes(1);
    const signal = (summarize.mock.calls[0] as unknown as [{ signal: AbortSignal }])[0].signal;
    db.saveCodexAccess({ schemaVersion: 1, localRead: true, modelUse: false, decidedAt: new Date().toISOString() });
    expect(signal.aborted).toBe(true);
    for (const id of [first.id, second.id]) expect(jobs.list().find(job => job.id === id)).toMatchObject({ state: 'paused', needsResubmit: true, completed: 0 });
    release({ value: summary('a'), usage: null, model: 'synthetic' }); await new Promise(resolve => setTimeout(resolve, 10));
    expect(summarize).toHaveBeenCalledTimes(1); expect(db.getBoard().threads.every(thread => !thread.recap)).toBe(true);
    expect(() => jobs.control(second.id, 'resume')).toThrow('模型调用');
    grantSyntheticCodexAccess(db); expect(() => jobs.control(second.id, 'resume')).toThrow('临时证据');
  });
  it('rechecks queued collection and drops an in-flight read after revocation', async () => {
    const db = database(); grantSyntheticCodexAccess(db);
    const input = bundle([source('a')]); input.projects[0]!.cwd = 'E:/synthetic/project'; db.prepareEvidence(input, new Map(input.threads.map(thread => [thread.threadKey, sourceFingerprint(thread)])));
    let release!: (value: unknown) => void;
    const reader = { listProjectThreads: vi.fn(() => new Promise(resolve => { release = resolve; })), readThread: vi.fn() };
    const create = vi.fn(); const refresh = new ProjectRefresh(db, reader, { create, list: () => [] }); disposables.push(refresh);
    const first = refresh.refresh('example'); const second = refresh.conversations('example');
    const settled = Promise.allSettled([first, second]); await vi.waitFor(() => expect(reader.listProjectThreads).toHaveBeenCalledTimes(1));
    db.saveCodexAccess({ schemaVersion: 1, localRead: false, modelUse: false, decidedAt: new Date().toISOString() });
    release({ data: [], nextCursor: null });
    const results = await settled; expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(reader.readThread).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
  it('does not record an automatic check as completed after access is revoked', async () => {
    const db = database(); grantSyntheticCodexAccess(db); db.saveAutoCheck({ ...db.getAutoCheck(), enabled: true });
    const input = bundle([]); input.projects[0]!.cwd = 'E:/synthetic/project'; db.prepareEvidence(input, new Map());
    let release!: (value: { projectKey: string; checkedAt: string; scope: 'local-codex'; readCount: number; gaps: string[]; job: null }) => void;
    const refresh = vi.fn(() => new Promise<Parameters<typeof release>[0]>(resolve => { release = resolve; }));
    const scheduler = new AutoCheck(db, { refresh }, { list: () => [] }); disposables.push(scheduler);
    const pending = scheduler.tick(); expect(refresh).toHaveBeenCalledTimes(1);
    db.saveCodexAccess({ schemaVersion: 1, localRead: false, modelUse: false, decidedAt: new Date().toISOString() });
    release({ projectKey: 'example', checkedAt: new Date().toISOString(), scope: 'local-codex', readCount: 1, gaps: [], job: null });
    await pending;
    expect(scheduler.status()).toMatchObject({ enabled: true, state: 'paused', lastCompletedAt: null, completedProjects: 0 });
    await scheduler.tick(); expect(refresh).toHaveBeenCalledTimes(1);
  });
});
