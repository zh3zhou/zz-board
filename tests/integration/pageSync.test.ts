import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { BoardDatabase } from '../../src/server/database.js';
import { AutoCheck } from '../../src/server/autoCheck.js';
import { ProjectRefresh } from '../../src/server/projectRefresh.js';
import { SummaryJobs, sourceFingerprint } from '../../src/server/summaryJobs.js';
import { previewHistory } from '../../src/server/historyFiles.js';
import { ProjectPagePausedError, requireProjectPageCheck } from '../../src/server/projectPagePolicy.js';
import { DEFAULT_SUMMARY_SETTINGS } from '../../src/shared/summarySync.js';
import type { ProjectRefreshResult } from '../../src/shared/projectRefresh.js';
import { grantSyntheticCodexAccess } from '../fixtures/codexAccess.js';
import { bundle, source, summary, time } from '../fixtures/summary.js';

const usage = { inputTokens: 100, cachedInputTokens: 20, outputTokens: 40, reasoningOutputTokens: 10, totalTokens: 140 };
const owned: Array<() => void> = [];
afterEach(() => { owned.reverse().forEach(dispose => dispose()); owned.length = 0; vi.restoreAllMocks(); });
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const until = async (predicate: () => boolean) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Synthetic job did not settle'); };

function setup() {
  const db = new BoardDatabase(':memory:'); owned.push(() => db.close()); grantSyntheticCodexAccess(db);
  const policy = new Map<string, { pageId: string; archived: boolean; autoCheckPaused: boolean }>();
  vi.spyOn(db, 'getProjectPagePolicy').mockImplementation(key => policy.get(key) ?? { pageId: 'page:default', archived: false, autoCheckPaused: false });
  const setPolicy = (key: string, value: { archived: boolean; autoCheckPaused: boolean }) => {
    policy.set(key, { pageId: `page:${key}`, ...value });
    // Exercise the production mutation subscription without reaching into private state.
    db.createNote({ title: '', body: '合成策略变更通知', x: 1, y: 2, width: 210, height: 150 });
  };
  const input = bundle([source('a'), source('a2'), { ...source('b'), projectKey: 'other' }]);
  input.projects[0]!.cwd = 'E:/synthetic/project';
  input.projects.push({ ...input.projects[0]!, projectKey: 'other', name: '另一个合成项目', cwd: 'E:/synthetic/other' });
  db.prepareEvidence(input, new Map(input.threads.map(thread => [thread.threadKey, sourceFingerprint(thread)])));
  return { db, input, setPolicy };
}
function sourceId(prompt: string): string {
  return JSON.parse(prompt.slice(prompt.indexOf('证据JSON：') + '证据JSON：'.length)).source.threadId as string;
}
function refreshResult(projectKey: string): ProjectRefreshResult { return { projectKey, checkedAt: time, scope: 'local-codex', readCount: 1, gaps: [], job: null }; }

describe('page lifecycle and project checks', () => {
  it('keeps manual checks available on restored paused pages, while archived pages reject all new checks', () => {
    const { db, setPolicy } = setup();
    setPolicy('example', { archived: false, autoCheckPaused: true });
    expect(() => requireProjectPageCheck(db, 'example')).not.toThrow();
    expect(() => requireProjectPageCheck(db, 'example', { automatic: true })).toThrow(ProjectPagePausedError);
    setPolicy('example', { archived: true, autoCheckPaused: true });
    expect(() => requireProjectPageCheck(db, 'example')).toThrow(ProjectPagePausedError);
    setPolicy('example', { archived: false, autoCheckPaused: false });
    expect(() => requireProjectPageCheck(db, 'example', { automatic: true })).not.toThrow();
  });

  it('rechecks page policy between scheduled projects and does not pause the global schedule', async () => {
    const { db, setPolicy } = setup();
    db.saveAutoCheck({ ...db.getAutoCheck(), enabled: true });
    const refresh = vi.fn(async (key: string) => {
      setPolicy('other', { archived: true, autoCheckPaused: true });
      return refreshResult(key);
    });
    const scheduler = new AutoCheck(db, { refresh }, { list: () => [] }); owned.push(() => scheduler.dispose());
    await scheduler.tick(true);
    expect(refresh).toHaveBeenCalledExactlyOnceWith('example', { automatic: true });
    expect(scheduler.status()).toMatchObject({ enabled: true, state: 'idle' });
  });

  it('retires a collection suspended during an RPC, even after an immediate restore', async () => {
    const { db, setPolicy } = setup(); const listing = deferred<unknown>();
    const readThread = vi.fn(async () => ({})); const create = vi.fn();
    const refresh = new ProjectRefresh(db, { listProjectThreads: () => listing.promise, readThread }, { create, list: () => [] }); owned.push(() => refresh.dispose());
    const work = refresh.refresh('example', { automatic: true });
    const rejected = expect(work).rejects.toBeInstanceOf(ProjectPagePausedError);
    await Promise.resolve();
    setPolicy('example', { archived: true, autoCheckPaused: true });
    setPolicy('example', { archived: false, autoCheckPaused: false });
    listing.resolve({ data: [], nextCursor: null });
    await rejected;
    expect(readThread).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });

  it('completes an in-flight result, retires its later sources and continues other projects', async () => {
    const { db, input, setPolicy } = setup(); const first = deferred<{ value: unknown; usage: typeof usage; model: string }>();
    const calls: string[] = [];
    const jobs = new SummaryJobs(db, { summarize: async request => {
      const id = sourceId(request.prompt); calls.push(id);
      return id === 'a' ? first.promise : { value: summary(id), usage, model: 'synthetic' };
    } }); owned.push(() => jobs.dispose());
    const job = jobs.create(input, DEFAULT_SUMMARY_SETTINGS, false, { automatic: true });
    await until(() => calls.length === 1);
    setPolicy('example', { archived: true, autoCheckPaused: true });
    setPolicy('example', { archived: false, autoCheckPaused: false });
    first.resolve({ value: summary('a'), usage, model: 'synthetic' });
    await until(() => jobs.list().find(item => item.id === job.id)?.state === 'complete');
    expect(calls).toEqual(['a', 'b']);
    expect(jobs.list().find(item => item.id === job.id)).toMatchObject({ completed: 2, skipped: 1, usage: { totalTokens: 280 }, needsResubmit: false });
    expect(db.getBoard().threads.find(thread => thread.threadId === 'a')?.recap).toBeTruthy();
    expect(db.getBoard().threads.find(thread => thread.threadId === 'a2')?.recap).toBeUndefined();
    expect(jobs.list().find(item => item.id === job.id)?.coverage.inaccessible.join('')).toContain('页面已归档');
  });

  it('does not retry a failed in-flight request after archive and keeps other projects moving', async () => {
    const { db, input, setPolicy } = setup(); const first = deferred<never>(); const calls: string[] = [];
    const jobs = new SummaryJobs(db, { summarize: async request => {
      const id = sourceId(request.prompt); calls.push(id);
      if (id === 'a') return first.promise;
      return { value: summary(id), usage, model: 'synthetic' };
    } }); owned.push(() => jobs.dispose());
    const job = jobs.create(input, DEFAULT_SUMMARY_SETTINGS, false, { automatic: true });
    await until(() => calls.length === 1);
    setPolicy('example', { archived: true, autoCheckPaused: true });
    first.reject(Object.assign(new Error('synthetic transport failure'), { code: 'ECONNRESET' }));
    await until(() => jobs.list().find(item => item.id === job.id)?.state === 'complete');
    expect(calls).toEqual(['a', 'b']);
    expect(jobs.list().find(item => item.id === job.id)).toMatchObject({ completed: 1, skipped: 2, usage: null, needsResubmit: false });
  });

  it('accepts explicit source metadata on archived pages without starting new model calls', async () => {
    const { db, setPolicy } = setup(); setPolicy('example', { archived: true, autoCheckPaused: true });
    const summarize = vi.fn(); const jobs = new SummaryJobs(db, { summarize }); owned.push(() => jobs.dispose());
    const job = jobs.create(bundle([source('new')]), DEFAULT_SUMMARY_SETTINGS);
    expect(job).toMatchObject({ state: 'complete', skipped: 1 }); expect(summarize).not.toHaveBeenCalled();
    expect(db.evidenceIsCurrent(source('new').threadKey, sourceFingerprint(source('new')))).toBe(true);
  });

  it('blocks archived file-history previews before touching the filesystem', async () => {
    const { db, setPolicy } = setup(); setPolicy('example', { archived: true, autoCheckPaused: true });
    const realpath = vi.spyOn(fs, 'realpath');
    await expect(previewHistory(db, 'example')).rejects.toBeInstanceOf(ProjectPagePausedError);
    expect(realpath).not.toHaveBeenCalled();
  });
});
