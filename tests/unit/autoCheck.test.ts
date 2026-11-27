import { afterEach, describe, expect, it } from 'vitest';
import { BoardDatabase } from '../../src/server/database.js';
import { AutoCheck } from '../../src/server/autoCheck.js';
import { bundle, time } from '../fixtures/summary.js';
import type { ProjectRefreshResult } from '../../src/shared/projectRefresh.js';
import { grantSyntheticCodexAccess } from '../fixtures/codexAccess.js';
const dbs: BoardDatabase[] = []; const timers: AutoCheck[] = [];
afterEach(() => { timers.forEach(timer => timer.dispose()); dbs.forEach(db => db.close()); timers.length = dbs.length = 0; });
function setup() { const db = new BoardDatabase(':memory:'); grantSyntheticCodexAccess(db); db.saveAutoCheck({ ...db.getAutoCheck(), enabled: true }); dbs.push(db); const input = bundle([]); input.projects[0]!.cwd = 'E:/synthetic/project'; db.prepareEvidence(input, new Map()); return db; }
const result = (): ProjectRefreshResult => ({ projectKey: 'example', checkedAt: time, scope: 'local-codex', readCount: 1, gaps: [], job: null });
describe('service owned daily checks', () => {
  it('checks once at startup, coalesces callers, persists cadence and catches up once after long sleeps', async () => {
    const db = setup(); let clock = Date.parse(time); let count = 0;
    const scheduler = new AutoCheck(db, { refresh: async () => { count++; return result(); } }, { list: () => [] }, () => new Date(clock)); timers.push(scheduler);
    await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()]); expect(count).toBe(1);
    clock += 23 * 3600000; await scheduler.tick(); expect(count).toBe(1);
    scheduler.dispose(); const resumed = new AutoCheck(db, { refresh: async () => { count++; return result(); } }, { list: () => [] }, () => new Date(clock)); timers.push(resumed);
    await resumed.tick(); expect(count).toBe(1); clock += 4 * 86400000; await resumed.tick(); await resumed.tick(); expect(count).toBe(2);
    expect(db.getAutoCheck().nextCheckAt).toBe(new Date(clock + 86400000).toISOString());
  });
  it('allows manual checks when disabled, but does not automatically repeat failures', async () => {
    const db = setup(); let count = 0; const scheduler = new AutoCheck(db, { refresh: async () => { count++; throw new Error('private detail'); } }, { list: () => [] }); timers.push(scheduler);
    scheduler.setEnabled(false); await scheduler.tick(); expect(count).toBe(0);
    await scheduler.tick(true); expect(count).toBe(1); expect(scheduler.status().state).toBe('paused');
    await scheduler.tick(); expect(count).toBe(1); expect(JSON.stringify(scheduler.status())).not.toContain('private detail');
  });
  it.each([['tool_boundary_unverified', '安全'], ['quota_exhausted', '额度'], ['chatgpt_login_required', '登录']])('shows the actual reason and does not auto-resume %s', async (code, label) => {
    const db = setup(); let calls = 0;
    const scheduler = new AutoCheck(db, { refresh: async () => { calls++; return { ...result(), job: { id: 'x', state: 'paused', failures: [{ threadKey: 'a', code }], needsResubmit: true } as ProjectRefreshResult['job'] }; } }, { list: () => [] }); timers.push(scheduler);
    await scheduler.tick(); await scheduler.tick(); expect(calls).toBe(1); expect(scheduler.status().state).toBe('paused');
    expect(scheduler.status().message).toContain(label); expect(scheduler.status().nextCheckAt).toBeNull();
  });
  it('defers an account timeout by a day, preserves the retry count on restart and stops after two automatic retries', async () => {
    const db = setup(); let calls = 0; let clock = Date.parse(time); const day = 86400000;
    const job = { id: 'account-timeout', state: 'paused', failures: [{ threadKey: 'one', code: 'account_read_timeout' }], needsResubmit: true } as NonNullable<ProjectRefreshResult['job']>;
    const start = () => {
      const scheduler = new AutoCheck(db, { refresh: async () => { calls++; return { ...result(), job }; } }, { list: () => [job] }, () => new Date(clock));
      timers.push(scheduler); return scheduler;
    };
    let scheduler = start(); await scheduler.tick(); await scheduler.tick();
    expect(calls).toBe(1);
    expect(scheduler.status()).toMatchObject({ state: 'idle', failureCode: 'account_read_timeout', transientFailures: 1, nextCheckAt: new Date(clock + day).toISOString(), lastCompletedAt: null });
    expect(scheduler.status().message).toContain('账号信息超时'); expect(scheduler.status().message).not.toMatch(/登录|额度/);
    scheduler.dispose(); scheduler = start(); await scheduler.tick(); expect(calls).toBe(1);
    clock += day; await scheduler.tick(); await scheduler.tick(); expect(calls).toBe(2);
    clock += day; await scheduler.tick(); clock += day * 2; await scheduler.tick();
    expect(calls).toBe(3); expect(scheduler.status()).toMatchObject({ state: 'paused', transientFailures: 3, nextCheckAt: null });
  });
  it('recovers the cause and cadence of a legacy pause without inferring login failure', async () => {
    const db = setup(); const clock = Date.parse(time);
    const job = { id: 'old-job', state: 'paused', error: '应用已重启', needsResubmit: true, failures: [{ threadKey: 'one', code: 'account_read_timeout' }] } as NonNullable<ProjectRefreshResult['job']>;
    db.saveAutoCheck({ ...db.getAutoCheck(), state: 'paused', jobId: job.id, nextCheckAt: new Date(clock + 86400000).toISOString() });
    let calls = 0; const scheduler = new AutoCheck(db, { refresh: async () => { calls++; return result(); } }, { list: () => [job] }, () => new Date(clock)); timers.push(scheduler);
    await scheduler.tick(); expect(calls).toBe(0);
    expect(scheduler.status()).toMatchObject({ enabled: true, state: 'idle', failureCode: 'account_read_timeout', transientFailures: 1 });
  });
});
