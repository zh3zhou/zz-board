import type { BoardDatabase } from './database.js';
import { randomUUID } from 'node:crypto';
import type { ProjectRefresh } from './projectRefresh.js';
import type { SummaryJobs } from './summaryJobs.js';
import type { AutoCheckState } from '../shared/milestones.js';
import { CodexAccessRequiredError, requireCodexAccess } from '../shared/codexAccess.js';
import { ProjectPagePausedError, projectPagePauseReason } from './projectPagePolicy.js';
import { blockingCheckFailure, checkFailureMessage, transientProjectFailures } from '../shared/projectRefresh.js';
import type { SyncJob } from '../shared/summarySync.js';

const DAY = 24 * 60 * 60 * 1000;
const MAX_DEFERRED_RETRIES = 2;
const firstCheckMessage = '请先在一个项目的概览点「检查更新」。核对成功后，每日检查从下一周期继续。';
/** One timer owned by the existing service, never by a browser window. */
export class AutoCheck {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private disposed = false;
  private accessEpoch = 0;
  private readonly unsubscribeAccess: () => void;
  private readonly unsubscribeVerified: () => void;
  constructor(private readonly db: BoardDatabase, private readonly refresh: Pick<ProjectRefresh, 'refresh'>,
    private readonly jobs: Pick<SummaryJobs, 'list'>, private readonly now = () => new Date(), private readonly wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {
    let state = db.getAutoCheck();
    if (state.state === 'running') db.saveAutoCheck({ ...state, state: 'idle', jobId: null, message: '上次检查因应用退出中断，到期后再检查。' });
    if (state.state === 'paused' && !state.failureCode && state.jobId) {
      const job = jobs.list().find(item => item.id === state.jobId);
      const code = job && blockingCheckFailure(job);
      if (code) db.saveAutoCheck(this.afterFailure(state, code, state.nextCheckAt ?? this.nextCycle()));
    }
    let hadAccess = this.hasAccess();
    if (!hadAccess) this.holdDailyPreference();
    this.unsubscribeVerified = db.projectChecks.onVerified(token => this.resumeAfterProject(token));
    state = db.getAutoCheck();
    if (hadAccess && state.recoveryToken && db.projectChecks.hasVerified(state.recoveryToken)) this.resumeAfterProject(state.recoveryToken);
    this.unsubscribeAccess = db.onCodexAccessChange(() => {
      const allowed = this.hasAccess();
      if (!allowed) { this.accessEpoch++; this.holdDailyPreference(hadAccess); }
      else if (!hadAccess) this.holdDailyPreference();
      hadAccess = allowed;
    });
  }
  start(): void { if (this.timer || this.disposed) return; this.timer = setInterval(() => void this.tick(), 60_000); this.timer.unref(); void this.tick(); }
  status(): AutoCheckState {
    const state = this.db.getAutoCheck();
    if (!this.hasAccess()) return { ...state, state: state.enabled ? 'paused' : 'idle', message: `需要允许本机来源读取和模型调用。${state.enabled ? '已保留每日检查设置。' : ''}${state.failureCode ? '上次检查：' + checkFailureMessage(state.failureCode) : ''}` };
    return state.recoveryToken ? { ...state, state: 'paused', message: firstCheckMessage } : state;
  }
  private nextCycle(): string { return new Date(this.now().getTime() + DAY).toISOString(); }
  private holdDailyPreference(revoked = false): void {
    const state = this.db.getAutoCheck();
    if (!state.enabled || state.recoveryToken && !revoked) return;
    this.db.saveAutoCheck({ ...state, state: 'paused', recoveryToken: randomUUID(), nextCheckAt: null, message: firstCheckMessage });
  }
  private resumeAfterProject(token: string): void {
    const state = this.db.getAutoCheck();
    if (!state.enabled || state.recoveryToken !== token || !this.hasAccess()) return;
    this.db.saveAutoCheck({ ...state, state: 'idle', recoveryToken: null, failureCode: null, transientFailures: 0, jobId: null, nextCheckAt: this.nextCycle(),
      message: '已核对当前项目，每日检查将在下一周期继续。' });
  }
  private afterFailure(state: AutoCheckState, code: string, nextCheckAt: string): AutoCheckState {
    const transient = transientProjectFailures.has(code);
    const attempts = transient ? (state.transientFailures ?? 0) + 1 : 0;
    const defer = state.enabled && transient && attempts <= MAX_DEFERRED_RETRIES;
    return { ...state, state: defer ? 'idle' : 'paused', failureCode: code, transientFailures: attempts,
      nextCheckAt: defer ? nextCheckAt : null,
      message: checkFailureMessage(code) + (defer ? '下个每日检查周期再试。' : '已暂停，可处理后手动重试。') };
  }
  private hasAccess(): boolean { try { requireCodexAccess(this.db.getCodexAccess(), 'modelUse'); return true; } catch { return false; } }
  private assertAccess(epoch: number): void {
    requireCodexAccess(this.db.getCodexAccess(), 'modelUse');
    if (epoch !== this.accessEpoch) throw new CodexAccessRequiredError('modelUse');
  }
  setEnabled(enabled: boolean): AutoCheckState {
    if (enabled) requireCodexAccess(this.db.getCodexAccess(), 'modelUse');
    const current = this.db.getAutoCheck();
    if (current.enabled === enabled) return this.status();
    const value: AutoCheckState = { ...current, enabled, recoveryToken: null, failureCode: null, transientFailures: 0, state: current.state === 'running' ? 'running' : 'idle',
      message: enabled ? '已开启，到期后自动检查本机项目。' : '自动检查已关闭；已开始的单条总结可以完成。' };
    this.db.saveAutoCheck(value); if (enabled) void this.tick(); return this.status();
  }
  tick(force = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.hasAccess()) return force ? Promise.reject(new CodexAccessRequiredError(this.db.getCodexAccess().localRead ? 'modelUse' : 'localRead')) : Promise.resolve();
    if (this.pending) return this.pending;
    const value = this.status();
    if (value.recoveryToken) return Promise.resolve();
    if (!force && (!value.enabled || value.state === 'paused' || value.nextCheckAt && Date.parse(value.nextCheckAt) > this.now().getTime())) return Promise.resolve();
    this.pending = this.run(force).finally(() => { this.pending = undefined; }); return this.pending;
  }
  dispose(): void { this.disposed = true; this.unsubscribeAccess(); this.unsubscribeVerified(); clearInterval(this.timer); }
  private async run(force: boolean): Promise<void> {
    const epoch = this.accessEpoch;
    this.assertAccess(epoch);
    const board = this.db.getBoard();
    const active = new Set(board.nodes.filter(node => node.kind === 'task' && !node.archivedAt).map(node => node.projectKey));
    const projects = board.projects.filter(project => active.has(project.projectKey) && project.cwd && (!project.hostId || project.hostId === 'local') && !projectPagePauseReason(this.db, project.projectKey, { automatic: true }));
    const now = this.now();
    let state: AutoCheckState = { ...this.status(), state: 'running', lastStartedAt: now.toISOString(), nextCheckAt: new Date(now.getTime() + DAY).toISOString(),
      completedProjects: 0, totalProjects: projects.length, updatedThreads: 0, jobId: null, message: '正在检查近况，画布可以继续使用。' };
    this.db.saveAutoCheck(state);
    let partial = false;
    try {
      for (const project of projects) {
        if (this.disposed || !force && !this.status().enabled) break;
        this.assertAccess(epoch);
        if (projectPagePauseReason(this.db, project.projectKey, { automatic: true })) continue;
        let result;
        try { result = await this.refresh.refresh(project.projectKey, { automatic: true }); }
        catch (error) { if (error instanceof ProjectPagePausedError) continue; throw error; }
        if (this.disposed) return;
        this.assertAccess(epoch);
        partial ||= result.readCount === 0 || result.coverageComplete === false;
        state = { ...state, enabled: this.status().enabled, jobId: result.job?.id ?? null };
        this.db.saveAutoCheck(state);
        if (result.job) {
          const jobId = result.job.id;
          let job: SyncJob | undefined = this.jobs.list().find(job => job.id === jobId) ?? result.job;
          while (!this.disposed && job && ['queued', 'running'].includes(job.state)) {
            await this.wait(500);
            if (this.disposed) return;
            this.assertAccess(epoch);
            job = this.jobs.list().find(value => value.id === jobId);
          }
          if (this.disposed) return;
          const receipt = this.db.projectChecks.get(project.projectKey);
          const saved = receipt.jobId === jobId ? receipt : null;
          state.updatedThreads += job?.updatedThreadKeys?.length ?? saved?.updatedThreadKeys.length ?? 0;
          partial ||= job ? job.state !== 'complete' || saved?.outcome === 'partial' : !saved || !['updated', 'unchanged'].includes(saved.outcome);
          const code = job ? blockingCheckFailure(job) : saved?.failureCode;
          if (code) {
            this.db.saveAutoCheck(this.afterFailure({ ...state, enabled: this.status().enabled }, code, this.nextCycle()));
            return;
          }
        }
        state.completedProjects++; state.message = `已检查 ${state.completedProjects}/${state.totalProjects} 个项目，已更新 ${state.updatedThreads} 条对话。`;
        this.db.saveAutoCheck(state);
      }
      if (this.disposed) return;
      this.assertAccess(epoch);
      state.enabled = this.status().enabled;
      state = { ...state, state: 'idle', lastCompletedAt: this.now().toISOString(), jobId: null, failureCode: null, transientFailures: 0,
        message: `已检查 ${state.completedProjects} 个项目，已更新 ${state.updatedThreads} 条对话。${partial ? '部分近期内容未能核对。' : ''}` };
      this.db.saveAutoCheck(state);
    } catch (error) {
      if (this.disposed || error instanceof CodexAccessRequiredError) return;
      this.db.saveAutoCheck(this.afterFailure({ ...state, enabled: this.db.getAutoCheck().enabled, jobId: null }, 'read_failed', this.nextCycle()));
    }
  }
}
