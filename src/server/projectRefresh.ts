import type { BoardThread, SnapshotProject } from '../shared/schema.js';
import { sourceThreadSchema, type SourceThread } from '../shared/summarySync.js';
import { LOCAL_REFRESH_LIMIT, recordedTurnNotice, type ProjectRefreshResult, type ProjectSourceCheck } from '../shared/projectRefresh.js';
import { NotFoundError, type BoardDatabase } from './database.js';
import type { SummaryJobs } from './summaryJobs.js';
import { sourceFingerprint } from './summaryJobs.js';
import type { ConversationBatch, ConversationColumn, ConversationRefreshResult } from '../shared/conversationHistory.js';
import { conversationHash } from './conversationStore.js';
import { extractConversationTurns } from './conversationEvidence.js';
import { CodexAccessRequiredError, requireCodexAccess, type CodexOperationGuard } from '../shared/codexAccess.js';
import { ProjectPagePausedError, requireProjectPageCheck, watchProjectPageCheck, type ProjectCheckOptions } from './projectPagePolicy.js';
import { matchingProjectDirectory } from './projectDirectory.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const COOLDOWN_MS = 15_000;
export interface ProjectSourceReader {
  listProjectThreads(cwd: string, cursor?: string, operation?: CodexOperationGuard): Promise<unknown>;
  readThread(threadId: string, operation?: CodexOperationGuard): Promise<unknown>;
  readRecentThread?(threadId: string, operation?: CodexOperationGuard): Promise<unknown>;
  readThreadMetadata?(threadId: string, operation?: CodexOperationGuard): Promise<unknown>;
  readConversationPage?(threadId: string, cursor?: string, operation?: CodexOperationGuard): Promise<unknown>;
}
export interface RefreshCandidate {
  threadKey: string; threadId: string; title: string; hostId: string | null;
  sourceUpdatedAt?: string; sidebarIndex?: number; known?: BoardThread;
}

/** Only the existing board supplies project identity and sidebar order. */
export class ProjectRefresh {
  private readonly pending = new Map<string, Promise<ProjectRefreshResult>>();
  private readonly recent = new Map<string, ProjectRefreshResult>();
  private disposed = false;
  private collection: Promise<unknown> = Promise.resolve();
  private accessEpoch = 0;
  private readonly unsubscribeAccess: () => void;
  constructor(private readonly db: BoardDatabase, private readonly reader: ProjectSourceReader,
    private readonly jobs: Pick<SummaryJobs, 'create' | 'list'> & Partial<Pick<SummaryJobs,'createConversations'>>, private readonly now = () => new Date()) {
    this.unsubscribeAccess = db.onCodexAccessChange(() => {
      const access = db.getCodexAccess();
      if (!access.localRead || !access.modelUse) { this.accessEpoch++; this.recent.clear(); }
    });
  }
  private assertAccess(epoch = this.accessEpoch): void {
    requireCodexAccess(this.db.getCodexAccess(), 'modelUse');
    if (epoch !== this.accessEpoch) throw new CodexAccessRequiredError('localRead');
  }
  private async withAccess<T>(epoch: number, work: (operation: CodexOperationGuard) => Promise<T>, pageCheck: () => void = () => {}): Promise<T> {
    const check = () => { this.assertAccess(epoch); pageCheck(); };
    check(); const abort = new AbortController();
    const unsubscribe = this.db.onCodexAccessChange(() => { try { this.assertAccess(epoch); } catch { abort.abort(); } });
    try { return await work({ check, signal: abort.signal }); }
    finally { unsubscribe(); }
  }

  async conversations(projectKey: string): Promise<ConversationRefreshResult> {
    this.assertAccess();
    const epoch = this.accessEpoch;
    const page = watchProjectPageCheck(this.db, projectKey);
    try {
    page.check();
    if (!this.db.getBoard().projects.some(p=>p.projectKey===projectKey)) throw new NotFoundError('找不到该项目。');
    if (!this.db.conversations.enabled(projectKey)) {
      this.db.conversations.enable(projectKey);
      // A click may open the new view while the old six-turn collection runs.
      // Wait only for that bounded read, then initialize the twenty-turn view.
      await this.pending.get(projectKey);
      this.assertAccess(epoch);
      page.check();
      this.recent.delete(projectKey);
    }
    const result = await this.refresh(projectKey);
    return {projectKey,job:result.job,gaps:result.gaps};
    } finally { page.dispose(); }
  }
  async earlier(projectKey: string, threadKey: string, cursor: string): Promise<ConversationRefreshResult> {
    this.assertAccess();
    const epoch = this.accessEpoch;
    const page = watchProjectPageCheck(this.db, projectKey);
    const work = this.collection.then(() => this.withAccess(epoch, async operation => {
      this.assertAccess(epoch);
      page.check();
      const thread = this.db.getBoard().threads.find(t=>t.projectKey===projectKey && t.threadKey===threadKey);
      if (!thread || !isLocalCodex(thread)) throw new NotFoundError('找不到可读取的本地对话。');
      const metadata = this.db.conversations.metadata(threadKey);
      if (!metadata || metadata.nextCursor !== cursor || !this.reader.readConversationPage || !this.jobs.createConversations) throw new Error('更早页面入口已变化，请刷新对话历程后再试。');
      const checkedAt = this.now().toISOString();
      let payload:unknown;
      try { payload=await this.reader.readConversationPage(thread.threadId,cursor,operation); }
      catch(error) { this.assertAccess(epoch); page.check(); return {projectKey,job:null,gaps:[sourceReadFailure(error)]}; }
      this.assertAccess(epoch);
      page.check();
      const batches = this.prepareConversations(projectKey,knownCandidate(thread),payload,checkedAt,true);
      return {projectKey,job:this.jobs.createConversations(batches,this.db.getSummarySettings()),gaps:this.db.conversations.metadata(threadKey)?.coverage ?? []};
    }, page.check)).finally(page.dispose);
    this.collection = work.catch(()=>undefined);
    return work;
  }
  private prepareConversations(projectKey: string,candidate:RefreshCandidate,payload:unknown,checkedAt:string,older:boolean,recapSource?:SourceThread): ConversationBatch[] {
    const extracted = extractConversationTurns(payload,candidate.threadId);
    const overlap=extracted.turns.some(turn=>this.db.conversations.hasTurn(candidate.threadKey,turn.turnId));
    const prepared = this.db.conversations.prepare(candidate.threadKey,extracted.turns,older);
    const prior = this.db.conversations.metadata(candidate.threadKey);
    const resetCursor=!prior || !older && !overlap && prepared.length>0;
    const nextCursor = resetCursor ? extracted.nextCursor : prior!.nextCursor;
    const column: Omit<ConversationColumn,'turns'> = {threadKey:candidate.threadKey,title:candidate.title,
      sourceUpdatedAt:sourceTimestamp(record(record(payload).thread).updatedAt) ?? candidate.sourceUpdatedAt ?? null,
      checkedAt,nextCursor,cursorBeforeTurnId:resetCursor ? prepared[0]?.turnId ?? null : prior?.cursorBeforeTurnId,
      hasEarlier:nextCursor !== null,coverage:[`本次读取 ${prepared.length} 回合；较早内容按需读取。`,...(!older && prior && !overlap ? ['两次读取之间可能有未覆盖回合，可向上继续读取；未跨缺口折叠。'] : []),...extracted.gaps]};
    this.db.conversations.updateColumn(projectKey,column);
    const changed = prepared.filter(t=>!this.db.conversations.cached(candidate.threadKey,t));
    const batches: ConversationBatch[] = []; let chunk: typeof changed = []; let chars=0;
    const flush = () => {
      if (!chunk.length) return;
      const context = this.db.conversations.page(candidate.threadKey,chunk[0]!.ordinal,4);
      const fingerprint = conversationHash(chunk.map(t=>[t.turnId,t.fingerprint]));
      batches.push({conversationKey:`turns:${candidate.threadKey}:${chunk[0]!.turnId}`,projectKey,threadKey:candidate.threadKey,title:candidate.title,
        sourceUpdatedAt:column.sourceUpdatedAt,checkedAt,fingerprint,turns:chunk,context}); chunk=[];chars=0;
    };
    for (const turn of changed) { const size = turn.evidence.reduce((n,e)=>n+e.text.length,0); if (chars+size>40000 || chunk.length>=10) flush(); chunk.push(turn);chars+=size; } flush();
    if (older && prior?.nextCursor) {
      const page={cursor:prior.nextCursor,nextCursor:extracted.nextCursor,beforeTurnId:prepared[0]?.turnId ?? prior.cursorBeforeTurnId ?? null,turns:prepared.map(t=>({turnId:t.turnId,fingerprint:t.fingerprint}))};
      for (const batch of batches) batch.olderPage=page;
      if (!batches.length) this.db.conversations.finishOlderPage(projectKey,candidate.threadKey,page);
    }
    // Reuse the same model call for the ordinary current recap. Earlier pages
    // deliberately never rewrite the current project stop point.
    if (recapSource && this.db.getBoard().threads.find(t=>t.threadKey===candidate.threadKey)?.recap?.sourceFingerprint !== sourceFingerprint(recapSource)) {
      if (!batches.length) batches.push({conversationKey:`turns:${candidate.threadKey}:recap`,projectKey,threadKey:candidate.threadKey,title:candidate.title,
        sourceUpdatedAt:column.sourceUpdatedAt,checkedAt,fingerprint:sourceFingerprint(recapSource),turns:[],context:[]});
      const last = batches.at(-1)!; last.recapSource=recapSource; last.fingerprint=conversationHash([last.fingerprint,sourceFingerprint(recapSource)]);
    }
    return batches;
  }

  refresh(projectKey: string, options: ProjectCheckOptions = {}): Promise<ProjectRefreshResult> {
    if (this.disposed) return Promise.reject(new Error('看板正在关闭。'));
    try { this.assertAccess(); requireProjectPageCheck(this.db, projectKey, options); } catch (error) { return Promise.reject(error); }
    const epoch = this.accessEpoch;
    const pending = this.pending.get(projectKey);
    if (pending) return pending;
    const recent = this.recent.get(projectKey);
    if (recent) {
      const job = recent.job ? this.jobs.list().find(job => job.id === recent.job!.id) ?? recent.job : null;
      // A summary can outlive the click cooldown. Reuse its real state instead
      // of creating an empty "complete/skipped" job while it still runs.
      const inFlight = job && (['queued', 'running'].includes(job.state) || job.state === 'paused' && !job.needsResubmit);
      const stillFresh = this.now().getTime() - Date.parse(recent.checkedAt) < COOLDOWN_MS;
      if (inFlight || stillFresh && (options.automatic || ['updated', 'unchanged'].includes(this.db.projectChecks.get(projectKey).outcome))) {
        return Promise.resolve({ ...recent, job });
      }
    } else {
      const receipt = this.db.projectChecks.get(projectKey);
      if (receipt.outcome === 'checking' && receipt.jobId && receipt.attemptedAt) {
        const job = this.jobs.list().find(item => item.id === receipt.jobId && ['running', 'queued'].includes(item.state));
        const needsConversationHistory = this.reader.readConversationPage && this.jobs.createConversations && this.db.conversations.enabled(projectKey);
        if (job && (!needsConversationHistory || job.kind === 'conversations')) return Promise.resolve({ projectKey, checkedAt: receipt.attemptedAt, scope: 'local-codex', readCount: receipt.readCount,
          sources: receipt.sources, limitedExcerpts: receipt.limitedExcerpts, gaps: [], job });
      }
    }
    const page = watchProjectPageCheck(this.db, projectKey, options);
    const work = this.collection.then(() => this.collect(projectKey, epoch, options, page.check)).then(result => {
      this.assertAccess(epoch);
      if (!this.disposed) {
        this.recent.set(projectKey, result);
        if (this.recent.size > 100) this.recent.delete(this.recent.keys().next().value!);
      }
      return result;
    }).finally(() => { page.dispose(); this.pending.delete(projectKey); });
    this.pending.set(projectKey, work);
    this.collection = work.catch(() => undefined);
    return work;
  }

  dispose(): void { this.disposed = true; this.unsubscribeAccess(); this.recent.clear(); }

  private async collect(projectKey: string, epoch: number, options: ProjectCheckOptions, pageCheck: () => void): Promise<ProjectRefreshResult> {
    return this.withAccess(epoch, async operation => {
      const board = this.db.getBoard();
      const project = board.projects.find(project => project.projectKey === projectKey);
      if (!project) throw new NotFoundError('找不到该项目。');
      const checkedAt = this.now().toISOString();
      const token = options.automatic ? null : this.db.getAutoCheck().recoveryToken ?? null;
      this.db.projectChecks.begin(projectKey, checkedAt, token);
      try {
        const result = await this.collectGuarded(project, board.threads, checkedAt, operation, options,
          () => { this.assertAccess(epoch); pageCheck(); });
        if (!this.disposed) {
          const job = result.job?.id ? this.jobs.list().find(job => job.id === result.job!.id) ?? result.job : null;
          this.db.projectChecks.collected(result, job);
        }
        return result;
      } catch (error) {
        if (!this.disposed) this.db.projectChecks.failed(projectKey, checkedAt,
          error instanceof CodexAccessRequiredError ? error.code : error instanceof ProjectPagePausedError ? 'interrupted' : 'read_failed');
        throw error;
      }
    }, pageCheck);
  }
  private async collectGuarded(project: SnapshotProject, threads: BoardThread[], checkedAt: string, operation: CodexOperationGuard, options: ProjectCheckOptions, checkCollection: () => void): Promise<ProjectRefreshResult> {
    const { projectKey } = project;
    const projectThreads = threads.filter(thread => thread.projectKey === projectKey);
    const gaps: string[] = [];
    const result: ProjectRefreshResult = { projectKey, checkedAt, scope: 'local-codex', readCount: 0, gaps, coverageComplete: false, job: null };
    const localProject = project.hostId === undefined || project.hostId === 'local';
    if (!localProject) {
      gaps.push('此项目位于远程主机；本地读取不能替代远程来源，请使用 Codex 全源同步。');
      return result;
    }
    const local = projectThreads.filter(isLocalCodex);
    if (local.length < projectThreads.length) gaps.push('本次不读取远程、ChatGPT 或来源不明的任务；原有近况保留，请使用全源同步补全。');
    const candidates = new Map(local.map(thread => [thread.threadId, knownCandidate(thread)]));
    const listedIds = new Set<string>();
    let listTruncated = false;
    let scopeComplete = Boolean(project.cwd);
    if (project.cwd) {
      const cursors = new Set<string>();
      let cursor: string | undefined;
      try {
        for (let page = 0; page < 2; page++) {
          checkCollection();
          const payload = record(await this.reader.listProjectThreads(project.cwd, cursor, operation));
          checkCollection();
          if (!Array.isArray(payload.data)) throw new Error('Unsupported list response.');
          if (payload.data.length > 50) listTruncated = true;
          for (const raw of payload.data.slice(0, 50)) {
            const item = record(raw); const id = text(item.id);
            if (!id || !matchingProjectDirectory(project.cwd, item.cwd) || project.projectId && item.projectId && item.projectId !== project.projectId ||
              item.parentThreadId || item.forkedFromId && item.source === 'subAgent') continue;
            const known = threads.find(thread => thread.threadId === id && isLocalCodex(thread));
            if (known && known.projectKey !== projectKey) continue;
            listedIds.add(id);
            const existing = candidates.get(id);
            candidates.set(id, {
              threadKey: existing?.threadKey ?? `codex:local:${id}`, threadId: id,
              hostId: existing ? existing.hostId : 'local',
              title: text(item.name) || text(item.title) || existing?.title || '本地 Codex 对话',
              sourceUpdatedAt: sourceTimestamp(item.updatedAt ?? item.updated_at) || existing?.sourceUpdatedAt,
              sidebarIndex: existing?.sidebarIndex, known: existing?.known
            });
          }
          const next = text(payload.nextCursor);
          if (!next) break;
          if (page === 1 || cursors.has(next)) { listTruncated = true; break; }
          cursors.add(next); cursor = next;
        }
        if (!listedIds.size && local.length) { scopeComplete = false; gaps.push('本地索引未列出已关联任务；继续按已知来源读取，新对话发现可能不完整，请用全源同步补全。'); }
      } catch (error) {
        if (error instanceof CodexAccessRequiredError || error instanceof ProjectPagePausedError) throw error;
        scopeComplete = false;
        gaps.push(`本地任务目录读取失败或格式不受支持：${sourceReadFailure(error)}；仅尝试已知的本地任务，不将缺席视为删除。`);
      }
    } else gaps.push('项目缺少确切工作目录；只读取已关联的本地任务，不按标题猜测新任务。');
    if (listTruncated) gaps.push('本地目录超过两页或游标异常；本次候选列表不完整。');
    // Index absence is not inactivity. Compare fresh metadata for known IDs
    // before spending the three-conversation body budget, or an old cached date
    // can permanently starve a recently used but unlisted conversation.
    const unlisted = [...candidates.values()].filter(candidate => candidate.known && !listedIds.has(candidate.threadId));
    if (unlisted.length && !this.reader.readThreadMetadata) scopeComplete = false;
    if (unlisted.length && this.reader.readThreadMetadata) {
      gaps.push(`本地索引未列出 ${unlisted.length} 条已关联任务；按已知 ID 补查元数据，不把缺席当成无活动。`);
      const bounded = unlisted.sort((a, b) => (b.sourceUpdatedAt || '').localeCompare(a.sourceUpdatedAt || '')).slice(0, 12);
      for (const candidate of bounded) {
        if (this.disposed) return result;
        checkCollection();
        try {
          const metadata = record(record(await this.reader.readThreadMetadata(candidate.threadId, operation)).thread);
          checkCollection();
          if (sourceIdentityIssue(metadata, candidate.threadId, project)) throw new Error('Source identity mismatch.');
          const updated = sourceTimestamp(metadata.updatedAt ?? metadata.updated_at);
          if (updated && (!candidate.sourceUpdatedAt || Date.parse(updated) > Date.parse(candidate.sourceUpdatedAt))) candidate.sourceUpdatedAt = updated;
        } catch (error) { if (error instanceof CodexAccessRequiredError || error instanceof ProjectPagePausedError) throw error; scopeComplete = false; gaps.push(`任务 ${candidate.threadId} 的元数据补查未完成：${sourceReadFailure(error)}；排序仍可能不完整。`); }
      }
      if (unlisted.length > bounded.length) { scopeComplete = false; gaps.push('已关联但未列出的任务超过 12 条元数据预算，未检查部分的排序可能陈旧。'); }
    }
    const sorted = [...candidates.values()].sort((a, b) => (b.sourceUpdatedAt || '').localeCompare(a.sourceUpdatedAt || '') || a.threadKey.localeCompare(b.threadKey));
    if (sorted.length > LOCAL_REFRESH_LIMIT) gaps.push(`本次只读最近 ${LOCAL_REFRESH_LIMIT} 条本地对话；另外 ${sorted.length - LOCAL_REFRESH_LIMIT} 条保留原近况。`);
    const sources: SourceThread[] = [];
    const conversationBatches: ConversationBatch[] = [];
    const conversationsEnabled = this.db.conversations.enabled(projectKey) && Boolean(this.reader.readConversationPage) && Boolean(this.jobs.createConversations);
    const checks: ProjectSourceCheck[] = sorted.map(candidate => ({ threadKey: candidate.threadKey, title: candidate.title,
      discovered: !candidate.known, sourceUpdatedAt: candidate.sourceUpdatedAt, state: 'not-read', reason: '超出本次最近 3 条的读取范围；尚未总结。' }));
    result.sources = checks;
    checkCollection();
    // Register discovery before the model runs: a failed or paused summary must
    // not hide a real new conversation. This is semantic state, not canvas history.
    this.db.registerDiscoveredThreads(sorted.filter(candidate => !candidate.known).map(candidate => ({
      threadKey: candidate.threadKey, threadId: candidate.threadId, projectKey, sourceKind: 'codex',
      hostId: candidate.hostId ?? undefined, title: candidate.title, cwd: project.cwd,
      sourceUpdatedAt: candidate.sourceUpdatedAt, observedAt: checkedAt, runtimeState: 'unknown',
      workState: 'insufficient_evidence', humanAction: 'none', actionStrength: 'none', confidence: 'low',
      stopPoint: '已发现此对话，尚未取得可追溯的总结；不代表没有进展。',
      evidence: '按本机目录与项目工作目录精确关联；仅发现元数据，内容与下一步尚待核验。'
    })));
    for (const candidate of sorted.slice(0, LOCAL_REFRESH_LIMIT)) {
      if (this.disposed) return result;
      checkCollection();
      const check = checks.find(check => check.threadKey === candidate.threadKey)!;
      try {
        // The production client always provides bounded paging. The original
        // read-only method remains injectable for older synthetic adapters.
        const payload = conversationsEnabled ? await this.reader.readConversationPage!(candidate.threadId, undefined, operation) : this.reader.readRecentThread
          ? await this.reader.readRecentThread(candidate.threadId, operation)
          : await this.reader.readThread(candidate.threadId, operation);
        checkCollection();
        const extracted = extractRefreshEvidence(payload, candidate, project, checkedAt);
        if (!extracted.source) scopeComplete = false;
        if (extracted.gaps.length) result.limitedExcerpts = true;
        if (conversationsEnabled && extracted.source) {
          let chars=0;
          const evidence=extracted.source.evidence.toReversed().filter(e=>{ if (chars+e.text.length>20000) return false; chars+=e.text.length; return true; }).reverse();
          if (evidence.length < extracted.source.evidence.length) { result.limitedExcerpts = true; extracted.source={...extracted.source,evidence,readReason:`${extracted.source.readReason}近况正文另外限制为两万字内。`}; }
        }
        check.state = extracted.source ? 'read' : 'unavailable';
        check.latestTurnNotice = extracted.latestTurnNotice;
        check.reason = extracted.gaps.join(' ') || '已读取有界正文，摘要状态见更新进度。';
        check.sourceUpdatedAt = sourceTimestamp(record(record(payload).thread).updatedAt) || candidate.sourceUpdatedAt;
        if (extracted.source) {
          check.evidenceLatestAt = extracted.source.evidence.map(e => e.occurredAt).sort().at(-1);
          check.evidenceFingerprint = sourceFingerprint(extracted.source);
          sources.push(extracted.source); result.readCount++;
        }
        if (conversationsEnabled && !sourceIdentityIssue(record(record(payload).thread),candidate.threadId,project)) conversationBatches.push(...this.prepareConversations(projectKey,candidate,payload,checkedAt,false,extracted.source ?? undefined));
        gaps.push(...extracted.gaps);
      } catch (error) {
        if (error instanceof CodexAccessRequiredError || error instanceof ProjectPagePausedError) throw error;
        scopeComplete = false;
        check.state = 'unavailable'; check.reason = sourceReadFailure(error);
        gaps.push(record(error).code === 'recent_paging_unavailable'
          ? `任务 ${candidate.threadId} 的有界回合分页不可用；未回退完整历史，保留原近况。`
          : `任务 ${candidate.threadId} 无法读取：${sourceReadFailure(error)}；保留原近况。`);
      }
    }
    if (!sorted.length) gaps.push('未发现可确认归属的本地 Codex 对话；请运行全源同步建档。');
    gaps.push('范围为本项目的本地持久化记录，不证明 Desktop 实时运行状态，也不覆盖远程或 ChatGPT。');
    result.gaps = [...new Set(gaps)].slice(0, 100);
    result.coverageComplete = scopeComplete && !listTruncated && result.readCount > 0;
    checkCollection();
    if (sources.length && !this.disposed) {
      // Preserve the native project metadata and order; never import a synthetic cwd project.
      const { projectKey: key, projectId, hostId, name, cwd, sidebarIndex, observedAt } = project;
      const bundle = { schemaVersion: 1 as const, generatedAt: checkedAt,
        projects: [{ projectKey: key, projectId, hostId, name, cwd, sidebarIndex, observedAt }], threads: sources,
        coverage: { projectsFound: 1, threadsFound: sorted.length, deepRead: sources.length, fileChecked: 0,
          truncated: listTruncated || sorted.length > LOCAL_REFRESH_LIMIT || sources.some(source => !source.readComplete), inaccessible: result.gaps }
      };
      if (conversationsEnabled) {
        this.db.prepareEvidence(bundle,new Map(sources.map(s=>[s.threadKey,sourceFingerprint(s)])));
        result.job=this.jobs.createConversations!(conversationBatches,this.db.getSummarySettings(),options);
      } else result.job = this.jobs.create(bundle, this.db.getSummarySettings(), false, options);
    }
    if (!sources.length && conversationsEnabled && conversationBatches.length) result.job=this.jobs.createConversations!(conversationBatches,this.db.getSummarySettings(),options);
    return result;
  }
}

/** Never expose raw RPC errors: they may contain source paths or private text. */
export function sourceReadFailure(error: unknown): string {
  const code = record(error).code;
  if (code === 'executable_required' || code === 'ENOENT') return '找不到本机 Codex 可执行程序，请检查桌面安装或 CODEX_CLI_PATH';
  if (code === 'recent_paging_unavailable') return '当前运行时不支持本次有界读取';
  if (code === 'turn_exceeds_read_limit') return '单个对话回合仍超过 16 MB，本次未能读取';
  if (code === 'codex_response_too_large') return 'Codex 返回的记录超过单次读取上限';
  if (error instanceof Error && /^(initialize|thread\/list|thread\/read|thread\/turns\/list) timed out\.$/.test(error.message)) return '本机 Codex 读取超时，请稍后重试';
  return '本机读取未完成，未使用旧内容伪装更新';
}

export function isLocalCodex(thread: Pick<BoardThread, 'sourceKind' | 'hostId'>): boolean {
  return thread.sourceKind === 'codex' && (thread.hostId === undefined || thread.hostId === 'local');
}
function knownCandidate(thread: BoardThread): RefreshCandidate {
  return { threadKey: thread.threadKey, threadId: thread.threadId, title: thread.title,
    hostId: thread.hostId ?? null, sourceUpdatedAt: thread.sourceUpdatedAt, sidebarIndex: thread.sidebarIndex, known: thread };
}

export function sourceTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const date = new Date(value >= 1e12 ? value : value * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/i.test(value)) return undefined;
  const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function sourceIdentityIssue(raw: RecordValue, threadId: string, project: SnapshotProject): string | null {
  if (raw.id !== threadId || project.projectId && typeof raw.projectId === 'string' && raw.projectId !== project.projectId) return '返回身份不匹配';
  return typeof raw.cwd === 'string' && project.cwd && !matchingProjectDirectory(project.cwd, raw.cwd) ? '工作目录不匹配' : null;
}

/** Never promote a thread update time into an item's event date. */
export function extractRefreshEvidence(payload: unknown, candidate: RefreshCandidate, project: SnapshotProject, checkedAt: string): { source: SourceThread | null; gaps: string[]; latestTurnNotice?: string } {
  const raw = record(record(payload).thread); const gaps: string[] = [];
  const page = record(record(payload).recentRead ?? record(payload).conversationRead);
  const attachmentGaps = page.attachmentGaps;
  if (typeof page.gap === 'string') gaps.push(page.gap);
  if (Array.isArray(attachmentGaps)) gaps.push(...attachmentGaps.filter((gap): gap is string => typeof gap === 'string').slice(0, 6));
  let latestTurnNotice: string | undefined;
  const fail = (reason: string) => ({ source: null, latestTurnNotice, gaps: [...gaps, `任务 ${candidate.threadId}：${reason}；保留原近况。`] });
  const identityIssue = sourceIdentityIssue(raw, candidate.threadId, project);
  if (identityIssue) return fail(identityIssue);
  const updatedAt = sourceTimestamp(raw.updatedAt ?? raw.updated_at) || candidate.sourceUpdatedAt;
  if (!updatedAt) return fail('缺少可核验的来源更新时间');
  const turns = Array.isArray(raw.turns) ? raw.turns.map(record) : [];
  if (!turns.length) return fail('没有返回可读取的回合内容');
  // An empty/interrupted tail is a coverage gap, not a veto on earlier dated
  // evidence. Keep original item dates; never promote activity time to delivery.
  const latest = turns.at(-1)!;
  latestTurnNotice = recordedTurnNotice(latest.status) || undefined;
  let clipped = false;
  let removed = false; let omittedDate = false;
  const collectTurn = (turn: RecordValue): SourceThread['evidence'] => {
    const turnId = text(turn.id); if (!turnId) return [];
    const items = Array.isArray(turn.items) ? turn.items.map(record) : [];
    const lastAssistant = items.findLast(item => item.type === 'agentMessage');
    return items.flatMap(item => {
      const user = item.type === 'userMessage';
      const assistant = item.type === 'agentMessage' && (item.phase === 'final_answer' || item.phase == null && item === lastAssistant && turn.status === 'completed');
      if (!user && !assistant) return [];
      const itemId = text(item.id); if (!itemId) return [];
      const id = `${turnId}:${itemId}`;
      const occurredAt = sourceTimestamp(item.createdAt ?? item.created_at ?? item.timestamp)
        || sourceTimestamp(user ? turn.startedAt ?? turn.started_at : turn.completedAt ?? turn.completed_at)
        || candidate.known?.recap?.sources.find(source => source.id === id)?.occurredAt;
      if (!occurredAt) { omittedDate = true; return []; }
      const original = user ? (Array.isArray(item.content) ? item.content.map(part => record(part)).filter(part => part.type === 'text').map(part => typeof part.text === 'string' ? part.text : '').join('\n') : typeof item.text === 'string' ? item.text : '') : typeof item.text === 'string' ? item.text : '';
      const sanitized = cleanEvidenceText(original);
      if (sanitized !== original.trim()) removed = true;
      if (!sanitized) return [];
      if (sanitized.length > 7000) clipped = true;
      return [{ id, role: user ? 'user' as const : 'assistant' as const, occurredAt, turnId, path: null, text: sanitized.slice(0, 7000) }];
    });
  };
  const latestEvidence = collectTurn(latest);
  // Empty tails can be shown as source observations but cannot support a cited stop point.
  const tailNotice = latestEvidence.length ? latestTurnNotice : undefined;
  const tailGap = !latestEvidence.length
    ? '最新回合没有可用的带日期正文；以下仅覆盖此前有效内容，不能据此判断最后回合的成果或下一步。' : '';
  let window = turns.slice(-6); let evidence = window.flatMap(collectTurn);
  if (evidence.length < 2 && turns.length > 6) { window = turns.slice(-12); evidence = window.flatMap(collectTurn); }
  // Keep the newest evidence under the character/item budget, then restore chronology.
  const retained: SourceThread['evidence'] = []; const ids = new Set<string>(); let chars = 0;
  for (const entry of evidence.toReversed()) {
    if (ids.has(entry.id)) continue;
    if (retained.length >= 60 || chars + entry.text.length > 60000) { clipped = true; continue; }
    ids.add(entry.id); retained.push(entry); chars += entry.text.length;
  }
  retained.reverse();
  if (!retained.length) return fail('有界回合内没有可用的带日期正文');
  if (tailGap) gaps.push(`任务 ${candidate.threadId}：${tailGap}`);
  if (omittedDate) gaps.push(`任务 ${candidate.threadId} 的部分条目缺少真实时间，未送入总结。`);
  if (clipped) gaps.push(`任务 ${candidate.threadId} 的正文超过长度预算，已截取；摘要不覆盖全部文字。`);
  const parsed = sourceThreadSchema.safeParse({
    threadKey: candidate.threadKey, threadId: candidate.threadId, projectKey: project.projectKey,
    hostId: candidate.hostId, sourceKind: 'codex', title: text(raw.name) || text(raw.title) || candidate.title,
    // This reader uses a separate App Server. Even its 'active' is not Desktop activity.
    sidebarIndex: candidate.sidebarIndex, sourceUpdatedAt: updatedAt, evidenceCheckedAt: checkedAt, runtimeState: 'unknown',
    readComplete: false, // Bounded excerpts never imply complete historical coverage.
    requestOnlyTurnId: latestEvidence.length && latestEvidence.every(e => e.role === 'user') ? latestEvidence[0]!.turnId : undefined,
    readReason: `本次只读本地持久化记录最近 ${window.length} 个回合的用户正文与最终回复；粘贴文本仅作用户请求，事件时间取原始条目，不代表 Desktop 实时状态。${tailNotice ? `最新回合：${tailNotice}` : ''}${tailGap}${removed ? '已移除环境块或疑似凭据。' : ''}${omittedDate ? '无时间条目未覆盖。' : ''}${clipped ? '正文超出预算已截取，不覆盖全部文字。' : ''}${Array.isArray(attachmentGaps) && attachmentGaps.length ? '部分粘贴文本附件未覆盖，不能推断其内容。' : ''}${typeof page.gap === 'string' ? page.gap : ''}`,
    evidence: retained
  });
  return parsed.success ? { source: parsed.data, latestTurnNotice, gaps } : fail('来源数据不满足有界证据格式');
}

export function cleanEvidenceText(input: string): string {
  let value = input;
  const request = value.indexOf('## My request:');
  if (request >= 0) value = value.slice(request + '## My request:'.length);
  else if (/^\s*# AGENTS\.md instructions\b/i.test(value)) return '';
  value = value.replace(/<(environment_context|skills_instructions|recommended_plugins|app-context)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/data:[^\s;]+;base64,[A-Za-z0-9+/=]+/g, '[附件已省略]');
  return value.split(/\r?\n/).map(line => /\bsk-[A-Za-z0-9_-]{12,}|\bBearer\s+\S+|(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[=:]\s*\S+/i.test(line) ? '[疑似凭据已移除]' : line).join('\n').trim();
}
