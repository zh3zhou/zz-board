import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { BoardDatabase } from '../../src/server/database.js';
import { loadConfig } from '../../src/server/config.js';
import type { CodexAppServerClient } from '../../src/server/codex/appServerClient.js';
import { ProjectRefresh, type ProjectSourceReader } from '../../src/server/projectRefresh.js';
import { SummaryJobs } from '../../src/server/summaryJobs.js';
import { boardSnapshotSchema } from '../../src/shared/schema.js';
import type { EvidenceBundle } from '../../src/shared/summarySync.js';
import { summary } from '../fixtures/summary.js';
import { grantSyntheticCodexAccess } from '../fixtures/codexAccess.js';
import { AutoCheck } from '../../src/server/autoCheck.js';
import { initialCodexAccess } from '../../src/shared/codexAccess.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const time = '2026-09-21T08:00:00.000Z';
const cwd = 'E:\\synthetic';
let app: FastifyInstance | undefined; let db: BoardDatabase | undefined;
afterEach(async () => { if (app) await app.close(); else db?.close(); app = undefined; db = undefined; });
const headers = { 'x-zz-board-mutation': '1' };
const guardedOperation = expect.objectContaining({ check: expect.any(Function), signal: expect.any(AbortSignal) });
function seed(threads: Array<Record<string, unknown>> = [], hostId = 'local', filename = ':memory:') {
  db = new BoardDatabase(filename);
  grantSyntheticCodexAccess(db);
  db.importSnapshot(boardSnapshotSchema.parse({ schemaVersion: 1, generatedAt: time, source: 'review-project-progress',
    projects: [{ projectKey: 'native/project', projectId: 'saved-native', name: '合成项目', cwd, hostId, sidebarIndex: 8, observedAt: time }],
    coverage: { projectsFound: 1, threadsFound: threads.length, deepRead: 0, fileChecked: 0, truncated: false, inaccessible: [] },
    threads: threads.map(t => ({ sourceKind: 'codex', hostId: 'local', projectKey: 'native/project', title: '合成对话', observedAt: time, sourceUpdatedAt: time, ...t })) }));
  return db;
}
function read(id: string) { return { thread: { id, cwd, updatedAt: time, status: { type: 'notLoaded' }, turns: [{ id: `${id}:turn`, status: 'completed', startedAt: time, completedAt: time,
  items: [{ type: 'agentMessage', phase: 'final_answer', id: 'answer', text: '合成构建已完成，未说明下一步。' }] }] } }; }
function reader(data: unknown[] = []) {
  return { listProjectThreads: vi.fn(async () => ({ data, nextCursor: null })), readThread: vi.fn(async (id: string) => read(id)), dispose: vi.fn() };
}
const entry = (id: string, updatedAt = time, path = cwd) => ({ id, name: `合成 ${id}`, cwd: path, updatedAt });

describe('selected-project refresh API and merge boundary', () => {
  it('refreshes metadata of known unlisted IDs before ranking, so a stale index cannot starve recent work', async () => {
    const database = seed([{ threadKey: 'known', threadId: 'active-but-unlisted', sourceUpdatedAt: '2026-09-01T08:00:00.000Z' }]);
    const sourceReader = { ...reader([entry('a'), entry('b'), entry('c')]), readThreadMetadata: vi.fn(async id => ({ thread: { id, updatedAt: '2026-09-22T08:00:00.000Z' } })) };
    const refresh = new ProjectRefresh(database, sourceReader, { list: () => [], create: vi.fn(() => ({} as never)) });
    const result = await refresh.refresh('native/project');
    expect(sourceReader.readThreadMetadata).toHaveBeenCalledExactlyOnceWith('active-but-unlisted', guardedOperation);
    expect(sourceReader.readThread.mock.calls.map(c => c[0])).toEqual(['active-but-unlisted', 'a', 'b']);
    expect(result.gaps.join('')).toContain('按已知 ID 补查元数据');
    expect(database.getBoard().threads.some(t => t.threadId === 'c')).toBe(true);
    expect(result.sources?.find(s => s.threadKey === 'codex:local:c')).toMatchObject({ discovered: true, state: 'not-read' });
  });
  it('registers newly discovered review conversations even when their evidence is unavailable, without adding todos or history', async () => {
    const database = seed([{ threadKey: 'known', threadId: 'a' }]);
    const note = database.createNote({ title: '', body: '保留便签', x: 3, y: 4, width: 200, height: 150 });
    const history = database.getHistoryStatus();
    const sourceReader = reader([entry('review', '2026-09-22T08:00:00.000Z'), entry('a')]);
    sourceReader.readThread.mockImplementation(async id => id === 'review' ? { thread: { ...read(id).thread, turns: [] } } : read(id));
    const refresh = new ProjectRefresh(database, sourceReader, { list: () => [], create: vi.fn(() => ({} as never)) });
    const result = await refresh.refresh('native/project');
    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadKey: 'codex:local:review', discovered: true, state: 'unavailable' }),
      expect.objectContaining({ threadKey: 'known', discovered: false, state: 'read' })
    ]));
    const state = database.getBoard();
    expect(state.threads).toHaveLength(2);
    expect(state.threads.find(t => t.threadId === 'review')).toMatchObject({ workState: 'insufficient_evidence', humanAction: 'none', actionStrength: 'none', recap: undefined });
    expect(state.todos).toHaveLength(0); expect(state.nodes.find(n => n.id === note.id)).toEqual(note);
    expect(database.getHistoryStatus()).toEqual(history);
    const repeated = new ProjectRefresh(database, sourceReader, { list: () => [], create: vi.fn(() => ({} as never)) });
    expect((await repeated.refresh('native/project')).sources?.every(s => !s.discovered)).toBe(true);
    expect(database.getBoard().threads).toHaveLength(2);
  });
  it('keeps valid recent work before an empty final turn and includes a tail coverage warning in the submitted evidence', async () => {
    const database = seed([{ threadKey: 'known', threadId: 'a' }]); const sourceReader = reader([entry('a')]);
    sourceReader.readThread.mockResolvedValue({ thread: { ...read('a').thread, turns: [...read('a').thread.turns,
      { id: 'empty-final', status: 'interrupted', startedAt: time, completedAt: time, items: [] }] } });
    let submitted: EvidenceBundle | undefined;
    const refresh = new ProjectRefresh(database, sourceReader, { list: () => [], create: vi.fn(bundle => { submitted = bundle; return {} as never; }) });
    const result = await refresh.refresh('native/project');
    expect(result.readCount).toBe(1); expect(submitted?.threads[0].evidence).toHaveLength(1);
    expect(submitted?.threads[0].readReason).toContain('最新回合没有可用');
    expect(result.sources?.[0]).toMatchObject({ state: 'read', evidenceLatestAt: time });
  });
  it('does not mistake an empty local index for complete project coverage', async () => {
    const database = seed([{ threadKey: 'known', threadId: 'a' }]);
    const sourceReader = reader([]); const create = vi.fn();
    const refresh = new ProjectRefresh(database, sourceReader, { list: () => [], create });
    const result = await refresh.refresh('native/project');
    expect(sourceReader.readThread).toHaveBeenCalledWith('a', guardedOperation);
    expect(result.readCount).toBe(1); expect(result.gaps.join('')).toContain('本地索引未列出');
  });
  it('requires deliberate writes, uses no resume/send, and retains notes/history/native order', async () => {
    const database = seed([{ threadKey: 'old:identity', threadId: 'a', hostId: undefined, sidebarIndex: 11 }]);
    const note = database.createNote({ title: '', body: '本地便签', x: 3, y: 4, width: 200, height: 150 });
    const history = database.getHistoryStatus(); const sourceReader = reader([entry('a')]); let calls = 0;
    app = await buildApp({ ...loadConfig({}), databasePath: ':memory:' }, { db: database, codex: sourceReader as unknown as CodexAppServerClient,
      summaryRuntime: { models: async () => [], summarize: async () => { calls++; return { model: 'gpt-5.6-sol', usage: null, value: { ...summary(), stopPointRefs: ['a:turn:answer'], achievements: [], versions: [] } }; } } });
    const url = '/api/projects/native%2Fproject/refresh';
    expect((await app.inject({ url: url + '-status' })).json()).toMatchObject({ outcome: 'unknown', attemptedAt: null, latestEvidenceCheckAt: null });
    expect(sourceReader.listProjectThreads).not.toHaveBeenCalled(); expect(calls).toBe(0);
    expect((await app.inject({ method: 'POST', url })).statusCode).toBe(403);
    expect(sourceReader.readThread).not.toHaveBeenCalled();
    const response = await app.inject({ method: 'POST', url, headers });
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ scope: 'local-codex', readCount: 1 });
    for (let i = 0; i < 100 && !database.getBoard().threads[0]?.recap; i++) await new Promise(r => setTimeout(r, 5));
    expect(calls).toBe(1); expect(sourceReader.readThread).toHaveBeenCalledExactlyOnceWith('a', guardedOperation);
    const state = database.getBoard();
    expect(state.projects[0]).toMatchObject({ projectKey: 'native/project', sidebarIndex: 8, projectId: 'saved-native' });
    expect(state.threads[0]).toMatchObject({ threadKey: 'old:identity', sidebarIndex: 11, runtimeState: 'unknown' });
    expect(state.threads[0]?.hostId).toBeUndefined();
    expect(state.nodes.find(n => n.id === note.id)).toEqual(note); expect(database.getHistoryStatus()).toEqual(history);
    expect((await app.inject({ method: 'POST', url, headers })).json().job.id).toBe(response.json().job.id);
    database.saveCodexAccess(initialCodexAccess());
    expect((await app.inject({ url: url + '-status' })).json()).toMatchObject({ outcome: 'updated', readCount: 1, updatedThreadKeys: ['old:identity'], lastVerifiedAt: response.json().checkedAt });
    expect((await app.inject({ url: '/api/projects/missing/refresh-status' })).statusCode).toBe(404);
    grantSyntheticCodexAccess(database);
    expect(sourceReader.readThread).toHaveBeenCalledTimes(1);
    expect((await app.inject({ method: 'POST', url: '/api/projects/missing/refresh', headers })).statusCode).toBe(404);
  });
  it('keeps known archived IDs, selects latest three, and excludes unrelated cwd and remote sources', async () => {
    const database = seed([{ threadKey: 'archived:key', threadId: 'archived', sourceUpdatedAt: '2026-09-22T08:00:00.000Z' },
      { threadKey: 'remote:key', threadId: 'remote', hostId: 'remote:host' }, { threadKey: 'chat:key', threadId: 'chat', sourceKind: 'chatgpt' }]);
    const sourceReader = reader([entry('a'), entry('b'), entry('c'), entry('unrelated', time, 'E:\\other')]);
    let submitted: EvidenceBundle | undefined;
    const refresh = new ProjectRefresh(database, sourceReader, { list: () => [], create: vi.fn((bundle) => { submitted = bundle; return {} as never; }) });
    const result = await refresh.refresh('native/project');
    expect(sourceReader.readThread.mock.calls.map(c => c[0])).toEqual(['archived', 'a', 'b']);
    expect(result.readCount).toBe(3); expect(result.gaps.join(' ')).toContain('ChatGPT');
    expect(submitted?.threads[0]?.threadKey).toBe('archived:key');
    expect(submitted?.projects[0]?.sidebarIndex).toBe(8);
  });
  it('does not read a remote project or mutate failed/empty source freshness', async () => {
    let database = seed([], 'remote:host'); const sourceReader = reader([entry('a')]); const create = vi.fn();
    const remote = new ProjectRefresh(database, sourceReader, { list: () => [], create });
    expect((await remote.refresh('native/project')).job).toBeNull(); expect(sourceReader.listProjectThreads).not.toHaveBeenCalled();
    database.close(); db = undefined;
    database = seed([{ threadKey: 'one', threadId: 'a' }]);
    sourceReader.readThread.mockResolvedValue({ thread: { ...read('a').thread, turns: [] } });
    const before = database.getBoard(); const refresh = new ProjectRefresh(database, sourceReader, { list: () => [], create });
    const result = await refresh.refresh('native/project');
    expect(result.readCount).toBe(0); expect(create).not.toHaveBeenCalled();
    expect(database.getBoard()).toEqual(before); expect(result.gaps.join('')).toContain('回合内容');
  });
  it('coalesces concurrent requests and bounds listing cursors', async () => {
    const database = seed([{ threadKey: 'one', threadId: 'a' }]); let release!: () => void;
    const hold = new Promise<void>(r => { release = r; });
    const sourceReader: ProjectSourceReader = { listProjectThreads: vi.fn(async () => { await hold; return { data: [entry('a')], nextCursor: 'repeated' }; }), readThread: vi.fn(async () => read('a')) };
    const refresh = new ProjectRefresh(database, sourceReader, { list: () => [], create: vi.fn(() => ({} as never)) });
    const first = refresh.refresh('native/project'); const second = refresh.refresh('native/project'); release();
    expect(await second).toEqual(await first); expect(sourceReader.listProjectThreads).toHaveBeenCalledTimes(2);
    expect(sourceReader.readThread).toHaveBeenCalledTimes(1); expect((await first).gaps.join('')).toContain('游标异常');
  });
  it('retains known identities on listing failure without exposing private errors', async () => {
    const database = seed([{ threadKey: 'known', threadId: 'a' }]); const sourceReader = reader();
    sourceReader.listProjectThreads.mockRejectedValue(new Error('private transcript here'));
    const refresh = new ProjectRefresh(database, sourceReader, { list: () => [], create: vi.fn(() => ({} as never)) });
    const result = await refresh.refresh('native/project');
    expect(result.readCount).toBe(1); expect(JSON.stringify(result)).not.toContain('private transcript');
    expect(result.gaps.join('')).toContain('目录读取失败');
  });
  it('reuses a running job beyond the cooldown and makes zero model calls for unchanged evidence', async () => {
    const database = seed([{ threadKey: 'one', threadId: 'a' }]); const sourceReader = reader([entry('a')]);
    let clock = new Date(time); let calls = 0; let finish!: (value: { model: string; usage: null; value: unknown }) => void;
    const jobs = new SummaryJobs(database, { summarize: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
    try {
      const refresh = new ProjectRefresh(database, sourceReader, jobs, () => clock);
      const first = await refresh.refresh('native/project');
      clock = new Date(clock.getTime() + 60_000);
      const inFlight = await refresh.refresh('native/project', { automatic: true });
      expect(inFlight.job?.id).toBe(first.job?.id); expect(inFlight.job?.state).toBe('running');
      const coldCache = new ProjectRefresh(database, sourceReader, jobs, () => clock);
      expect((await coldCache.refresh('native/project')).job?.id).toBe(first.job?.id);
      coldCache.dispose();
      expect(sourceReader.readThread).toHaveBeenCalledTimes(1); expect(calls).toBe(1);
      finish({ model: 'gpt-5.6-sol', usage: null, value: { ...summary(), stopPointRefs: ['a:turn:answer'], achievements: [], versions: [] } });
      for (let i = 0; i < 100 && jobs.list()[0]?.state !== 'complete'; i++) await new Promise(r => setTimeout(r, 5));
      const unchanged = await refresh.refresh('native/project');
      expect(unchanged.job).toMatchObject({ state: 'complete', total: 0, skipped: 1 }); expect(calls).toBe(1);
      expect(sourceReader.readThread).toHaveBeenCalledTimes(2);
      expect(database.projectChecks.get('native/project')).toMatchObject({ outcome: 'unchanged', lastVerifiedAt: clock.toISOString(), readCount: 1 });
    } finally { jobs.dispose(); }
  });
  it('holds the daily preference through consent and a failed selected check, then resumes tomorrow after verifying the three bounded sources', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'zzb-project-check-'));
    const filename = path.join(directory, 'synthetic.sqlite');
    const database = seed([], 'local', filename); database.saveCodexAccess(initialCodexAccess());
    database.saveAutoCheck({ ...database.getAutoCheck(), enabled: true });
    const clock = new Date('2026-09-27T08:00:00.000Z');
    const sourceReader = reader([entry('a', time, 'e:/SYNTHETIC/'), entry('b'), entry('c'), entry('outside-window'), entry('other-project', time, cwd + '-two')]);
    let wrongDirectory = true;
    sourceReader.readThread.mockImplementation(async id => {
      const value = read(id);
      if (id === 'a') value.thread.cwd = wrongDirectory ? cwd + '-two' : 'e:/SYNTHETIC/';
      if (id === 'b') value.thread.turns[0]!.items[0]!.text = '合成的长记录。'.repeat(1200);
      if (id === 'c') value.thread.turns.push({ ...value.thread.turns[0]!, id: 'empty-tail', status: 'inProgress', items: [] });
      return value;
    });
    const summarize = vi.fn(async ({ prompt }: { prompt: string }) => {
      const id = ['a', 'b', 'c'].find(id => prompt.includes(`"${id}:turn:answer"`))!;
      return { model: 'synthetic', usage: null, value: { ...summary(), stopPointRefs: [`${id}:turn:answer`], achievements: [], versions: [] } };
    });
    const jobs = new SummaryJobs(database, { summarize });
    const refresh = new ProjectRefresh(database, sourceReader, jobs, () => clock);
    const scheduler = new AutoCheck(database, refresh, jobs, () => clock);
    try {
      grantSyntheticCodexAccess(database); await scheduler.tick(); await scheduler.tick(true);
      const gate = scheduler.status().recoveryToken;
      expect(gate).toBeTruthy(); expect(sourceReader.listProjectThreads).not.toHaveBeenCalled();
      const first = await refresh.refresh('native/project');
      await vi.waitFor(() => expect(jobs.list().find(job => job.id === first.job?.id)?.state).toBe('complete'));
      expect(database.projectChecks.get('native/project')).toMatchObject({ readCount: 2, outcome: 'partial', lastVerifiedAt: null });
      expect(scheduler.status().recoveryToken).toBe(gate); expect(summarize).toHaveBeenCalledTimes(2);
      wrongDirectory = false;
      const second = await refresh.refresh('native/project');
      await vi.waitFor(() => expect(jobs.list().find(job => job.id === second.job?.id)?.state).toBe('complete'));
      expect(summarize).toHaveBeenCalledTimes(3);
      const saved = database.projectChecks.get('native/project');
      expect(saved).toMatchObject({ outcome: 'updated', readCount: 3, limitedExcerpts: true, attemptedAt: clock.toISOString(), lastVerifiedAt: clock.toISOString(), updatedThreadKeys: ['codex:local:a'] });
      expect(saved.sources.map(source => [source.threadKey, source.evidenceLatestAt])).toEqual(['a','b','c'].map(id => [`codex:local:${id}`, time]));
      expect(JSON.stringify(saved)).not.toContain('合成的长记录。');
      expect(scheduler.status()).toMatchObject({ enabled: true, state: 'idle', recoveryToken: null, nextCheckAt: '2026-09-28T08:00:00.000Z' });
      await scheduler.tick(); expect(sourceReader.listProjectThreads).toHaveBeenCalledTimes(2);
      scheduler.dispose(); refresh.dispose(); jobs.dispose(); database.close(); db = new BoardDatabase(filename);
      expect(db.projectChecks.get('native/project')).toEqual(saved); expect(db.getAutoCheck().nextCheckAt).toBe('2026-09-28T08:00:00.000Z');
    } finally {
      scheduler.dispose(); refresh.dispose(); jobs.dispose(); db?.close(); db = undefined;
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('prefers bounded recent reads and reports paging failure without a full-read fallback', async () => {
    const database = seed([{ threadKey: 'one', threadId: 'a' }]);
    const sourceReader = { ...reader([entry('a')]), readRecentThread: vi.fn(async () => { throw Object.assign(new Error('private detail'), { code: 'recent_paging_unavailable' }); }) };
    const create = vi.fn(); const refresh = new ProjectRefresh(database, sourceReader, { list: () => [], create });
    const result = await refresh.refresh('native/project');
    expect(sourceReader.readRecentThread).toHaveBeenCalledExactlyOnceWith('a', guardedOperation);
    expect(sourceReader.readThread).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    expect(result.gaps.join('')).toContain('未回退完整历史'); expect(JSON.stringify(result)).not.toContain('private detail');
  });
  it('does not promote an empty skipped job or a bad summary reference into a verified update', async () => {
    const database = seed([{ threadKey: 'one', threadId: 'a' }]); const sourceReader = reader([entry('a')]);
    const jobs = new SummaryJobs(database, { summarize: async () => ({ model: 'synthetic', usage: null, value: { ...summary(), stopPointRefs: ['different-thread:answer'], achievements: [], versions: [] } }) });
    try {
      const refresh = new ProjectRefresh(database, sourceReader, jobs, () => new Date(time));
      const first = await refresh.refresh('native/project');
      await vi.waitFor(() => expect(jobs.list().find(job => job.id === first.job?.id)?.state).toBe('paused'));
      expect(database.projectChecks.get('native/project')).toMatchObject({ outcome: 'failed', failureCode: 'invalid_reference', lastVerifiedAt: null });
      const fakeSkip = { ...first.job!, id: 'other-empty-job', state: 'complete' as const, skipped: 1, total: 0, completed: 0, failures: [] };
      database.projectChecks.begin('native/project', time, 'gate');
      database.projectChecks.collected(first, fakeSkip);
      expect(database.projectChecks.get('native/project')).toMatchObject({ outcome: 'partial', lastVerifiedAt: null });
      expect(database.projectChecks.hasVerified('gate')).toBe(false);
      refresh.dispose();
    } finally { jobs.dispose(); }
  });
});
