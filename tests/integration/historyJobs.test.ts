import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardDatabase } from '../../src/server/database.js';
import { SummaryJobs } from '../../src/server/summaryJobs.js';
import { previewHistory } from '../../src/server/historyFiles.js';
import { DEFAULT_SUMMARY_SETTINGS } from '../../src/shared/summarySync.js';
import { buildApp } from '../../src/server/app.js';
import { loadConfig } from '../../src/server/config.js';
import { bundle } from '../fixtures/summary.js';
import type { FastifyInstance } from 'fastify';
import type { Milestone } from '../../src/shared/milestones.js';
import { grantSyntheticCodexAccess } from '../fixtures/codexAccess.js';

const resources: Array<{ db: BoardDatabase; root: string; jobs?: SummaryJobs; app?: FastifyInstance }> = [];
afterEach(async () => { for (const item of resources) { item.jobs?.dispose(); if (item.app) await item.app.close(); else item.db.close(); await fs.rm(item.root, { recursive: true, force: true }); } resources.length = 0; });
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zz-file-jobs-')); const db = new BoardDatabase(':memory:');
  grantSyntheticCodexAccess(db);
  const state: typeof resources[number] = { root, db }; resources.push(state);
  await fs.writeFile(path.join(root, 'PROGRESS.md'), '## 1.0 — 2026-09-01\n\n问题：保存失败。决定：用SQLite。结果：源码实现并通过回归；包尚未构建，未启动运行。');
  const input = bundle([]); input.projects[0]!.cwd = root; db.prepareEvidence(input, new Map()); return state;
}
const until = async (predicate: () => boolean) => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Timeout'); };
function milestone(ref: string): Milestone { return { id: 'storage', kind: 'decision', title: '修复保存', occurredAt: '2026-09-01', problem: '保存失败', options: [], decision: '用SQLite', result: '源码实现并通过回归', resolution: 'verified', sourceRefs: [ref], version: null }; }
describe('file jobs and timeline API', () => {
  it('uses real file evidence without fake tasks, caches, and preserves undo', async () => {
    const state = await setup(); const { db } = state; const first = await previewHistory(db, 'example'); let calls = 0;
    const note = db.createNote({ body: '原文', title: '', x: 0, y: 0, width: 180, height: 140 }); const history = db.getHistoryStatus();
    state.jobs = new SummaryJobs(db, { summarize: async () => { calls++; return { value: { milestones: [milestone(first.evidence[0]!.evidence[0]!.id)] }, usage: null, model: 'test' }; } });
    const job = state.jobs.createFiles(first.evidence, DEFAULT_SUMMARY_SETTINGS); await until(() => state.jobs!.list().find(item => item.id === job.id)?.state === 'complete');
    expect(db.timeline.page('example').items[0]).toMatchObject({ sourceKind: 'file', threadKey: null }); expect(db.getBoard().threads).toEqual([]); expect(db.getHistoryStatus()).toEqual(history);
    expect(state.jobs.createFiles(first.evidence, DEFAULT_SUMMARY_SETTINGS).total).toBe(0); expect(calls).toBe(1); db.undo(); expect(db.getBoard().nodes.some(value => value.id === note.id)).toBe(false); expect(db.timeline.page('example').total).toBe(1);
  });
  it('does not call the model for stale files or commit cancelled file results', async () => {
    const state = await setup(); const first = await previewHistory(state.db, 'example'); let calls = 0;
    let release!: (value: { value: unknown; usage: null; model: string }) => void;
    state.jobs = new SummaryJobs(state.db, { summarize: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
    await fs.appendFile(first.evidence[0]!.path, '\n文件已变。');
    state.jobs.createFiles(first.evidence, DEFAULT_SUMMARY_SETTINGS); await until(() => state.jobs!.list()[0]?.state === 'paused'); expect(calls).toBe(0);
    const current = await previewHistory(state.db, 'example'); const job = state.jobs.createFiles(current.evidence, DEFAULT_SUMMARY_SETTINGS); await until(() => calls === 1);
    state.jobs.control(job.id, 'cancel'); release({ value: { milestones: [milestone(current.evidence[0]!.evidence[0]!.id)] }, usage: null, model: 'test' }); await new Promise(resolve => setTimeout(resolve, 20));
    expect(state.db.timeline.page('example').total).toBe(0);
  });
  it('requires deliberate writes and a matching preview, and has no automatic model calls on API reads', async () => {
    const state = await setup(); let calls = 0;
    state.app = await buildApp({ ...loadConfig({ ZZ_BOARD_DATA_DIR: state.root, ZZ_BOARD_DEMO: '1' }), databasePath: ':memory:' }, { db: state.db,
      summaryRuntime: { models: async () => [], summarize: async () => { calls++; return { value: { milestones: [] }, usage: null, model: 'test' }; } } });
    const headers = { 'x-zz-board-mutation': '1' };
    expect((await state.app.inject({ method: 'GET', url: '/api/projects/example/timeline' })).json().total).toBe(0);
    const preview = (await state.app.inject({ method: 'GET', url: '/api/projects/example/history/preview' })).json(); expect(calls).toBe(0);
    expect((await state.app.inject({ method: 'POST', url: '/api/projects/example/history', payload: { fingerprint: preview.fingerprint } })).statusCode).toBe(403);
    expect((await state.app.inject({ method: 'POST', url: '/api/projects/example/history', headers, payload: { fingerprint: '0'.repeat(64) } })).statusCode).toBe(409);
    expect((await state.app.inject({ method: 'PATCH', url: '/api/sync/auto-check', headers, payload: { enabled: false } })).json().enabled).toBe(false);
    const result = await state.app.inject({ method: 'POST', url: '/api/projects/example/history', headers, payload: { fingerprint: preview.fingerprint } }); expect(result.statusCode).toBe(200); expect(result.json().kind).toBe('history');
    await until(() => calls === 1);
  });
});
