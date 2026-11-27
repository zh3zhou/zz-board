import { DEFAULT_PAGE_ID, INITIAL_PAGE_NAME, pageId, type CanvasPageRecord } from '../shared/pages.js';
import { MAX_WALLPAPER_PRESETS, sameWallpaper, wallpaperImages, type ChangeWallpaper, type Wallpaper, type WallpaperPreset, type WallpaperPresetSummary } from '../shared/wallpaper.js';
import { DEFAULT_SKIN_KEY, LEGACY_SKIN_KEY } from '../shared/skin.js';
import { defaultPriorityIcons, type ChangePriorityIcons, type PriorityIcons } from '../shared/priorityIcons.js';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AnnotationRecord,
  BoardProjectBrief,
  BoardSnapshot,
  BoardState,
  BoardTodo,
  CanvasNodeRecord,
  DrawingPreferences,
  HistoryStatus,
  InkStrokeRecord,
  LocalLinkRecord,
  NodePriorityUpdate,
  ProjectBrief,
  SnapshotProject,
  SnapshotThread,
  SnapshotTodo,
  SkinComponents,
  SelectionAction,
  SelectionResult,
  TodoActionKind,
  TodoStrength
} from '../shared/schema.js';
import { localCalendarDate, noteScheduleSchema, priorityOnDate } from '../shared/notePriority.js';
import { findInboxPosition, initialTaskPosition, projectNodeId } from '../shared/layout.js';
import { snapshotDigest } from '../shared/snapshot.js';
import { drawingPreferencesSchema } from '../shared/schema.js';
import { getNoteFoldEligibility } from '../shared/noteFolding.js';
import { threadRecapSchema, type ThreadRecap } from '../shared/schema.js';
import { DEFAULT_SUMMARY_SETTINGS, type EvidenceBundle, type SourceThread, type SummarySettings, type SyncJob } from '../shared/summarySync.js';
import { projectProgress, threadSourceTime } from '../shared/projectProgress.js';
import { documentAssets, noteDocumentSchema, sameDisplayedContent, validateNoteContent, type MediaAsset, type NoteContent, type NoteContentHistory } from '../shared/noteDocument.js';
import { scaledNode, scaledInk, selectionScaleLimits } from '../shared/selectionScale.js';
import { TimelineStore } from './timelineStore.js';
import { readWeeklyReview, type ReviewWeek } from './weeklyReview.js';
import { ConversationStore } from './conversationStore.js';
import { ProjectCheckStore } from './projectCheckStore.js';
import type { ConversationBatch, ConversationSummary } from '../shared/conversationHistory.js';
import { initialAutoCheck, type AutoCheckState, type FileEvidence, type Milestone } from '../shared/milestones.js';
import { codexAccessSchema, initialCodexAccess, type CodexAccess } from '../shared/codexAccess.js';
import { codexThreadUuid, conversationNoteSourceSchema, type CaptureConversationNoteInput, type ConversationNoteReceipt, type ConversationNoteSource } from '../shared/conversationNote.js';
import { captureTarget, ConversationNoteError } from './conversationNoteCapture.js';

type SqlValue = string | number | bigint | null | Uint8Array;
type Row = Record<string, SqlValue>;
type NewNote = NoteContent & { notePresentation?: 'note' | 'image'; pageId?: string; title: string; x: number; y: number; width: number; height: number };

type HistoryTable = 'canvas_pages' | 'canvas_nodes' | 'annotations' | 'local_links' | 'ink_strokes' | 'settings';
interface HistoryChange {
  table: HistoryTable;
  key: string;
  /** Exact last content-changing save in a coalesced note edit; never used to replay the row. */
  lastContentEditAt?: string;
  before: Record<string, string | number | null> | null;
  after: Record<string, string | number | null> | null;
}

export interface InkBatchInput {
  creates: Array<Omit<InkStrokeRecord, 'id' | 'revision' | 'createdAt' | 'updatedAt'> & { id?: string }>;
  updates: Array<{ id: string; patch: Partial<Omit<InkStrokeRecord, 'id' | 'createdAt' | 'updatedAt'>> & { revision: number } }>;
  deletes: Array<{ id: string; revision: number }>;
}

export interface InkBatchResult {
  created: InkStrokeRecord[];
  updated: InkStrokeRecord[];
  deletedIds: string[];
  boardRevision: number;
}

export interface NodeBatchInput {
  updates: Array<{ id: string; patch: Record<string, unknown> & { revision: number } }>;
}

export interface ImportResult {
  digest: string;
  projectsSeen: number;
  threadsSeen: number;
  tasksCreated: number;
  tasksUpdated: number;
  positionsPreserved: number;
  ignoredOlder: number;
  projectBriefsSeen: number;
  todosSeen: number;
  todosCreated: number;
  todosUpdated: number;
  summariesIgnoredOlder: number;
}

export interface DemoCleanupResult {
  performed: boolean;
  backupPath: string | null;
  projectsRemoved: number;
  threadsRemoved: number;
  taskNodesRemoved: number;
}

export interface BoardDatabaseOptions {
  cleanupDemoData?: boolean;
}

export class BoardDatabase {
  private readonly db: DatabaseSync;
  private readonly databasePath: string;
  private readonly mutationListeners = new Set<(boardRevision: number) => void>();
  private readonly codexAccessListeners = new Set<() => void>();
  private codexAccessEpoch = 0;
  private lastTextEditRevision = -1;
  readonly startupDemoCleanup: DemoCleanupResult;
  readonly timeline: TimelineStore;
  readonly conversations: ConversationStore;
  readonly projectChecks: ProjectCheckStore;

  constructor(databasePath: string, options: BoardDatabaseOptions = {}) {
    this.databasePath = databasePath;
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const newBoard = !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='canvas_nodes'").get();
    this.migrate();
    this.timeline = new TimelineStore(this.db);
    this.conversations = new ConversationStore(this.db);
    this.projectChecks = new ProjectCheckStore(this.db);
    this.startupDemoCleanup = options.cleanupDemoData ? this.cleanupDemoDataOnce() : emptyDemoCleanup();
    this.migrateAppearanceV05(newBoard);
    this.migrateNoteBodiesV06();
    this.backfillLegacySummaries();
    this.backfillProjectNodes();
    if (!this.getSetting('timelineV09')) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const thread of this.getBoard().threads) if (thread.projectKey && thread.recap) this.timeline.recordRecap(thread.projectKey, thread.threadKey, thread.title, thread.sourceUpdatedAt ?? thread.observedAt, thread.recap, true);
        this.setSettingRaw('timelineV09', '1'); this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
  }

  close(): void {
    this.db.close();
  }

  isEmpty(): boolean {
    return Number((this.db.prepare('SELECT COUNT(*) AS total FROM canvas_nodes').get() as Row).total) === 0;
  }

  getBoardRevision(): number {
    return nonnegativeInteger(this.getSetting('boardRevision'));
  }

  getWeeklyReview(week:ReviewWeek, now = new Date()) {
    this.db.exec('SAVEPOINT weekly_review');
    try {
      const report = readWeeklyReview(this.db, week, now);
      this.db.exec('RELEASE weekly_review');
      return report;
    } catch (error) {
      this.db.exec('ROLLBACK TO weekly_review; RELEASE weekly_review');
      throw error;
    }
  }

  onMutation(listener: (boardRevision: number) => void): () => void {
    this.mutationListeners.add(listener);
    return () => this.mutationListeners.delete(listener);
  }

  getSummarySettings(): SummarySettings { return this.getJsonSetting('summarySettings', DEFAULT_SUMMARY_SETTINGS); }
  getSummaryEpoch(): number { return nonnegativeInteger(this.getSetting('summaryEpoch')); }
  saveSummarySettings(value: SummarySettings): void { this.setSettingRaw('summarySettings', JSON.stringify(value)); }
  getCodexAccess(): CodexAccess {
    const parsed = codexAccessSchema.safeParse(this.getJsonSetting('codexAccessV1', initialCodexAccess()));
    return parsed.success ? parsed.data : initialCodexAccess();
  }
  saveCodexAccess(value: CodexAccess): void {
    this.setSettingRaw('codexAccessV1', JSON.stringify(codexAccessSchema.parse(value)));
    this.codexAccessEpoch++;
    for (const listener of this.codexAccessListeners) listener();
  }
  onCodexAccessChange(listener: () => void): () => void {
    this.codexAccessListeners.add(listener); return () => this.codexAccessListeners.delete(listener);
  }
  getCodexAccessEpoch(): number { return this.codexAccessEpoch; }
  getAutoCheck(): AutoCheckState { return this.getJsonSetting('autoCheckV09', initialAutoCheck()); }
  hasProject(key: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM projects WHERE project_key=?').get(key)); }
  saveAutoCheck(value: AutoCheckState): void { this.setSettingRaw('autoCheckV09', JSON.stringify(value)); }
  commitConversations(batch: ConversationBatch, summaries: ConversationSummary[], epoch: number): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (epoch !== this.getSummaryEpoch() || !this.conversations.current(batch)) { this.db.exec('ROLLBACK'); return false; }
      const changed = this.conversations.commit(batch, summaries);
      const revision = changed ? this.bumpRevisionInTransaction() : null;
      this.db.exec('COMMIT'); if (revision !== null) this.emitMutation(revision); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  commitFileMilestones(file: FileEvidence, values: Milestone[], epoch: number): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (epoch !== this.getSummaryEpoch() || !this.timeline.fileCurrent(file)) { this.db.exec('ROLLBACK'); return false; }
      const changed = this.timeline.record({ projectKey: file.projectKey, sourceKey: file.fileKey, sourceLabel: file.label, sourceKind: 'file', threadKey: null,
        sourceUpdatedAt: file.sourceUpdatedAt, checkedAt: file.checkedAt, summarizedAt: new Date().toISOString() }, values, file.evidence.map(({ text: _text, ...value }) => value));
      this.timeline.finishFile(file);
      const revision = changed ? this.bumpRevisionInTransaction() : null;
      this.db.exec('COMMIT'); if (revision !== null) this.emitMutation(revision); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  saveSyncJob(job: SyncJob): void {
    // rowid is the persisted save order, including updates in the same millisecond.
    // A just-finished long-running job must not immediately age out of history.
    this.db.prepare('INSERT INTO sync_jobs(id, data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, rowid=(SELECT MAX(rowid)+1 FROM sync_jobs)').run(job.id, JSON.stringify(job));
    this.projectChecks.observeJob(job);
    this.db.prepare(`DELETE FROM sync_jobs WHERE json_extract(data, '$.state') IN ('complete','cancelled')
      AND id NOT IN (SELECT id FROM sync_jobs WHERE json_extract(data, '$.state') IN ('complete','cancelled') ORDER BY rowid DESC LIMIT 100)`).run();
  }
  getSyncJobs(): SyncJob[] { return (this.db.prepare('SELECT data FROM sync_jobs ORDER BY rowid DESC').all() as Row[]).map(row => JSON.parse(String(row.data)) as SyncJob); }

  /** Metadata-only discovery. Never overwrite an existing semantic record or
   * enter the user's undo journal; summaries may arrive later or fail entirely. */
  registerDiscoveredThreads(threads: SnapshotThread[]): void {
    if (!threads.length) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let changed = false;
      for (const thread of threads) {
        if (this.db.prepare('SELECT thread_key FROM threads WHERE thread_key=? OR (thread_id=? AND source_kind=? AND COALESCE(host_id,\'local\')=?)')
          .get(thread.threadKey, thread.threadId, thread.sourceKind, thread.hostId ?? 'local')) continue;
        if (!this.db.prepare('SELECT project_key FROM projects WHERE project_key=?').get(thread.projectKey ?? '')) throw new Error('Unknown discovery project.');
        this.upsertThread(thread); changed = true;
      }
      const revision = changed ? this.bumpRevisionInTransaction() : null;
      this.db.exec('COMMIT'); if (revision !== null) this.emitMutation(revision);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  prepareEvidence(bundle: EvidenceBundle, fingerprints: Map<string, string>, compatibleFingerprints = new Map<string, string>()): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const project of bundle.projects) {
        this.upsertProject(project);
        if (!this.db.prepare('SELECT project_key FROM project_briefs WHERE project_key=?').get(project.projectKey)) this.upsertProjectBrief({
          projectKey: project.projectKey, overview: '已建档，等待可追溯的对话近况。', currentStage: '证据待补全', workState: 'insufficient_evidence',
          stopPoint: '尚未生成近况；不代表没有进展。', codexOrExternalNext: '暂无明确下一步', evidenceLevel: 'none',
          evidenceReason: '全源采集仅覆盖当前可访问记录。', confidence: 'low', observedAt: bundle.generatedAt
        });
      }
      this.ensureProjectNodes();
      for (const source of bundle.threads) {
        const current = this.db.prepare('SELECT * FROM threads WHERE thread_key=?').get(source.threadKey) as Row | undefined;
        if (current && (String(current.thread_id) !== source.threadId || String(current.source_kind) !== source.sourceKind ||
          String(current.host_id ?? '') !== String(source.hostId ?? '') || String(current.project_key) !== source.projectKey)) throw new Error('Source identity changed; refuse to merge.');
        const expected = this.db.prepare('SELECT source_updated_at,evidence_checked_at FROM sync_sources WHERE thread_key=?').get(source.threadKey) as Row | undefined;
        const updated = Date.parse(source.sourceUpdatedAt);
        if ((expected && (Date.parse(String(expected.source_updated_at)) > updated ||
          (Date.parse(String(expected.source_updated_at)) === updated && Date.parse(String(expected.evidence_checked_at)) > Date.parse(source.evidenceCheckedAt)))) ||
          (current?.source_updated_at && Date.parse(String(current.source_updated_at)) > updated)) continue;
        this.db.prepare(`INSERT INTO sync_sources(thread_key,fingerprint,source_updated_at,evidence_checked_at,runtime_state) VALUES (?,?,?,?,?)
          ON CONFLICT(thread_key) DO UPDATE SET fingerprint=excluded.fingerprint,source_updated_at=excluded.source_updated_at,
          evidence_checked_at=excluded.evidence_checked_at,runtime_state=excluded.runtime_state`)
          .run(source.threadKey, fingerprints.get(source.threadKey)!, source.sourceUpdatedAt, source.evidenceCheckedAt,source.runtimeState);
        if (current) {
          this.db.prepare('UPDATE threads SET source_updated_at=?,runtime_state=?,observed_at=?,last_observed_at=? WHERE thread_key=?')
            .run(source.sourceUpdatedAt, source.runtimeState, source.evidenceCheckedAt, source.evidenceCheckedAt, source.threadKey);
          const cached = current.recap_json ? threadRecapSchema.parse(JSON.parse(String(current.recap_json))) : undefined;
          if (cached && (cached.sourceFingerprint === fingerprints.get(source.threadKey) || cached.sourceFingerprint === compatibleFingerprints.get(source.threadKey))) this.db.prepare('UPDATE threads SET recap_json=? WHERE thread_key=?')
            .run(JSON.stringify({ ...cached, sourceFingerprint: fingerprints.get(source.threadKey), evidenceCheckedAt: source.evidenceCheckedAt }), source.threadKey);
        }
      }
      this.setSettingRaw('lastEvidenceCoverage', JSON.stringify(bundle.coverage));
      const revision = this.bumpRevisionInTransaction();
      this.db.exec('COMMIT'); this.emitMutation(revision);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  evidenceIsCurrent(key: string, fingerprint: string): boolean {
    return (this.db.prepare('SELECT fingerprint FROM sync_sources WHERE thread_key=?').get(key) as Row | undefined)?.fingerprint === fingerprint;
  }

  commitRecap(source: SourceThread, recap: ThreadRecap, expectedEpoch = this.getSummaryEpoch()): boolean {
    threadRecapSchema.parse(recap);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const latest = this.db.prepare(`SELECT s.source_updated_at, s.evidence_checked_at, s.runtime_state, t.cwd
        FROM sync_sources s LEFT JOIN threads t USING(thread_key) WHERE s.thread_key=? AND s.fingerprint=?`)
        .get(source.threadKey, recap.sourceFingerprint) as Row | undefined;
      if (expectedEpoch !== this.getSummaryEpoch() || !latest) { this.db.exec('ROLLBACK'); return false; }
      const checkedAt = String(latest.evidence_checked_at), updatedAt = String(latest.source_updated_at);
      // A later read can reuse the in-flight content while updating runtime metadata.
      // Committing that recap must not roll the later observation back.
      recap = { ...recap, evidenceCheckedAt: checkedAt };
      const s = recap.summary;
      this.upsertThread({
        threadKey: source.threadKey, threadId: source.threadId, projectKey: source.projectKey, hostId: source.hostId ?? undefined,
        sourceKind: source.sourceKind, title: source.title, displayTitle: s.headline.slice(0, 120), sidebarIndex: source.sidebarIndex,
        observedAt: checkedAt, sourceUpdatedAt: updatedAt, cwd: optional(latest, 'cwd'),
        runtimeState: (optional(latest, 'runtime_state') as SnapshotThread['runtimeState']) ?? 'unknown',
        workState: s.workState, humanAction: s.nextStep?.kind ?? 'none', actionStrength: s.nextStep?.strength ?? 'none',
        stopPoint: s.stopPoint, evidence: source.readReason, confidence: s.confidence, recap
      });
      for (const resolved of s.resolvedTodos) {
        const row = this.db.prepare('SELECT * FROM todos WHERE todo_key=? AND project_key=?').get(resolved.todoKey, source.projectKey) as Row | undefined;
        if (row && parseStringArray(row.source_thread_keys).includes(source.threadKey)) this.db.prepare('UPDATE todos SET missing_since=? WHERE todo_key=?').run(recap.summarizedAt, resolved.todoKey);
      }
      if (s.nextStep) this.upsertTodo({
        todoKey: `recap:${createHash('sha256').update(JSON.stringify([source.threadKey,s.nextStep.kind,s.nextStep.text])).digest('hex')}`, projectKey: source.projectKey, sourceThreadKeys: [source.threadKey],
        kind: s.nextStep.kind, strength: s.nextStep.strength, title: s.nextStep.text.slice(0,500), minimumAction: s.nextStep.text,
        whyNow: '对话有明确的行动交接。', unlocks: '按对话已明确的行动继续；未推断额外结果。', evidence: s.stopPoint,
        confidence: s.confidence, observedAt: source.evidenceCheckedAt, sidebarIndex: source.sidebarIndex,
        actionEvidence: { origin: s.nextStep.origin, sourceRefs: s.nextStep.sourceRefs }
      });
      const threads = (this.db.prepare('SELECT * FROM threads WHERE project_key=? AND missing_since IS NULL ORDER BY source_updated_at DESC').all(source.projectKey) as Row[]).map(toThread);
      const leader = threads.find(t => t.recap)?.recap;
      const progress = projectProgress(threads);
      if (leader) this.upsertProjectBrief({
        projectKey: source.projectKey, overview: threads.map(t => t.recap?.summary.headline || t.stopPoint).filter(Boolean).join('；').slice(0,2000) || '等待对话近况',
        currentStage: `${progress.stage}${progress.latest ? `；最近来源：${progress.latest.title} · ${threadSourceTime(progress.latest) || '时间未知'}` : ''}`.slice(0,800),
        workState: progress.workState, stopPoint: threads.map(t => `${t.title}：${t.recap?.summary.stopPoint || t.stopPoint}`).join('\n').slice(0,2000) || '证据不足',
        codexOrExternalNext: threads.flatMap(t => t.recap?.summary.nextStep ? [t.recap.summary.nextStep.text] : []).join('；').slice(0,2000) || '暂无明确下一步',
        evidenceLevel: 'deep_read', evidenceReason: '按来源合并已核验摘要；其他来源未被此次更新覆盖。',
        confidence: threads.some(t => t.confidence === 'low') ? 'low' : leader.summary.confidence,
        observedAt: recap.summarizedAt, lastMeaningfulAt: threads[0]?.sourceUpdatedAt
      });
      const revision = this.bumpRevisionInTransaction(); this.db.exec('COMMIT'); this.emitMutation(revision); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  importSnapshot(snapshot: BoardSnapshot): ImportResult {
    const digest = snapshotDigest(snapshot);
    const summaries = snapshotSummaries(snapshot);
    const already = this.db.prepare('SELECT digest FROM snapshot_imports WHERE digest = ?').get(digest);
    if (already) {
      return {
        digest,
        projectsSeen: snapshot.projects.length,
        threadsSeen: snapshot.threads.length,
        tasksCreated: 0,
        tasksUpdated: 0,
        positionsPreserved: snapshot.threads.length,
        ignoredOlder: 0,
        projectBriefsSeen: summaries.projectBriefs.length,
        todosSeen: summaries.todos.length,
        todosCreated: 0,
        todosUpdated: 0,
        summariesIgnoredOlder: 0
      };
    }

    let tasksCreated = 0;
    let tasksUpdated = 0;
    let positionsPreserved = 0;
    let ignoredOlder = 0;
    let todosCreated = 0;
    let todosUpdated = 0;
    let summariesIgnoredOlder = 0;
    const lastGlobalSnapshotAt = this.getSetting('lastGlobalSnapshotAt');
    const lastAuthoritativeReviewAt = this.getSetting('lastAuthoritativeReviewAt');
    const isAuthoritativeReview = snapshot.source === 'review-project-progress' && !snapshot.coverage.truncated &&
      (!lastAuthoritativeReviewAt || snapshot.generatedAt >= lastAuthoritativeReviewAt);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Explicit import is a global barrier, including jobs for absent sources.
      this.setSettingRaw('summaryEpoch', String(this.getSummaryEpoch() + 1));
      this.db.prepare('DELETE FROM sync_sources').run();
      if (isAuthoritativeReview) {
        const missingAt = new Date().toISOString();
        this.db.prepare('UPDATE threads SET missing_since=COALESCE(missing_since, ?)').run(missingAt);
        if (snapshot.schemaVersion !== 1) {
          this.db.prepare('UPDATE project_briefs SET missing_since=COALESCE(missing_since, ?)').run(missingAt);
          this.db.prepare('UPDATE todos SET missing_since=COALESCE(missing_since, ?)').run(missingAt);
        } else {
          this.db.prepare("UPDATE project_briefs SET missing_since=COALESCE(missing_since, ?) WHERE evidence_level IN ('summary_only','runtime_snapshot','none')").run(missingAt);
          this.db.prepare("UPDATE todos SET missing_since=COALESCE(missing_since, ?) WHERE todo_key LIKE 'legacy:%'").run(missingAt);
        }
      }
      for (const project of snapshot.projects) this.upsertProject(project);
      snapshot.threads.forEach((thread, index) => {
        const current = this.db.prepare('SELECT last_observed_at FROM threads WHERE thread_key = ?').get(thread.threadKey) as Row | undefined;
        if (current && String(current.last_observed_at) > thread.observedAt) {
          ignoredOlder += 1;
          this.db.prepare('UPDATE threads SET missing_since=NULL WHERE thread_key = ?').run(thread.threadKey);
          return;
        }
        this.upsertThread(thread);
        if (!thread.recap) this.db.prepare('UPDATE threads SET recap_json=NULL WHERE thread_key=?').run(thread.threadKey);
        const node = this.db.prepare('SELECT id FROM canvas_nodes WHERE thread_key = ?').get(thread.threadKey);
        if (node) {
          tasksUpdated += 1;
          positionsPreserved += 1;
        } else {
          const position = initialTaskPosition(index);
          const now = new Date().toISOString();
          this.db
            .prepare(`INSERT INTO canvas_nodes
              (id, kind, thread_key, x, y, width, height, z_index, title, body, last_viewed_at, revision, created_at, updated_at, page_id)
              VALUES (?, 'task', ?, ?, ?, 176, 176, 0, ?, '', NULL, 0, ?, ?, ?)`)
            .run(`task:${thread.threadKey}`, thread.threadKey, position.x, position.y, thread.displayTitle ?? thread.title, now, now, thread.projectKey ? this.getProjectPagePolicy(thread.projectKey).pageId : this.getDefaultPageId());
          tasksCreated += 1;
        }
      });
      this.ensureProjectNodes();
      for (const brief of summaries.projectBriefs) {
        const current = this.db.prepare('SELECT evidence_level, last_observed_at FROM project_briefs WHERE project_key = ?').get(brief.projectKey) as Row | undefined;
        if (current && (String(current.last_observed_at) > brief.observedAt ||
          (snapshot.schemaVersion === 1 && evidenceRank(String(current.evidence_level)) > evidenceRank(brief.evidenceLevel)))) {
          summariesIgnoredOlder += 1;
          this.db.prepare('UPDATE project_briefs SET missing_since=NULL WHERE project_key = ?').run(brief.projectKey);
          continue;
        }
        this.upsertProjectBrief(brief);
      }
      const activeTodos = snapshot.schemaVersion === 1
        ? (this.db.prepare('SELECT * FROM todos WHERE missing_since IS NULL').all() as Row[]).map(toTodo)
        : [];
      const activeTodoSources = new Set(activeTodos.flatMap((todo) => todo.sourceThreadKeys));
      const activeTodoSignatures = new Set(activeTodos.map(todoIdentity));
      for (const todo of summaries.todos) {
        const current = this.db.prepare('SELECT last_observed_at FROM todos WHERE todo_key = ?').get(todo.todoKey) as Row | undefined;
        if (snapshot.schemaVersion === 1 && !current &&
          (todo.sourceThreadKeys.some((threadKey) => activeTodoSources.has(threadKey)) || activeTodoSignatures.has(todoIdentity(todo)))) {
          summariesIgnoredOlder += 1;
          continue;
        }
        if (current && String(current.last_observed_at) > todo.observedAt) {
          summariesIgnoredOlder += 1;
          this.db.prepare('UPDATE todos SET missing_since=NULL WHERE todo_key = ?').run(todo.todoKey);
          continue;
        }
        this.upsertTodo(todo);
        if (snapshot.schemaVersion === 1) {
          todo.sourceThreadKeys.forEach((threadKey) => activeTodoSources.add(threadKey));
          activeTodoSignatures.add(todoIdentity(todo));
        }
        if (current) todosUpdated += 1;
        else todosCreated += 1;
      }
      this.db
        .prepare(`INSERT INTO snapshot_imports (digest, generated_at, source, imported_at, project_count, thread_count)
          VALUES (?, ?, ?, ?, ?, ?)`)
        .run(digest, snapshot.generatedAt, snapshot.source, new Date().toISOString(), snapshot.projects.length, snapshot.threads.length);
      if (!lastGlobalSnapshotAt || snapshot.generatedAt >= lastGlobalSnapshotAt) this.setSettingRaw('lastGlobalSnapshotAt', snapshot.generatedAt);
      if (isAuthoritativeReview) this.setSettingRaw('lastAuthoritativeReviewAt', snapshot.generatedAt);
      this.unfoldInvalidNotesInTransaction();
      this.writeHistoryBarrierInTransaction('导入项目快照');
      const boardRevision = this.bumpRevisionInTransaction();
      this.db.exec('COMMIT');
      this.emitMutation(boardRevision);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return {
      digest,
      projectsSeen: snapshot.projects.length,
      threadsSeen: snapshot.threads.length,
      tasksCreated,
      tasksUpdated,
      positionsPreserved,
      ignoredOlder,
      projectBriefsSeen: summaries.projectBriefs.length,
      todosSeen: summaries.todos.length,
      todosCreated,
      todosUpdated,
      summariesIgnoredOlder
    };
  }

  getBoard(priorityDate = localCalendarDate()): BoardState {
    const pages = this.getPages();
    const activePageId = this.getActivePageId();
    return {
      pages, priorityDate,
      boardRevision: this.getBoardRevision(),
      projects: (this.db.prepare('SELECT * FROM projects ORDER BY COALESCE(sidebar_index, 2147483647), rowid').all() as Row[]).map(toProject),
      threads: (this.db.prepare(`SELECT t.*, s.fingerprint AS collected_fingerprint FROM threads t
        LEFT JOIN sync_sources s USING(thread_key) ORDER BY COALESCE(t.sidebar_index, 2147483647), t.rowid`).all() as Row[]).map(toThread),
      projectBriefs: (this.db.prepare(`SELECT project_briefs.* FROM project_briefs
        JOIN projects USING(project_key) WHERE project_briefs.missing_since IS NULL
        ORDER BY COALESCE(projects.sidebar_index, 2147483647), project_briefs.rowid`).all() as Row[]).map(toProjectBrief),
      todos: (this.db.prepare(`SELECT * FROM todos WHERE missing_since IS NULL
        ORDER BY COALESCE(sidebar_index, 2147483647), rowid`).all() as Row[]).map(toTodo),
      nodes: (this.db.prepare('SELECT * FROM canvas_nodes ORDER BY z_index, created_at').all() as Row[]).map(row => toNode(row, priorityDate)),
      annotations: (this.db.prepare('SELECT * FROM annotations ORDER BY created_at').all() as Row[]).map(toAnnotation),
      links: (this.db.prepare('SELECT * FROM local_links ORDER BY created_at').all() as Row[]).map(toLink),
      inkStrokes: (this.db.prepare('SELECT * FROM ink_strokes ORDER BY layer, z_index, created_at').all() as Row[]).map(toInkStroke),
      viewport: this.getPage(activePageId).viewport,
      settings: {
        activePageId, defaultPageId: this.getDefaultPageId(),
        theme: this.getSetting('theme') === 'ink-constellation' ? 'ink-constellation' : 'archive-paper',
        priorityIcons: this.getJsonSetting<PriorityIcons>('priorityIcons', defaultPriorityIcons),
        activeSkinRef: this.getSetting('activeSkinRef'),
        wallpaper: this.getJsonSetting<Wallpaper | null>('wallpaper', null),
        wallpaperPresets: this.wallpaperPresetSummaries(),
        skinComponents: this.getJsonSetting<SkinComponents>('skinComponents', {}),
        keyBindings: this.getJsonSetting<Record<string, string>>('keyBindings', {}),
        drawingPreferences: drawingPreferencesSchema.parse(this.getJsonSetting<DrawingPreferences>('drawingPreferences', defaultDrawingPreferences())),
        curatorThreadId: this.getSetting('curatorThreadId'),
        lastDailyReviewDate: this.getSetting('lastDailyReviewDate'),
        lastGlobalSnapshotAt: this.getSetting('lastGlobalSnapshotAt')
      },
      historyStatus: this.getHistoryStatus()
    };
  }

  getPages(): CanvasPageRecord[] {
    return (this.db.prepare('SELECT * FROM canvas_pages ORDER BY sort_order, created_at').all() as Row[]).map(toPage);
  }

  getPage(id: string): CanvasPageRecord {
    const row = this.db.prepare('SELECT * FROM canvas_pages WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new NotFoundError('找不到该页面。');
    return toPage(row);
  }

  getDefaultPageId(): string { return this.getSetting('defaultPageId') || DEFAULT_PAGE_ID; }
  private getActivePageId(): string {
    const id = this.getSetting('activePageId');
    return this.getPages().find(page => page.id === id && !page.archivedAt)?.id || this.getDefaultPageId();
  }

  getExcerptSource(projectKey: string, threadKey: string, sourceId: string) {
    const row = this.db.prepare(`SELECT t.* FROM threads t
      JOIN canvas_nodes n ON n.project_key=t.project_key JOIN canvas_pages p ON p.id=n.page_id
      WHERE t.project_key=? AND t.thread_key=? AND n.archived_at IS NULL AND p.archived_at IS NULL`).get(projectKey, threadKey) as Row | undefined;
    if (!row) return null;
    const thread = toThread(row);
    const source = thread.recap?.sources.find(item => item.id === sourceId);
    if (!source) return null;
    const project = toProject(this.db.prepare('SELECT * FROM projects WHERE project_key=?').get(projectKey) as Row);
    return { project, thread, source };
  }

  getProjectPagePolicy(projectKey: string): { pageId: string; archived: boolean; autoCheckPaused: boolean } {
    const row = this.db.prepare(`SELECT p.* FROM canvas_pages p JOIN canvas_nodes n ON n.page_id=p.id WHERE n.project_key=?`).get(projectKey) as Row | undefined;
    if (!row) return { pageId: this.getDefaultPageId(), archived: false, autoCheckPaused: false };
    return { pageId: String(row.id), archived: Boolean(row.archived_at), autoCheckPaused: Boolean(row.auto_check_paused) };
  }

  assertPageWritable(id: string): void {
    if (this.getPage(id).archivedAt) throw new InvalidNodeOperationError('页面已归档，只能查看；请先恢复页面。');
  }

  private assertLinkWritable(link: LocalLinkRecord): void {
    this.assertPageWritable(pageId(this.getNode(link.sourceNodeId)));
    this.assertPageWritable(pageId(this.getNode(link.targetNodeId)));
  }

  private pageMutation<T>(label: string, work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const before = new Map(this.getPages().map(page => [page.id, this.getHistoryRow('canvas_pages', page.id)]));
      const defaultBefore = this.getHistoryRow('settings', 'defaultPageId');
      const value = work();
      const after = new Map(this.getPages().map(page => [page.id, this.getHistoryRow('canvas_pages', page.id)]));
      const changes: HistoryChange[] = [];
      for (const key of new Set([...before.keys(), ...after.keys()])) {
        const a = before.get(key) ?? null, b = after.get(key) ?? null;
        if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ table: 'canvas_pages', key, before: a, after: b });
      }
      const defaultAfter = this.getHistoryRow('settings', 'defaultPageId');
      if (JSON.stringify(defaultBefore) !== JSON.stringify(defaultAfter)) changes.push({ table: 'settings', key: 'defaultPageId', before: defaultBefore, after: defaultAfter });
      this.recordHistoryInTransaction(label, changes, []);
      const revision = changes.length ? this.bumpRevisionInTransaction() : null;
      this.db.exec('COMMIT');
      if (revision !== null) this.emitMutation(revision);
      return value;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  createPage(name: string): CanvasPageRecord {
    return this.pageMutation('新建页面', () => {
      const id = `page:${randomUUID()}`, now = new Date().toISOString();
      const order = this.getPages().reduce((max, page) => Math.max(max, page.sortOrder), -1) + 1;
      this.db.prepare(`INSERT INTO canvas_pages (id,name,sort_order,viewport_json,background_skin_ref,archived_at,auto_check_paused,revision,created_at,updated_at)
        VALUES (?,?,?, ?,NULL,NULL,0,0,?,?)`).run(id, name.trim(), order, JSON.stringify({ x: 0, y: 0, zoom: .78 }), now, now);
      return this.getPage(id);
    });
  }

  updatePage(id: string, patch: { revision: number; name?: string; backgroundSkinRef?: string | null; wallpaper?: Wallpaper | null; autoCheckPaused?: boolean }): CanvasPageRecord {
    return this.pageMutation('修改页面', () => {
      const page = this.getPage(id); this.assertPageWritable(id);
      if (page.revision !== patch.revision) throw new RevisionConflictError(page);
      if (patch.name !== undefined && !patch.name.trim()) throw new InvalidNodeOperationError('页面名称不能为空。');
      if (patch.wallpaper && patch.backgroundSkinRef) throw new InvalidNodeOperationError('请为这一页选一种背景。');
      if (patch.wallpaper) this.requireWallpaperMedia(patch.wallpaper);
      const image = patch.wallpaper !== undefined ? patch.wallpaper : patch.backgroundSkinRef !== undefined ? null : page.wallpaper;
      const skin = patch.wallpaper ? null : patch.backgroundSkinRef === undefined ? page.backgroundSkinRef : patch.backgroundSkinRef;
      const paused = patch.autoCheckPaused ?? page.autoCheckPaused;
      const name = patch.name?.trim() ?? page.name;
      if (name === page.name && skin === page.backgroundSkinRef && paused === page.autoCheckPaused && sameWallpaper(image, page.wallpaper)) return page;
      this.db.prepare('UPDATE canvas_pages SET name=?,background_skin_ref=?,wallpaper_json=?,auto_check_paused=?,revision=revision+1,updated_at=? WHERE id=?')
        .run(name, skin, image ? JSON.stringify(image) : null, Number(paused), new Date().toISOString(), id);
      return this.getPage(id);
    });
  }

  archivePage(id: string, input: { archived: boolean; revision: number; replacementDefaultPageId?: string }): CanvasPageRecord {
    return this.pageMutation(input.archived ? '归档页面' : '恢复页面', () => {
      const page = this.getPage(id);
      if (page.revision !== input.revision) throw new RevisionConflictError(page);
      if (Boolean(page.archivedAt) === input.archived) return page;
      if (input.archived) {
        const active = this.getPages().filter(item => !item.archivedAt && item.id !== id);
        if (!active.length) throw new InvalidNodeOperationError('至少保留一个活动页面。');
        if (this.getDefaultPageId() === id) {
          if (!input.replacementDefaultPageId || !active.some(item => item.id === input.replacementDefaultPageId)) throw new InvalidNodeOperationError('请先选择其他活动页接收新项目。');
          this.setSettingRaw('defaultPageId', input.replacementDefaultPageId);
        }
        if (this.getSetting('activePageId') === id) this.setSettingRaw('activePageId', active[0]!.id);
      }
      this.db.prepare('UPDATE canvas_pages SET archived_at=?,auto_check_paused=1,revision=revision+1,updated_at=? WHERE id=?')
        .run(input.archived ? new Date().toISOString() : null, new Date().toISOString(), id);
      return this.getPage(id);
    });
  }

  deletePage(id: string, revision: number): void {
    this.pageMutation('删除空页面', () => {
      const page = this.getPage(id);
      if (page.revision !== revision) throw new RevisionConflictError(page);
      if (id === this.getDefaultPageId() || this.getPages().filter(item => !item.archivedAt).length <= 1 && !page.archivedAt) throw new InvalidNodeOperationError('接收页或最后一个活动页不能删除。');
      const count = Number((this.db.prepare('SELECT (SELECT COUNT(*) FROM canvas_nodes WHERE page_id=?) + (SELECT COUNT(*) FROM ink_strokes WHERE page_id=?) AS count').get(id, id) as Row).count);
      if (count) throw new InvalidNodeOperationError('页面仍有内容（包含归档或收纳项）；请改用页面归档。');
      this.db.prepare('DELETE FROM canvas_pages WHERE id=?').run(id);
      if (this.getSetting('activePageId') === id) this.setSettingRaw('activePageId', this.getDefaultPageId());
    });
  }

  orderPages(ids: string[]): void {
    this.pageMutation('排列页面', () => {
      const active = this.getPages().filter(page => !page.archivedAt);
      if (ids.length !== active.length || new Set(ids).size !== ids.length || active.some(page => !ids.includes(page.id))) throw new InvalidNodeOperationError('页面列表已变化，请重试。');
      ids.forEach((id, index) => { if (this.getPage(id).sortOrder !== index) this.db.prepare('UPDATE canvas_pages SET sort_order=?,revision=revision+1 WHERE id=?').run(index, id); });
    });
  }

  setActivePage(id: string): void { if (!this.getPage(id).archivedAt) this.setSettingRaw('activePageId', id); }
  setDefaultPage(id: string): void {
    this.assertPageWritable(id);
    this.pageMutation('设置项目接收页', () => this.setSettingRaw('defaultPageId', id));
  }
  pageNavigation(): { pages: CanvasPageRecord[]; activePageId: string; defaultPageId: string } {
    return { pages: this.getPages(), activePageId: this.getActivePageId(), defaultPageId: this.getDefaultPageId() };
  }
  savePageViewport(id: string, viewport: CanvasPageRecord['viewport']): CanvasPageRecord {
    this.assertPageWritable(id);
    this.db.prepare('UPDATE canvas_pages SET viewport_json=? WHERE id=?').run(JSON.stringify(viewport), id);
    if (id === DEFAULT_PAGE_ID) this.setSettingRaw('viewport', JSON.stringify(viewport));
    this.recordMutation();
    return this.getPage(id);
  }

  foldAll(id: string, folded: boolean, revision: number): { nodes: CanvasNodeRecord[]; boardRevision: number } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const host = this.getNode(id); this.assertPageWritable(pageId(host));
      if (host.revision !== revision) throw new RevisionConflictError(host);
      if (host.kind !== 'task' || !host.projectKey) throw new InvalidNodeOperationError('请从项目气泡整理下游内容。');
      const graph = this.foldingGraph();
      const descendants = new Set([id]);
      const parents = new Map<string, string>();
      let changed = true;
      while (changed) {
        changed = false;
        for (const node of graph.nodes) {
          if (node.kind !== 'note' || node.archivedAt || descendants.has(node.id) || pageId(node) !== pageId(host)) continue;
          const parent = getNoteFoldEligibility(node.id, graph.nodes, graph.links).parentNodeId;
          if (parent && descendants.has(parent)) { descendants.add(node.id); parents.set(node.id, parent); changed = true; }
        }
      }
      if (descendants.size === 1) throw new InvalidNodeOperationError('没有可整理的下游便签；多项目上游或环形连接不能自动折叠。');
      const changes: HistoryChange[] = [];
      for (const node of graph.nodes.filter(node => node.id !== id && descendants.has(node.id))) {
        const target = folded ? parents.get(node.id)! : null;
        if ((node.foldedIntoNodeId ?? null) === target) continue;
        const before = this.getHistoryRow('canvas_nodes', node.id);
        this.db.prepare('UPDATE canvas_nodes SET folded_into_node_id=?,revision=revision+1,updated_at=? WHERE id=?').run(target, new Date().toISOString(), node.id);
        changes.push({ table: 'canvas_nodes', key: node.id, before, after: this.getHistoryRow('canvas_nodes', node.id) });
      }
      this.recordHistoryInTransaction(folded ? '全部折叠下游便签' : '展开全部下游便签', changes, [id, ...changes.map(change => change.key)]);
      const boardRevision = changes.length ? this.bumpRevisionInTransaction() : this.getBoardRevision();
      this.db.exec('COMMIT'); if (changes.length) this.emitMutation(boardRevision);
      return { nodes: changes.map(change => this.getNode(change.key)), boardRevision };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private migratePages(): void {
    const needsMigration = ['canvas_nodes', 'ink_strokes'].some(table =>
      !(this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some(column => column.name === 'page_id'));
    if (needsMigration && this.databasePath !== ':memory:' && Number((this.db.prepare('SELECT (SELECT COUNT(*) FROM canvas_nodes)+(SELECT COUNT(*) FROM ink_strokes) AS count').get() as Row).count)) {
      const directory = path.join(path.dirname(this.databasePath), 'backups');
      fs.mkdirSync(directory, { recursive: true });
      const backupPath = path.join(directory, `zz-board-pre-pages-${Date.now()}-${randomUUID().slice(0, 8)}.sqlite`);
      this.db.prepare('VACUUM INTO ?').run(backupPath);
      const backup = new DatabaseSync(backupPath, { readOnly: true });
      try { if (Object.values(backup.prepare('PRAGMA quick_check').get()!)[0] !== 'ok') throw new Error('页面升级前备份未通过完整性检查。'); }
      finally { backup.close(); }
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS canvas_pages (
        id TEXT PRIMARY KEY,name TEXT NOT NULL,sort_order INTEGER NOT NULL,viewport_json TEXT NOT NULL,
        background_skin_ref TEXT,wallpaper_json TEXT,archived_at TEXT,auto_check_paused INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
      )`);
      const now = new Date().toISOString();
      if (!(this.db.prepare('PRAGMA table_info(canvas_pages)').all() as Row[]).some(column => column.name === 'wallpaper_json')) {
        this.db.exec('ALTER TABLE canvas_pages ADD COLUMN wallpaper_json TEXT');
      }
      if (!Number((this.db.prepare('SELECT COUNT(*) AS count FROM canvas_pages').get() as Row).count)) {
        this.db.prepare(`INSERT INTO canvas_pages (id,name,sort_order,viewport_json,created_at,updated_at) VALUES (?,?,0,?,?,?)`)
          .run(DEFAULT_PAGE_ID, INITIAL_PAGE_NAME, JSON.stringify(this.getJsonSetting('viewport', { x: 0, y: 0, zoom: .78 })), now, now);
      }
      this.db.prepare("UPDATE canvas_pages SET name=? WHERE id=? AND name='默认页' AND revision=0")
        .run(INITIAL_PAGE_NAME, DEFAULT_PAGE_ID);
      for (const table of ['canvas_nodes', 'ink_strokes']) {
        if (!(this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some(column => column.name === 'page_id')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN page_id TEXT NOT NULL DEFAULT '${DEFAULT_PAGE_ID}'`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_page ON ${table}(page_id)`);
      }
      if (!this.getSetting('defaultPageId')) this.setSettingRaw('defaultPageId', DEFAULT_PAGE_ID);
      if (!this.getSetting('activePageId')) this.setSettingRaw('activePageId', DEFAULT_PAGE_ID);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  registerMedia(asset: MediaAsset): void {
    this.db.prepare('INSERT OR IGNORE INTO media_assets (id, metadata_json) VALUES (?, ?)').run(asset.id, JSON.stringify(asset));
  }
  getMedia(id: string): MediaAsset | undefined {
    const row = this.db.prepare('SELECT metadata_json FROM media_assets WHERE id=?').get(id) as Row | undefined;
    return row ? JSON.parse(String(row.metadata_json)) as MediaAsset : undefined;
  }
  mediaUsage(): { count: number; bytes: number } {
    const assets = (this.db.prepare('SELECT metadata_json FROM media_assets').all() as Row[]).map(row => JSON.parse(String(row.metadata_json)) as MediaAsset);
    return { count: assets.length, bytes: assets.reduce((sum, asset) => sum + asset.bytes + asset.previewBytes, 0) };
  }
  private validateNoteDocument(node: NoteContent & { kind?: string; notePresentation?: string }): void {
    try { validateNoteContent(node.body, node.noteDocument); } catch { throw new InvalidNodeOperationError('便签正文与图文内容不一致。'); }
    if (node.kind === 'task' && (node.noteDocument || node.notePresentation === 'image')) throw new InvalidNodeOperationError('项目气泡不能保存便签图片。');
    for (const id of documentAssets(node.noteDocument)) if (!this.getMedia(id)) throw new InvalidNodeOperationError('图片尚未保存，请重新粘贴。');
    if (node.notePresentation === 'image' && (node.body !== '' || node.noteDocument?.content.length !== 1 || node.noteDocument.content[0]?.type !== 'image')) throw new InvalidNodeOperationError('独立图片卡片必须包含一张图片。');
  }
  private insertNoteRow(id: string, input: NewNote, source?: ConversationNoteSource): CanvasNodeRecord {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO canvas_nodes
      (id, kind, thread_key, x, y, width, height, z_index, title, body, last_viewed_at, revision, created_at, updated_at, note_document, note_presentation, aspect_locked, page_id, note_source, content_edited_at)
      VALUES (?, 'note', NULL, ?, ?, ?, ?, 10, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.x, input.y, input.width, input.height, input.title, input.body, now, now, input.noteDocument ? JSON.stringify(input.noteDocument) : null,
        input.notePresentation || 'note', input.notePresentation === 'image' ? 1 : null, input.pageId ?? DEFAULT_PAGE_ID, source ? JSON.stringify(source) : null,
        sameDisplayedContent(input, { body: '' }) ? null : now);
    return this.getNode(id);
  }

  createNote(input: NewNote & { clientRequestId?: string }): CanvasNodeRecord {
    this.validateNoteDocument(input);
    this.assertPageWritable(input.pageId ?? DEFAULT_PAGE_ID);
    const id = input.clientRequestId
      ? `note:request:${createHash('sha256').update(input.clientRequestId).digest('hex').slice(0, 32)}`
      : `note:${randomUUID()}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (input.clientRequestId) {
        if (this.db.prepare('SELECT node_id FROM deleted_note_requests WHERE node_id = ?').get(id)) {
          throw new DeletedNoteRequestError('This note was permanently deleted. Discard the queued create request.');
        }
        const existing = this.db.prepare('SELECT * FROM canvas_nodes WHERE id = ?').get(id) as Row | undefined;
        if (existing) {
          this.db.exec('COMMIT');
          return toNode(existing);
        }
      }
      const note = this.insertNoteRow(id, input);
      this.recordHistoryInTransaction('创建便签', [{
        table: 'canvas_nodes', key: id, before: null, after: this.getHistoryRow('canvas_nodes', id)
      }], [id]);
      const boardRevision = this.bumpRevisionInTransaction();
      this.db.exec('COMMIT');
      this.emitMutation(boardRevision);
      return note;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  captureConversationNote(input: CaptureConversationNoteInput): ConversationNoteReceipt {
    this.db.exec(input.mode === 'apply' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const { project, anchor, source } = captureTarget(this.db, input);
      const noteId = 'note:conversation:' + createHash('sha256').update(input.clientRequestId).digest('hex').slice(0, 32);
      const digestFor = (threadKey: string | null) => createHash('sha256').update(JSON.stringify([
        project.projectKey, source.hostId, codexThreadUuid(source.threadId) ?? source.threadId, threadKey, input.title, input.body
      ])).digest('hex');
      const digest = digestFor(source.threadKey);
      const receipt: ConversationNoteReceipt = { status: 'preview', noteId, projectKey: project.projectKey, projectName: project.name,
        projectNodeId: anchor.nodeId, pageId: anchor.pageId, pageName: anchor.pageName, source };
      // The digest survives undo and deletion, so a lost response can never resurrect or overwrite a note.
      const previous = this.db.prepare('SELECT digest FROM conversation_note_requests WHERE node_id=?').get(noteId);
      if (previous) {
        // Older receipts hashed an omitted selector as null. A capture made before first sync
        // also has a null key; either can be retried after the source is known.
        if (previous.digest !== digest && (source.threadKey === null || previous.digest !== digestFor(null))) {
          throw new ConversationNoteError(409, 'request_conflict', '这个请求编号已经用于其他便签内容或来源。');
        }
        const row = this.db.prepare('SELECT * FROM canvas_nodes WHERE id=?').get(noteId) as Row | undefined;
        if (!row) {
          const deleted = this.db.prepare('SELECT 1 FROM deleted_note_requests WHERE node_id=?').get(noteId);
          throw new ConversationNoteError(410, 'capture_retired', deleted ? '该便签已永久删除。' : '该便签的创建已撤销或已移除，请勿重复提交。');
        }
        const note = toNode(row), currentPage = this.getPage(pageId(note));
        if (note.archivedAt || currentPage.archivedAt) throw new ConversationNoteError(409, 'note_archived', '已有便签或其页面已归档。');
        if (!note.noteSource || note.noteSource.sourceKind !== source.sourceKind ||
            (note.noteSource.threadKey !== null && note.noteSource.threadKey !== source.threadKey)) {
          throw new ConversationNoteError(409, 'source_mismatch', '已保存的来源与当前记录不一致。');
        }
        if (note.noteSource.threadKey === null && input.source.threadKey) {
          // The old note cannot distinguish aliases that appeared later. Verify the supplied
          // key also resolves without that selector before acknowledging it separately.
          const { source: byId } = captureTarget(this.db, { ...input, source: { hostId: source.hostId, threadId: source.threadId } });
          if (byId.threadKey !== input.source.threadKey) throw new ConversationNoteError(409, 'source_mismatch', '原便签来源与所选对话不一致。');
          receipt.resolvedThreadKey = byId.threadKey;
        }
        receipt.source = note.noteSource;
        receipt.pageId = currentPage.id; receipt.pageName = currentPage.name;
        if (input.mode === 'apply') receipt.status = 'existing';
      }
      if (previous || input.mode === 'preview') { this.db.exec('COMMIT'); return receipt; }

      const occupied = this.db.prepare('SELECT x,y,width,height FROM canvas_nodes WHERE page_id=? AND archived_at IS NULL')
        .all(anchor.pageId) as unknown as Array<Pick<CanvasNodeRecord, 'x' | 'y' | 'width' | 'height'>>;
      const width = 240, height = 170;
      const position = findInboxPosition(occupied, width, height, { x: anchor.x + anchor.width + 48, y: anchor.y });
      this.insertNoteRow(noteId, { title: input.title, body: input.body, pageId: anchor.pageId, width, height, ...position }, source);
      const link = this.insertLinkRow(anchor.nodeId, noteId, '来源对话便签');
      this.db.prepare('INSERT INTO conversation_note_requests (node_id,digest) VALUES (?,?)').run(noteId, digest);
      this.recordHistoryInTransaction('从对话记便签', [
        { table: 'canvas_nodes', key: noteId, before: null, after: this.getHistoryRow('canvas_nodes', noteId) },
        { table: 'local_links', key: link.id, before: null, after: this.getHistoryRow('local_links', link.id) }
      ], [noteId, anchor.nodeId]);
      const revision = this.bumpRevisionInTransaction();
      this.db.exec('COMMIT');
      this.emitMutation(revision);
      return { ...receipt, status: 'created' };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  updateNode(id: string, patch: Record<string, unknown> & { revision: number }): CanvasNodeRecord {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getNode(id);
      this.assertPageWritable(pageId(current));
      if ('pageId' in patch) throw new InvalidNodeOperationError('请使用跨页移动操作。');
      if (current.revision !== patch.revision) throw new RevisionConflictError(current);
      const before = this.getHistoryRow('canvas_nodes', id);
      this.validateFoldPatch(current, patch);
      const next = { ...current, ...patch, revision: current.revision + 1, updatedAt: new Date().toISOString() };
      this.validateNoteDocument(next);
      const result = this.db
        .prepare(`UPDATE canvas_nodes SET x=?, y=?, width=?, height=?, z_index=?, title=?, body=?, last_viewed_at=?, skin_ref=?, aspect_locked=?, folded_into_node_id=?, revision=?, updated_at=?, note_document=?, note_presentation=?, content_edited_at=?
          WHERE id=? AND revision=?`)
        .run(next.x, next.y, next.width, next.height, next.zIndex, next.title, next.body, next.lastViewedAt,
          next.skinRef ?? null, encodeNullableBoolean(next.aspectLocked), next.foldedIntoNodeId ?? null, next.revision, next.updatedAt, next.noteDocument ? JSON.stringify(next.noteDocument) : null, next.notePresentation || 'note',
          current.kind === 'note' && !sameDisplayedContent(current, next) ? next.updatedAt : current.contentEditedAt ?? null, id, current.revision);
      if (Number(result.changes) === 0) throw new RevisionConflictError(this.getNode(id));
      const updated = this.getNode(id);
      this.recordHistoryInTransaction(nodeHistoryLabel(current, patch), [{
        table: 'canvas_nodes', key: id, before, after: this.getHistoryRow('canvas_nodes', id)
      }], [id], current.kind === 'note' && Object.keys(patch).every((key) => ['body', 'noteDocument', 'title', 'revision', 'editSessionId'].includes(key)) ? String(patch.editSessionId ?? '') || undefined : undefined);
      const boardRevision = this.bumpRevisionInTransaction();
      this.db.exec('COMMIT');
      this.emitMutation(boardRevision);
      return updated;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  updateNodes(input: NodeBatchInput): { nodes: CanvasNodeRecord[]; boardRevision: number } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = new Date().toISOString();
      const changes: HistoryChange[] = [];
      const related: string[] = [];
      for (const item of input.updates) {
        const current = this.getNode(item.id);
        this.assertPageWritable(pageId(current));
        if ('pageId' in item.patch) throw new InvalidNodeOperationError('请使用跨页移动操作。');
        if (current.revision !== item.patch.revision) throw new RevisionConflictError(current);
        const before = this.getHistoryRow('canvas_nodes', item.id);
        this.validateFoldPatch(current, item.patch);
        const next = { ...current, ...item.patch, revision: current.revision + 1, updatedAt: now };
        this.validateNoteDocument(next);
        const result = this.db.prepare(`UPDATE canvas_nodes SET x=?, y=?, width=?, height=?, z_index=?, title=?, body=?, last_viewed_at=?, skin_ref=?, aspect_locked=?, folded_into_node_id=?, revision=?, updated_at=?, note_document=?, note_presentation=?, content_edited_at=?
          WHERE id=? AND revision=?`).run(next.x, next.y, next.width, next.height, next.zIndex, next.title, next.body,
            next.lastViewedAt, next.skinRef ?? null, encodeNullableBoolean(next.aspectLocked), next.foldedIntoNodeId ?? null, next.revision, next.updatedAt, next.noteDocument ? JSON.stringify(next.noteDocument) : null, next.notePresentation || 'note',
            current.kind === 'note' && !sameDisplayedContent(current, next) ? now : current.contentEditedAt ?? null, item.id, current.revision);
        if (Number(result.changes) === 0) throw new RevisionConflictError(this.getNode(item.id));
        changes.push({ table: 'canvas_nodes', key: item.id, before, after: this.getHistoryRow('canvas_nodes', item.id) });
        related.push(item.id);
      }
      this.recordHistoryInTransaction(input.updates.length > 1 ? '移动多个画布项目' : nodeHistoryLabel(this.getNode(input.updates[0]!.id), input.updates[0]!.patch), changes, related);
      const boardRevision = this.bumpRevisionInTransaction();
      const nodes = input.updates.map((item) => this.getNode(item.id));
      this.db.exec('COMMIT');
      this.emitMutation(boardRevision);
      return { nodes, boardRevision };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  setNodePriorities(updates: NodePriorityUpdate[]): CanvasNodeRecord[] {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = updates.map((update) => this.getNode(update.id));
      const changed = current.flatMap((node, index) => {
        const update = updates[index]!;
        this.assertPageWritable(pageId(node));
        if (node.revision !== update.revision) throw new RevisionConflictError(node);
        if (node.archivedAt) throw new InvalidNodeOperationError('归档便签只读。');
        if (node.kind !== 'note' && update.noteSchedule !== undefined) throw new InvalidNodeOperationError('只有便签可以设定日期。');
        const schedule = update.noteSchedule === undefined ? node.noteSchedule ?? null
          : update.noteSchedule === null ? null : noteScheduleSchema.parse(update.noteSchedule);
        return (node.manualPriority ?? null) === update.manualPriority && JSON.stringify(node.noteSchedule ?? null) === JSON.stringify(schedule)
          ? [] : [{ node, update, schedule }];
      });
      if (!changed.length) {
        this.db.exec('COMMIT');
        return current;
      }
      const now = new Date().toISOString();
      const changes: HistoryChange[] = [];
      for (const { node, update, schedule } of changed) {
        const before = this.getHistoryRow('canvas_nodes', node.id);
        const result = this.db.prepare(`UPDATE canvas_nodes SET manual_priority=?, note_schedule=?, revision=revision+1, updated_at=?
          WHERE id=? AND revision=?`).run(update.manualPriority, schedule ? JSON.stringify(schedule) : null, now, node.id, node.revision);
        if (Number(result.changes) === 0) throw new RevisionConflictError(this.getNode(node.id));
        changes.push({ table: 'canvas_nodes', key: node.id, before, after: this.getHistoryRow('canvas_nodes', node.id) });
      }
      const result = updates.map((update) => this.getNode(update.id));
      this.recordHistoryInTransaction(changed.some(({update}) => update.noteSchedule !== undefined) ? '调整便签安排' : '设置优先级', changes, changed.map(({node}) => node.id));
      const boardRevision = this.bumpRevisionInTransaction();
      this.db.exec('COMMIT');
      this.emitMutation(boardRevision);
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  setNoteArchived(id: string, archived: boolean, revision: number): CanvasNodeRecord {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const node = this.getNode(id);
      this.assertPageWritable(pageId(node));
      if (node.kind !== 'note') throw new InvalidNodeOperationError('Only local notes can be archived.');
      if (node.revision !== revision) throw new RevisionConflictError(node);
      if (Boolean(node.archivedAt) === archived) {
        this.db.exec('COMMIT');
        return node;
      }
      const before = this.getHistoryRow('canvas_nodes', id);
      const now = new Date().toISOString();
      const result = this.db.prepare('UPDATE canvas_nodes SET archived_at=?, revision=revision+1, updated_at=? WHERE id=? AND revision=?')
        .run(archived ? now : null, now, id, revision);
      if (Number(result.changes) === 0) throw new RevisionConflictError(this.getNode(id));
      const foldChanges = this.unfoldInvalidNotesInTransaction();
      const updated = this.getNode(id);
      this.recordHistoryInTransaction(archived ? '归档便签' : '恢复便签', [{
        table: 'canvas_nodes', key: id, before, after: this.getHistoryRow('canvas_nodes', id)
      }, ...foldChanges.filter((change) => change.key !== id)], [id, ...foldChanges.map((change) => change.key)]);
      const boardRevision = this.bumpRevisionInTransaction();
      this.db.exec('COMMIT');
      this.emitMutation(boardRevision);
      return updated;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deleteNote(id: string, revision: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const node = this.getNode(id);
      this.assertPageWritable(pageId(node));
      if (node.kind !== 'note') throw new InvalidNodeOperationError('Only local notes can be deleted.');
      if (node.revision !== revision) throw new RevisionConflictError(node);
      if (!node.archivedAt) throw new InvalidNodeOperationError('Archive the note before permanently deleting it.');
      if (/^note:(?:request|conversation):[a-f0-9]{32}$/.test(id)) {
        this.db.prepare('INSERT OR IGNORE INTO deleted_note_requests (node_id) VALUES (?)').run(id);
      }
      const result = this.db.prepare('DELETE FROM canvas_nodes WHERE id = ? AND revision = ?').run(id, revision);
      if (Number(result.changes) === 0) throw new RevisionConflictError(this.getNode(id));
      this.purgeNodeHistoryInTransaction(id);
      this.unfoldInvalidNotesInTransaction();
      const boardRevision = this.bumpRevisionInTransaction();
      this.db.exec('COMMIT');
      this.emitMutation(boardRevision);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createAnnotation(targetNodeId: string, body: string): AnnotationRecord {
    this.assertPageWritable(pageId(this.getNode(targetNodeId)));
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO annotations (id, target_node_id, body, resolved, revision, created_at, updated_at)
        VALUES (?, ?, ?, 0, 0, ?, ?)`)
        .run(id, targetNodeId, body, now, now);
      const annotation = toAnnotation(this.db.prepare('SELECT * FROM annotations WHERE id = ?').get(id) as Row);
      this.recordHistoryInTransaction('添加批注', [{
        table: 'annotations', key: id, before: null, after: this.getHistoryRow('annotations', id)
      }], [targetNodeId]);
      const boardRevision = this.bumpRevisionInTransaction();
      this.db.exec('COMMIT');
      this.emitMutation(boardRevision);
      return annotation;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private foldingGraph(): { nodes: CanvasNodeRecord[]; links: LocalLinkRecord[] } {
    const board = this.getBoard();
    const projects = new Map(board.nodes.filter((node) => node.projectKey).map((node) => [node.projectKey!, node.id]));
    const threads = new Map(board.threads.map((thread) => [thread.threadKey, thread.projectKey]));
    const mapping = new Map(board.nodes.map((node) => [node.id, node.threadKey ? projects.get(threads.get(node.threadKey) ?? '') ?? node.id : node.id]));
    return {
      nodes: board.nodes.filter((node) => mapping.get(node.id) === node.id),
      links: board.links.map((link) => ({ ...link, sourceNodeId: mapping.get(link.sourceNodeId) ?? link.sourceNodeId, targetNodeId: mapping.get(link.targetNodeId) ?? link.targetNodeId }))
    };
  }

  private validateFoldPatch(node: CanvasNodeRecord, patch: Record<string, unknown>): void {
    if (patch.foldedIntoNodeId === undefined || patch.foldedIntoNodeId === null) return;
    const graph = this.foldingGraph();
    const eligible = getNoteFoldEligibility(node.id, graph.nodes, graph.links);
    if (eligible.reason || eligible.parentNodeId !== patch.foldedIntoNodeId) throw new InvalidNodeOperationError(eligible.reason ?? '只能收进紧邻上游');
  }

  private unfoldInvalidNotesInTransaction(): HistoryChange[] {
    const graph = this.foldingGraph();
    const changes: HistoryChange[] = [];
    for (const node of graph.nodes) {
      if (this.getPage(pageId(node)).archivedAt) continue;
      if (!node.foldedIntoNodeId || getNoteFoldEligibility(node.id, graph.nodes, graph.links).parentNodeId === node.foldedIntoNodeId) continue;
      const before = this.getHistoryRow('canvas_nodes', node.id);
      this.db.prepare('UPDATE canvas_nodes SET folded_into_node_id=NULL, revision=revision+1, updated_at=? WHERE id=?').run(new Date().toISOString(), node.id);
      changes.push({ table: 'canvas_nodes', key: node.id, before, after: this.getHistoryRow('canvas_nodes', node.id) });
    }
    return changes;
  }

  updateLink(id: string, patch: { revision: number; bend: LocalLinkRecord['bend'] }): LocalLinkRecord {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getLink(id);
      this.assertLinkWritable(current);
      if (current.revision !== patch.revision) throw new RevisionConflictError(current);
      const before = this.getHistoryRow('local_links', id);
      this.db.prepare('UPDATE local_links SET bend_json=?, revision=revision+1 WHERE id=? AND revision=?').run(patch.bend == null ? null : JSON.stringify(patch.bend), id, patch.revision);
      const updated = this.getLink(id);
      this.recordHistoryInTransaction('调整连线', [{ table: 'local_links', key: id, before, after: this.getHistoryRow('local_links', id) }], [current.sourceNodeId, current.targetNodeId]);
      const boardRevision = this.bumpRevisionInTransaction();
      this.db.exec('COMMIT');
      this.emitMutation(boardRevision);
      return updated;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  deleteLink(id: string, revision: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getLink(id);
      this.assertLinkWritable(current);
      if (current.revision !== revision) throw new RevisionConflictError(current);
      const before = this.getHistoryRow('local_links', id);
      this.db.prepare('DELETE FROM local_links WHERE id=? AND revision=?').run(id, revision);
      const changes = this.unfoldInvalidNotesInTransaction();
      this.recordHistoryInTransaction('删除连线', [{ table: 'local_links', key: id, before, after: null }, ...changes], [current.sourceNodeId, current.targetNodeId, ...changes.map((change) => change.key)]);
      const boardRevision = this.bumpRevisionInTransaction();
      this.db.exec('COMMIT');
      this.emitMutation(boardRevision);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private getLink(id: string): LocalLinkRecord {
    const row = this.db.prepare('SELECT * FROM local_links WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new NotFoundError('Link was not found.');
    return toLink(row);
  }

  private insertLinkRow(sourceNodeId: string, targetNodeId: string, label: string): LocalLinkRecord {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO local_links (id, source_node_id, target_node_id, label, revision, created_at)
      VALUES (?, ?, ?, ?, 0, ?)`).run(id, sourceNodeId, targetNodeId, label, new Date().toISOString());
    return this.getLink(id);
  }

  createLink(sourceNodeId: string, targetNodeId: string, label: string): LocalLinkRecord {
    this.assertPageWritable(pageId(this.getNode(sourceNodeId)));
    this.assertPageWritable(pageId(this.getNode(targetNodeId)));
    const existing = this.db.prepare(`SELECT * FROM local_links
      WHERE (source_node_id=? AND target_node_id=?) OR (source_node_id=? AND target_node_id=?)
      ORDER BY created_at LIMIT 1`).get(sourceNodeId, targetNodeId, targetNodeId, sourceNodeId) as Row | undefined;
    if (existing) return toLink(existing);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const link = this.insertLinkRow(sourceNodeId, targetNodeId, label);
      const foldChanges = this.unfoldInvalidNotesInTransaction();
      this.recordHistoryInTransaction('创建连线', [{
        table: 'local_links', key: link.id, before: null, after: this.getHistoryRow('local_links', link.id)
      }, ...foldChanges], [sourceNodeId, targetNodeId, ...foldChanges.map((change) => change.key)]);
      const boardRevision = this.bumpRevisionInTransaction();
      this.db.exec('COMMIT');
      this.emitMutation(boardRevision);
      return link;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  applyInkBatch(input: InkBatchInput): InkBatchResult {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changes: HistoryChange[] = [];
      const created: InkStrokeRecord[] = [];
      const updated: InkStrokeRecord[] = [];
      const deletedIds: string[] = [];
      const now = new Date().toISOString();

      for (const item of input.creates) {
        this.assertPageWritable(item.pageId ?? DEFAULT_PAGE_ID);
        const id = item.id || randomUUID();
        if (this.db.prepare('SELECT id FROM ink_strokes WHERE id=?').get(id)) {
          const existing = this.getInkStroke(id);
          const same = existing.tool === item.tool && existing.color === item.color && existing.size === item.size &&
            pageId(existing) === (item.pageId ?? DEFAULT_PAGE_ID) && existing.opacity === item.opacity && existing.layer === item.layer && existing.zIndex === item.zIndex &&
            JSON.stringify(existing.points) === JSON.stringify(item.points);
          if (!same) throw new InvalidNodeOperationError(`Ink stroke ${id} already exists with different content.`);
          created.push(existing);
          continue;
        }
        this.db.prepare(`INSERT INTO ink_strokes
          (id, tool, points_json, color, size, opacity, layer, z_index, revision, created_at, updated_at, page_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
          .run(id, item.tool, JSON.stringify(item.points), item.color, item.size, item.opacity, item.layer, item.zIndex, now, now, item.pageId ?? DEFAULT_PAGE_ID);
        const stroke = this.getInkStroke(id);
        created.push(stroke);
        changes.push({ table: 'ink_strokes', key: id, before: null, after: this.getHistoryRow('ink_strokes', id) });
      }

      for (const item of input.updates) {
        const current = this.getInkStroke(item.id);
        this.assertPageWritable(pageId(current));
        if ('pageId' in item.patch) throw new InvalidNodeOperationError('请使用跨页移动操作。');
        if (current.revision !== item.patch.revision) throw new RevisionConflictError(current);
        const before = this.getHistoryRow('ink_strokes', item.id);
        const next = { ...current, ...item.patch, revision: current.revision + 1, updatedAt: now };
        const result = this.db.prepare(`UPDATE ink_strokes SET tool=?, points_json=?, color=?, size=?, opacity=?, layer=?,
          z_index=?, revision=?, updated_at=? WHERE id=? AND revision=?`)
          .run(next.tool, JSON.stringify(next.points), next.color, next.size, next.opacity, next.layer,
            next.zIndex, next.revision, next.updatedAt, item.id, current.revision);
        if (Number(result.changes) === 0) throw new RevisionConflictError(this.getInkStroke(item.id));
        updated.push(this.getInkStroke(item.id));
        changes.push({ table: 'ink_strokes', key: item.id, before, after: this.getHistoryRow('ink_strokes', item.id) });
      }

      for (const item of input.deletes) {
        const current = this.getInkStroke(item.id);
        this.assertPageWritable(pageId(current));
        if (current.revision !== item.revision) throw new RevisionConflictError(current);
        const before = this.getHistoryRow('ink_strokes', item.id);
        const result = this.db.prepare('DELETE FROM ink_strokes WHERE id=? AND revision=?').run(item.id, item.revision);
        if (Number(result.changes) === 0) throw new RevisionConflictError(this.getInkStroke(item.id));
        deletedIds.push(item.id);
        changes.push({ table: 'ink_strokes', key: item.id, before, after: null });
      }

      if (!changes.length) {
        const boardRevision = this.getBoardRevision();
        this.db.exec('COMMIT');
        return { created, updated, deletedIds, boardRevision };
      }
      this.recordHistoryInTransaction(inkHistoryLabel(input), changes, []);
      const boardRevision = this.bumpRevisionInTransaction();
      this.db.exec('COMMIT');
      this.emitMutation(boardRevision);
      return { created, updated, deletedIds, boardRevision };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  applySelectionAction(input: SelectionAction): SelectionResult {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const nodes = input.nodes.map((ref) => {
        const node = this.getNode(ref.id);
        this.assertPageWritable(pageId(node));
        if (node.revision !== ref.revision) throw new RevisionConflictError(node);
        if (node.archivedAt || node.foldedIntoNodeId) throw new InvalidNodeOperationError('Selection contains an archived or folded node.');
        return node;
      });
      const ink = input.ink.map((ref) => {
        const stroke = this.getInkStroke(ref.id);
        this.assertPageWritable(pageId(stroke));
        if (stroke.revision !== ref.revision) throw new RevisionConflictError(stroke);
        return stroke;
      });
      const result: SelectionResult = { archivedNoteIds: [], deletedInkIds: [], keptNodeIds: [], boardRevision: this.getBoardRevision() };
      const changes = new Map<string, HistoryChange>();
      const capture = (table: HistoryTable, key: string) => changes.set(`${table}:${key}`, { table, key, before: this.getHistoryRow(table, key), after: null });
      const now = new Date().toISOString();
      const sourcePages = new Set([...nodes.map(pageId), ...ink.map(pageId)]);
      if (sourcePages.size > 1) throw new InvalidNodeOperationError('一次选区操作只能包含同一页的内容。');
      if (input.action === 'movePage') {
        this.assertPageWritable(input.targetPageId);
        const sourcePageId = [...sourcePages][0]!;
        if (sourcePageId === input.targetPageId) throw new InvalidNodeOperationError('内容已经在目标页。');
        const all = this.getBoard();
        const moving = new Set(nodes.map(node => node.id));
        const projects = new Set(nodes.map(node => node.projectKey).filter(Boolean));
        const threadProjects = new Map(all.threads.map(thread => [thread.threadKey, thread.projectKey]));
        // Keep legacy task aliases with the project's one canonical placement.
        for (const node of all.nodes) if (node.threadKey && projects.has(threadProjects.get(node.threadKey)) && !moving.has(node.id)) {
          if (pageId(node) !== sourcePageId) throw new InvalidNodeOperationError('项目旧节点的页面归属不一致。');
          nodes.push(node); moving.add(node.id);
        }
        const graph = this.foldingGraph();
        let expanded = true;
        while (expanded) {
          expanded = false;
          for (const node of graph.nodes) {
            if (moving.has(node.id) || !node.foldedIntoNodeId || !moving.has(node.foldedIntoNodeId)) continue;
            if (pageId(node) !== sourcePageId || node.archivedAt) throw new InvalidNodeOperationError('收纳内容的页面归属已变化。');
            if (getNoteFoldEligibility(node.id, graph.nodes, graph.links).parentNodeId !== node.foldedIntoNodeId) continue;
            nodes.push(node); moving.add(node.id); expanded = true;
          }
        }
        const delta = input.delta ?? { x: 0, y: 0 };
        for (const node of nodes) {
          capture('canvas_nodes', node.id);
          this.db.prepare('UPDATE canvas_nodes SET page_id=?,x=?,y=?,revision=revision+1,updated_at=? WHERE id=?')
            .run(input.targetPageId, node.x + delta.x, node.y + delta.y, now, node.id);
        }
        for (const stroke of ink) {
          capture('ink_strokes', stroke.id);
          const points = stroke.points.map(point => ({ ...point, x: point.x + delta.x, y: point.y + delta.y }));
          this.db.prepare('UPDATE ink_strokes SET page_id=?,points_json=?,revision=revision+1,updated_at=? WHERE id=?')
            .run(input.targetPageId, JSON.stringify(points), now, stroke.id);
        }
        for (const change of this.unfoldInvalidNotesInTransaction()) if (!changes.has(`${change.table}:${change.key}`)) changes.set(`${change.table}:${change.key}`, change);
      } else if (input.action === 'translate' && (input.delta.x !== 0 || input.delta.y !== 0)) {
        const shifted = (value: number, delta: number) => {
          const next = value + delta;
          if (!Number.isFinite(next)) throw new InvalidNodeOperationError('Non-finite canvas coordinate.');
          return next;
        };
        for (const node of nodes) {
          capture('canvas_nodes', node.id);
          this.db.prepare('UPDATE canvas_nodes SET x=?, y=?, revision=revision+1, updated_at=? WHERE id=?')
            .run(shifted(node.x, input.delta.x), shifted(node.y, input.delta.y), now, node.id);
        }
        for (const stroke of ink) {
          capture('ink_strokes', stroke.id);
          const points = stroke.points.map((point) => ({ ...point, x: shifted(point.x, input.delta.x), y: shifted(point.y, input.delta.y) }));
          this.db.prepare('UPDATE ink_strokes SET points_json=?, revision=revision+1, updated_at=? WHERE id=?').run(JSON.stringify(points), now, stroke.id);
        }
      } else if (input.action === 'scale' && input.factor !== 1) {
        const limits = selectionScaleLimits(nodes, ink);
        if (!Number.isFinite(input.factor) || input.factor < limits.min - 1e-10 || input.factor > limits.max + 1e-10) throw new InvalidNodeOperationError('选区已达到缩放范围，本次操作未保存。');
        const transform = { origin: input.origin, factor: Math.max(limits.min, Math.min(limits.max, input.factor)) };
        const finite = (values: number[]) => { if (values.some(value => !Number.isFinite(value))) throw new InvalidNodeOperationError('Non-finite canvas coordinate.'); };
        for (const node of nodes) {
          const next = scaledNode(node, transform); finite([next.x, next.y, next.width, next.height]);
          capture('canvas_nodes', node.id);
          this.db.prepare('UPDATE canvas_nodes SET x=?, y=?, width=?, height=?, content_scale=?, revision=revision+1, updated_at=? WHERE id=?')
            .run(next.x, next.y, next.width, next.height, next.contentScale!, now, node.id);
        }
        for (const stroke of ink) {
          const next = scaledInk(stroke, transform); next.points.forEach(p => finite([p.x, p.y]));
          capture('ink_strokes', stroke.id);
          this.db.prepare('UPDATE ink_strokes SET points_json=?, size=?, revision=revision+1, updated_at=? WHERE id=?').run(JSON.stringify(next.points), next.size, now, stroke.id);
        }
      } else if (input.action === 'delete') {
        for (const node of nodes) {
          if (node.kind !== 'note') { result.keptNodeIds.push(node.id); continue; }
          capture('canvas_nodes', node.id);
          this.db.prepare('UPDATE canvas_nodes SET archived_at=?, revision=revision+1, updated_at=? WHERE id=?').run(now, now, node.id);
          result.archivedNoteIds.push(node.id);
        }
        for (const stroke of ink) {
          capture('ink_strokes', stroke.id);
          this.db.prepare('DELETE FROM ink_strokes WHERE id=?').run(stroke.id);
          result.deletedInkIds.push(stroke.id);
        }
        if (result.archivedNoteIds.length) for (const change of this.unfoldInvalidNotesInTransaction()) {
          const key = `${change.table}:${change.key}`;
          if (!changes.has(key)) changes.set(key, change);
        }
      }
      if (changes.size) {
        for (const change of changes.values()) change.after = this.getHistoryRow(change.table, change.key);
        this.recordHistoryInTransaction(input.action === 'movePage' ? `跨页移动：${this.getPage([...sourcePages][0]!).name} → ${this.getPage(input.targetPageId).name}` : input.action === 'scale' ? '整体缩放选区' : input.action === 'translate' ? '移动选区' : '删除墨迹与归档便签', [...changes.values()],
          [...changes.values()].filter((change) => change.table === 'canvas_nodes').map((change) => change.key));
        result.boardRevision = this.bumpRevisionInTransaction();
      }
      this.db.exec('COMMIT');
      if (changes.size) this.emitMutation(result.boardRevision);
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  getNoteContentHistory(noteId: string): NoteContentHistory {
    if (this.getNode(noteId).kind !== 'note') throw new NotFoundError('Note not found.');
    const retainedEditTimes: string[] = [];
    const entries = this.db.prepare(`SELECT patch_json FROM operation_journal WHERE state='applied' AND label<>'迁移旧便签正文'
      AND EXISTS (SELECT 1 FROM json_each(related_node_ids) WHERE value=?) ORDER BY sequence DESC`);
    for (const entry of entries.iterate(noteId)) {
      const change = parseHistoryChanges(entry.patch_json).find(c => c.table === 'canvas_nodes' && c.key === noteId);
      const time = change && (change.lastContentEditAt ?? singleContentSaveTime(change));
      if (time) retainedEditTimes.push(time);
    }
    return { noteId, boardRevision: this.getBoardRevision(), retainedEditTimes };
  }

  getHistoryStatus(): HistoryStatus {
    const barrier = this.latestBarrierSequence();
    const undo = this.db.prepare(`SELECT label,patch_json FROM operation_journal
      WHERE state='applied' AND sequence>? ORDER BY sequence DESC LIMIT 1`).get(barrier) as Row | undefined;
    const redo = this.db.prepare(`SELECT label,patch_json FROM operation_journal
      WHERE state='undone' AND sequence>? ORDER BY sequence ASC LIMIT 1`).get(barrier) as Row | undefined;
    return {
      canUndo: Boolean(undo),
      canRedo: Boolean(redo),
      undoLabel: undo ? this.historyLabel(undo) : null,
      redoLabel: redo ? this.historyLabel(redo) : null
    };
  }

  private historyLabel(entry: Row): string {
    const label = String(entry.label);
    if (label.startsWith('跨页移动：')) return label;
    const changes = parseHistoryChanges(entry.patch_json);
    const row = changes.find(change => change.after?.page_id || change.before?.page_id);
    const id = row?.after?.page_id ?? row?.before?.page_id;
    const pageChange = changes.find(change => change.table === 'canvas_pages');
    const name = typeof id === 'string' && id !== DEFAULT_PAGE_ID ? this.getPages().find(page => page.id === id)?.name
      : pageChange ? String(pageChange.after?.name ?? pageChange.before?.name ?? '') : '';
    return name ? `${label} · ${name}` : label;
  }

  undo(): HistoryStatus {
    return this.replayHistory('undo');
  }

  redo(): HistoryStatus {
    return this.replayHistory('redo');
  }

  setSetting(key: string, value: string | null): void {
    if (this.getSetting(key) === value) return;
    if (key === 'theme' || key === 'activeSkinRef') {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const before = this.getHistoryRow('settings', key);
        this.setSettingRaw(key, value);
        this.recordHistoryInTransaction(key === 'theme' ? '切换主题' : '应用全局 Skin', [{
          table: 'settings', key, before, after: this.getHistoryRow('settings', key)
        }], []);
        const boardRevision = this.bumpRevisionInTransaction();
        this.db.exec('COMMIT');
        this.emitMutation(boardRevision);
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      return;
    }
    this.setSettingRaw(key, value);
    this.recordMutation();
  }

  setActiveSkin(skinRef: string | null): void {
    this.setSkinSettings({ activeSkinRef: skinRef });
  }

  private requireWallpaperMedia(value: Wallpaper): void {
    for (const image of wallpaperImages(value)) {
      if (!this.getMedia(image.assetId)) throw new InvalidNodeOperationError('找不到这张背景图，请重新选择。');
    }
  }

  private wallpaperPresetSummaries(): WallpaperPresetSummary[] {
    return this.db.prepare("SELECT json_extract(value,'$.id') AS id, json_extract(value,'$.name') AS name FROM settings WHERE key GLOB 'wallpaperPreset:*' ORDER BY name, id")
      .all().map(row => ({ id: String(row.id), name: String(row.name) }));
  }

  getWallpaperPreset(id: string): WallpaperPreset {
    const preset = this.getJsonSetting<WallpaperPreset | null>('wallpaperPreset:' + id, null);
    if (!preset) throw new NotFoundError('这套背景已被移除。');
    return preset;
  }

  changeWallpaperPreset(id: string, preset: WallpaperPreset | null): void {
    const key = 'wallpaperPreset:' + id;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getJsonSetting<WallpaperPreset | null>(key, null);
      if (current && preset && (current.name !== preset.name || !sameWallpaper(current.wallpaper, preset.wallpaper))) {
        throw new InvalidNodeOperationError('这套背景已存在，请重新另存一套。');
      }
      if (!!current === !!preset) { this.db.exec('COMMIT'); return; }
      if (preset) {
        if (this.wallpaperPresetSummaries().length >= MAX_WALLPAPER_PRESETS) throw new InvalidNodeOperationError('背景库已满，请先移除一套。');
        this.requireWallpaperMedia(preset.wallpaper);
      }
      const before = this.getHistoryRow('settings', key);
      this.setSettingRaw(key, preset ? JSON.stringify(preset) : null);
      this.recordHistoryInTransaction(preset ? '收藏背景' : '移除背景收藏', [{ table: 'settings', key, before, after: this.getHistoryRow('settings', key) }], []);
      const revision = this.bumpRevisionInTransaction();
      this.db.exec('COMMIT'); this.emitMutation(revision);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  setSkinSettings(input: { activeSkinRef?: string | null; components?: SkinComponents; wallpaper?: ChangeWallpaper; priorityIcons?: ChangePriorityIcons }): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changes: HistoryChange[] = [];
      if (input.wallpaper) {
        const { previous, value } = input.wallpaper;
        const current = this.getJsonSetting<Wallpaper | null>('wallpaper', null);
        if (!sameWallpaper(current, value)) {
          if (!sameWallpaper(current, previous)) throw new InvalidNodeOperationError('背景已在另一处修改，请重新打开外观设置。');
          if (value) this.requireWallpaperMedia(value);
          const before = this.getHistoryRow('settings', 'wallpaper');
          this.setSettingRaw('wallpaper', value ? JSON.stringify(value) : null);
          changes.push({ table: 'settings', key: 'wallpaper', before, after: this.getHistoryRow('settings', 'wallpaper') });
        }
      }
      if (input.priorityIcons) {
        const { previous, value } = input.priorityIcons;
        const current = this.getJsonSetting<PriorityIcons>('priorityIcons', defaultPriorityIcons);
        if (JSON.stringify(current) !== JSON.stringify(value)) {
          if (JSON.stringify(current) !== JSON.stringify(previous)) throw new InvalidNodeOperationError('优先级图标已在另一处修改，请重新选择。');
          if ([value.attentionImage, value.highImage].some(id => id && !this.getMedia(id))) throw new InvalidNodeOperationError('找不到自定义图标，请重新选图。');
          const before = this.getHistoryRow('settings', 'priorityIcons');
          this.setSettingRaw('priorityIcons', JSON.stringify(value));
          changes.push({ table: 'settings', key: 'priorityIcons', before, after: this.getHistoryRow('settings', 'priorityIcons') });
        }
      }
      if (input.activeSkinRef !== undefined && this.getSetting('activeSkinRef') !== input.activeSkinRef) {
        const before = this.getHistoryRow('settings', 'activeSkinRef');
        this.setSettingRaw('activeSkinRef', input.activeSkinRef);
        changes.push({ table: 'settings', key: 'activeSkinRef', before, after: this.getHistoryRow('settings', 'activeSkinRef') });
      }
      if (input.components !== undefined) {
        const next = JSON.stringify(input.components);
        if (this.getSetting('skinComponents') !== next) {
          const before = this.getHistoryRow('settings', 'skinComponents');
          this.setSettingRaw('skinComponents', next);
          changes.push({ table: 'settings', key: 'skinComponents', before, after: this.getHistoryRow('settings', 'skinComponents') });
        }
      }
      if (changes.length === 0) {
        this.db.exec('COMMIT');
        return;
      }
      const label = input.priorityIcons ? '更换优先级图标' : input.wallpaper ? '更换全板背景图' : '应用 Skin 组合';
      this.recordHistoryInTransaction(label, changes, []);
      const boardRevision = this.bumpRevisionInTransaction();
      this.db.exec('COMMIT');
      this.emitMutation(boardRevision);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  setInteractionSettings(input: { keyBindings?: Record<string, string>; drawingPreferences?: DrawingPreferences }): {
    keyBindings: Record<string, string>;
    drawingPreferences: DrawingPreferences;
  } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let changed = false;
      if (input.keyBindings !== undefined) {
        const value = JSON.stringify(input.keyBindings);
        if (this.getSetting('keyBindings') !== value) {
          this.setSettingRaw('keyBindings', value);
          changed = true;
        }
      }
      if (input.drawingPreferences !== undefined) {
        const value = JSON.stringify(input.drawingPreferences);
        if (this.getSetting('drawingPreferences') !== value) {
          this.setSettingRaw('drawingPreferences', value);
          changed = true;
        }
      }
      const result = {
        keyBindings: this.getJsonSetting<Record<string, string>>('keyBindings', {}),
        drawingPreferences: drawingPreferencesSchema.parse(this.getJsonSetting<DrawingPreferences>('drawingPreferences', defaultDrawingPreferences()))
      };
      if (!changed) {
        this.db.exec('COMMIT');
        return result;
      }
      const boardRevision = this.bumpRevisionInTransaction();
      this.db.exec('COMMIT');
      this.emitMutation(boardRevision);
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  setJsonSetting(key: string, value: unknown): void {
    if (key === 'viewport') { this.savePageViewport(DEFAULT_PAGE_ID, value as CanvasPageRecord['viewport']); return; }
    this.setSetting(key, JSON.stringify(value));
  }

  private setSettingRaw(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }

  private getInkStroke(id: string): InkStrokeRecord {
    const row = this.db.prepare('SELECT * FROM ink_strokes WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new NotFoundError(`Ink stroke ${id} was not found.`);
    return toInkStroke(row);
  }

  private latestBarrierSequence(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM operation_journal WHERE state='barrier'").get() as Row;
    return Number(row.sequence);
  }

  private recordHistoryInTransaction(label: string, changes: HistoryChange[], relatedNodeIds: string[], editSessionId?: string): void {
    if (changes.length === 0) return;
    const latest = this.db.prepare('SELECT * FROM operation_journal ORDER BY sequence DESC LIMIT 1').get() as Row | undefined;
    if (editSessionId && this.lastTextEditRevision === this.getBoardRevision() && latest?.state === 'applied' && latest.edit_session_id === editSessionId && changes.length === 1) {
      const previous = parseHistoryChanges(latest.patch_json);
      if (previous.length === 1 && previous[0]!.table === 'canvas_nodes' && previous[0]!.key === changes[0]!.key &&
        JSON.stringify(previous[0]!.after) === JSON.stringify(changes[0]!.before)) {
        // The operation's created_at is the first keystroke; a later title-only save is not a content edit.
        previous[0]!.lastContentEditAt = singleContentSaveTime(changes[0]!) ?? previous[0]!.lastContentEditAt ?? singleContentSaveTime(previous[0]!);
        previous[0]!.after = changes[0]!.after;
        this.db.prepare('UPDATE operation_journal SET patch_json=? WHERE sequence=?').run(JSON.stringify(previous), latest.sequence);
        this.lastTextEditRevision = this.getBoardRevision() + 1;
        return;
      }
    }
    this.db.prepare("DELETE FROM operation_journal WHERE state='undone'").run();
    this.db.prepare(`INSERT INTO operation_journal (operation_id, label, patch_json, related_node_ids, state, created_at, edit_session_id)
      VALUES (?, ?, ?, ?, 'applied', ?, ?)`)
      .run(randomUUID(), label, JSON.stringify(changes), JSON.stringify([...new Set(relatedNodeIds)]), new Date().toISOString(), editSessionId ?? null);
    this.lastTextEditRevision = editSessionId ? this.getBoardRevision() + 1 : -1;
    this.pruneHistoryInTransaction();
  }

  private writeHistoryBarrierInTransaction(label: string): void {
    this.db.prepare("DELETE FROM operation_journal WHERE state='undone'").run();
    this.db.prepare(`INSERT INTO operation_journal (operation_id, label, patch_json, related_node_ids, state, created_at)
      VALUES (?, ?, '[]', '[]', 'barrier', ?)`)
      .run(randomUUID(), label, new Date().toISOString());
    this.pruneHistoryInTransaction();
  }

  private replayHistory(direction: 'undo' | 'redo'): HistoryStatus {
    const barrier = this.latestBarrierSequence();
    const ordering = direction === 'undo' ? 'DESC' : 'ASC';
    const state = direction === 'undo' ? 'applied' : 'undone';
    const targetState = direction === 'undo' ? 'undone' : 'applied';
    const entry = this.db.prepare(`SELECT * FROM operation_journal WHERE state=? AND sequence>? ORDER BY sequence ${ordering} LIMIT 1`)
      .get(state, barrier) as Row | undefined;
    if (!entry) return this.getHistoryStatus();
    const changes = parseHistoryChanges(entry.patch_json);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const ordered = direction === 'undo' ? [...changes].reverse() : [...changes];
      // Parent page rows must exist before restoring a node; page deletion comes last.
      ordered.sort((a, b) => Number(b.table === 'canvas_pages' && Boolean(direction === 'undo' ? b.before : b.after)) - Number(a.table === 'canvas_pages' && Boolean(direction === 'undo' ? a.before : a.after)));
      for (const change of ordered) this.restoreHistoryChange(change, direction === 'undo' ? change.before : change.after);
      this.db.prepare('UPDATE operation_journal SET state=? WHERE sequence=?').run(targetState, entry.sequence);
      const boardRevision = this.bumpRevisionInTransaction();
      this.db.exec('COMMIT');
      this.emitMutation(boardRevision);
      const rows = changes.map(change => ({ change, row: (direction === 'undo' ? change.before : change.after) ?? (direction === 'undo' ? change.after : change.before) }));
      const focus = rows.find(item => item.row?.page_id)?.row?.page_id ?? rows.find(item => item.change.table === 'canvas_pages' && item.row)?.change.key;
      const focusPageId = typeof focus === 'string' && this.getPages().some(page => page.id === focus) ? focus : undefined;
      if (focusPageId) this.setSettingRaw('activePageId', focusPageId);
      return { ...this.getHistoryStatus(), ...(focusPageId ? { focusPageId } : {}) };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private getHistoryRow(table: HistoryTable, key: string): HistoryChange['before'] {
    const keyColumn = historyKeyColumn(table);
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE ${keyColumn}=?`).get(key) as Row | undefined;
    if (!row) return null;
    return Object.fromEntries(Object.entries(row).map(([column, value]) => [column, value === null ? null :
      typeof value === 'bigint' ? Number(value) : value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value])) as HistoryChange['before'];
  }

  private restoreHistoryChange(change: HistoryChange, row: HistoryChange['before']): void {
    const keyColumn = historyKeyColumn(change.table);
    if (!row) {
      this.db.prepare(`DELETE FROM ${change.table} WHERE ${keyColumn}=?`).run(change.key);
      return;
    }
    if (change.table === 'canvas_nodes') row = { content_edited_at: null, note_schedule: null, page_id: DEFAULT_PAGE_ID, note_document: null, note_presentation: 'note', note_source: null, content_scale: 1, ...row };
    if (change.table === 'ink_strokes') row = { page_id: DEFAULT_PAGE_ID, ...row };
    if (change.table === 'canvas_pages') {
      const current = this.db.prepare('SELECT * FROM canvas_pages WHERE id=?').get(change.key) as Row | undefined;
      if (current) row = { ...row, viewport_json: current.viewport_json as string };
      if (current?.archived_at && !row.archived_at) row = { ...row, auto_check_paused: 1 };
    }
    const columns = Object.keys(row);
    const placeholders = columns.map(() => '?').join(',');
    const updates = columns.filter((column) => column !== keyColumn).map((column) => `${column}=excluded.${column}`).join(',');
    this.db.prepare(`INSERT INTO ${change.table} (${columns.join(',')}) VALUES (${placeholders})
      ON CONFLICT(${keyColumn}) DO UPDATE SET ${updates}`).run(...columns.map((column) => row[column]));
  }

  private purgeNodeHistoryInTransaction(nodeId: string): void {
    const rows = this.db.prepare("SELECT sequence, related_node_ids FROM operation_journal WHERE state<>'barrier'").all() as Row[];
    for (const row of rows) {
      if (parseStringArray(row.related_node_ids).includes(nodeId)) {
        this.db.prepare('DELETE FROM operation_journal WHERE sequence=?').run(row.sequence);
      }
    }
  }

  private pruneHistoryInTransaction(): void {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString();
    this.db.prepare("DELETE FROM operation_journal WHERE state<>'barrier' AND created_at<?").run(cutoff);
    this.db.prepare(`DELETE FROM operation_journal WHERE state<>'barrier' AND sequence NOT IN (
      SELECT sequence FROM operation_journal WHERE state<>'barrier' ORDER BY sequence DESC LIMIT 200
    )`).run();
    this.db.prepare(`DELETE FROM operation_journal WHERE state='barrier' AND sequence < (
      SELECT COALESCE(MAX(sequence), 0) FROM operation_journal WHERE state='barrier'
    )`).run();
  }

  private recordMutation(): number {
    const boardRevision = this.getBoardRevision() + 1;
    this.setSettingRaw('boardRevision', String(boardRevision));
    this.emitMutation(boardRevision);
    return boardRevision;
  }

  private bumpRevisionInTransaction(): number {
    const boardRevision = this.getBoardRevision() + 1;
    this.setSettingRaw('boardRevision', String(boardRevision));
    return boardRevision;
  }

  private emitMutation(boardRevision: number): void {
    for (const listener of this.mutationListeners) {
      try { listener(boardRevision); } catch { /* mutation observers must not roll back committed board state */ }
    }
  }

  private cleanupDemoDataOnce(): DemoCleanupResult {
    if (this.databasePath === ':memory:' || this.getSetting('demoCleanupV1') === 'complete') return emptyDemoCleanup();
    const demoThreads = Number((this.db.prepare("SELECT COUNT(*) AS total FROM threads WHERE source_kind='demo'").get() as Row).total);
    const demoProjects = Number((this.db.prepare(`SELECT COUNT(*) AS total FROM projects p
      WHERE p.host_id='demo' AND NOT EXISTS (
        SELECT 1 FROM threads t WHERE t.project_key=p.project_key AND t.source_kind<>'demo'
      )`).get() as Row).total);
    const demoImports = Number((this.db.prepare("SELECT COUNT(*) AS total FROM snapshot_imports WHERE source='demo'").get() as Row).total);
    if (demoThreads + demoProjects + demoImports === 0) {
      this.setSettingRaw('demoCleanupV1', 'complete');
      return emptyDemoCleanup();
    }

    const backupDirectory = path.join(path.dirname(this.databasePath), 'backups');
    fs.mkdirSync(backupDirectory, { recursive: true });
    const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
    const backupPath = path.join(backupDirectory, `zz-board-pre-demo-cleanup-${timestamp}-${randomUUID().slice(0, 8)}.sqlite`);
    this.db.prepare('VACUUM INTO ?').run(backupPath);

    let taskNodesRemoved = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      taskNodesRemoved = Number((this.db.prepare(`SELECT COUNT(*) AS total FROM canvas_nodes
        WHERE kind='task' AND (thread_key IN (SELECT thread_key FROM threads WHERE source_kind='demo') OR project_key IN (
          SELECT p.project_key FROM projects p WHERE p.host_id='demo' AND NOT EXISTS (
            SELECT 1 FROM threads t WHERE t.project_key=p.project_key AND t.source_kind<>'demo'
          )
        ))`).get() as Row).total);
      this.db.prepare(`DELETE FROM canvas_nodes
        WHERE kind='task' AND (thread_key IN (SELECT thread_key FROM threads WHERE source_kind='demo') OR project_key IN (
          SELECT p.project_key FROM projects p WHERE p.host_id='demo' AND NOT EXISTS (
            SELECT 1 FROM threads t WHERE t.project_key=p.project_key AND t.source_kind<>'demo'
          )
        ))`).run();
      this.db.prepare(`DELETE FROM todos WHERE project_key IN (
        SELECT p.project_key FROM projects p WHERE p.host_id='demo' AND NOT EXISTS (
          SELECT 1 FROM threads t WHERE t.project_key=p.project_key AND t.source_kind<>'demo'
        )
      ) OR (json_array_length(source_thread_keys) > 0 AND NOT EXISTS (
        SELECT 1 FROM json_each(todos.source_thread_keys) source
        LEFT JOIN threads t ON t.thread_key=source.value
        WHERE t.thread_key IS NULL OR t.source_kind<>'demo'
      ))`).run();
      this.db.prepare(`DELETE FROM project_briefs WHERE project_key IN (
        SELECT p.project_key FROM projects p WHERE p.host_id='demo' AND NOT EXISTS (
          SELECT 1 FROM threads t WHERE t.project_key=p.project_key AND t.source_kind<>'demo'
        ))`).run();
      this.db.prepare("DELETE FROM threads WHERE source_kind='demo'").run();
      this.db.prepare(`DELETE FROM projects WHERE host_id='demo' AND NOT EXISTS (
        SELECT 1 FROM threads t WHERE t.project_key=projects.project_key
      )`).run();
      this.db.prepare("DELETE FROM snapshot_imports WHERE source='demo'").run();
      this.setSettingRaw('demoCleanupV1', 'complete');
      this.writeHistoryBarrierInTransaction('清理演示数据');
      const boardRevision = this.bumpRevisionInTransaction();
      this.db.exec('COMMIT');
      this.emitMutation(boardRevision);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { performed: true, backupPath, projectsRemoved: demoProjects, threadsRemoved: demoThreads, taskNodesRemoved };
  }

  private migrateAppearanceV05(newBoard: boolean): void {
    if (this.getSetting('appearanceMigrationV05') === 'complete') return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const key = 'activeSkinRef';
      if (!this.getSetting(key)) {
        this.setSettingRaw(key, newBoard ? DEFAULT_SKIN_KEY : LEGACY_SKIN_KEY);
        if (!newBoard && (this.getSetting('skinComponents') !== null || this.db.prepare('SELECT 1 FROM canvas_nodes LIMIT 1').get())) {
          this.recordHistoryInTransaction('升级默认外观为夜墨 2.0', [{ table: 'settings', key, before: null, after: this.getHistoryRow('settings', key) }], []);
          this.bumpRevisionInTransaction();
        }
      }
      this.setSettingRaw('appearanceMigrationV05', 'complete');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private migrateContentEditTimes(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('ALTER TABLE canvas_nodes ADD COLUMN content_edited_at TEXT');
      // Retained old operations can prove an edit. A gap or an undated merged save cannot.
      const known = new Map<string, { revision: number; time: string | null }>();
      const live = new Map<string, { revision: number; time: string | null }>();
      const entries = this.db.prepare("SELECT sequence, state, label, patch_json FROM operation_journal WHERE state IN ('applied','undone') ORDER BY sequence").all() as Row[];
      const save = this.db.prepare('UPDATE operation_journal SET patch_json=? WHERE sequence=?');
      for (const entry of entries) {
        const changes = parseHistoryChanges(entry.patch_json);
        let touched = false;
        for (const change of changes) {
          if (change.table !== 'canvas_nodes' || (change.before ?? change.after)?.kind !== 'note') continue;
          touched = true;
          const { before, after } = change;
          const prior = known.get(change.key);
          const beforeTime = prior && prior.revision === before?.revision ? prior.time : null;
          if (before) before.content_edited_at = beforeTime;
          if (!after) { known.delete(change.key); if (entry.state === 'applied') live.delete(change.key); continue; }
          const evidence = entry.label === '迁移旧便签正文' ? undefined : change.lastContentEditAt ?? singleContentSaveTime(change);
          const time = evidence && Number.isFinite(Date.parse(evidence)) ? new Date(evidence).toISOString()
            : before && Number(after.revision) === Number(before.revision) + 1 ? beforeTime : null;
          after.content_edited_at = time;
          const item = { revision: Number(after.revision), time };
          known.set(change.key, item);
          if (entry.state === 'applied') live.set(change.key, item);
        }
        if (touched) save.run(JSON.stringify(changes), entry.sequence);
      }
      const update = this.db.prepare("UPDATE canvas_nodes SET content_edited_at=? WHERE kind='note' AND id=? AND revision=?");
      for (const [id, record] of live) if (record.time) update.run(record.time, id, record.revision);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private migrateNoteBodiesV06(): void {
    if (this.getSetting('noteBodyMigrationV06') === 'complete') return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changes: HistoryChange[] = [];
      const rows = this.db.prepare("SELECT * FROM canvas_nodes WHERE kind='note'").all() as Row[];
      for (const row of rows) {
        if (row.note_document || row.note_presentation === 'image') continue;
        const body = String(row.body).trim();
        const title = String(row.title).trim();
        if (!title || (body !== '' && body !== '写下一句话…')) continue;
        const id = String(row.id);
        const before = this.getHistoryRow('canvas_nodes', id);
        this.db.prepare('UPDATE canvas_nodes SET body=?, revision=revision+1, updated_at=? WHERE id=?')
          .run(title, new Date().toISOString(), id);
        changes.push({ table: 'canvas_nodes', key: id, before, after: this.getHistoryRow('canvas_nodes', id) });
      }
      // The marker is intentionally not undone: later intentional blank text is authoritative.
      this.setSettingRaw('noteBodyMigrationV06', 'complete');
      if (changes.length) {
        this.recordHistoryInTransaction('迁移旧便签正文', changes, changes.map((change) => change.key));
        this.bumpRevisionInTransaction();
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private getJsonSetting<T>(key: string, fallback: T): T {
    const value = this.getSetting(key);
    if (!value) return fallback;
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }

  private getNode(id: string): CanvasNodeRecord {
    const row = this.db.prepare('SELECT * FROM canvas_nodes WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new NotFoundError(`Node ${id} was not found.`);
    return toNode(row);
  }

  private upsertProject(project: SnapshotProject): void {
    this.db.prepare(`INSERT INTO projects
      (project_key, project_id, host_id, name, cwd, sidebar_index, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_key) DO UPDATE SET
        project_id=excluded.project_id, host_id=excluded.host_id, name=excluded.name,
        cwd=excluded.cwd, sidebar_index=excluded.sidebar_index, observed_at=excluded.observed_at
      WHERE excluded.observed_at >= projects.observed_at`)
      .run(project.projectKey, project.projectId ?? null, project.hostId ?? null, project.name, project.cwd ?? null, project.sidebarIndex ?? null, project.observedAt);
  }

  private upsertThread(thread: SnapshotThread): void {
    this.db.prepare(`INSERT INTO threads
      (thread_key, source_kind, host_id, thread_id, project_key, title, display_title, cwd, sidebar_index, observed_at, source_updated_at,
       runtime_state, work_state, human_action, action_strength, stop_point, evidence, confidence, last_observed_at, missing_since)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(thread_key) DO UPDATE SET
       source_kind=excluded.source_kind, host_id=excluded.host_id, thread_id=excluded.thread_id,
       project_key=excluded.project_key, title=excluded.title, display_title=excluded.display_title,
       cwd=excluded.cwd, sidebar_index=excluded.sidebar_index,
       observed_at=excluded.observed_at, source_updated_at=excluded.source_updated_at, runtime_state=excluded.runtime_state,
       work_state=excluded.work_state, human_action=excluded.human_action, action_strength=excluded.action_strength,
       stop_point=excluded.stop_point, evidence=excluded.evidence, confidence=excluded.confidence,
       last_observed_at=excluded.last_observed_at, missing_since=NULL`)
      .run(
        thread.threadKey, thread.sourceKind, thread.hostId ?? null, thread.threadId, thread.projectKey ?? null, thread.title,
        thread.displayTitle ?? thread.title,
        thread.cwd ?? null, thread.sidebarIndex ?? null, thread.observedAt, thread.sourceUpdatedAt ?? null, thread.runtimeState,
        thread.workState, thread.humanAction, thread.actionStrength, thread.stopPoint, thread.evidence, thread.confidence, thread.observedAt
      );
    if (thread.recap) {
      this.db.prepare('UPDATE threads SET recap_json=? WHERE thread_key=?').run(JSON.stringify(thread.recap), thread.threadKey);
      if (thread.projectKey) this.timeline.recordRecap(thread.projectKey, thread.threadKey, thread.title, thread.sourceUpdatedAt ?? thread.observedAt, thread.recap);
    }
  }

  private upsertProjectBrief(brief: ProjectBrief): void {
    this.db.prepare(`INSERT INTO project_briefs
      (project_key, overview, current_stage, work_state, stop_point, codex_or_external_next, evidence_level,
       evidence_reason, confidence, last_meaningful_at, observed_at, last_observed_at, missing_since)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(project_key) DO UPDATE SET
       overview=excluded.overview, current_stage=excluded.current_stage, work_state=excluded.work_state,
       stop_point=excluded.stop_point, codex_or_external_next=excluded.codex_or_external_next,
       evidence_level=excluded.evidence_level, evidence_reason=excluded.evidence_reason, confidence=excluded.confidence,
       last_meaningful_at=excluded.last_meaningful_at, observed_at=excluded.observed_at,
       last_observed_at=excluded.last_observed_at, missing_since=NULL`)
      .run(
        brief.projectKey, brief.overview, brief.currentStage, brief.workState, brief.stopPoint,
        brief.codexOrExternalNext, brief.evidenceLevel, brief.evidenceReason, brief.confidence,
        brief.lastMeaningfulAt ?? null, brief.observedAt, brief.observedAt
      );
  }

  private upsertTodo(todo: SnapshotTodo): void {
    this.db.prepare(`INSERT INTO todos
      (todo_key, project_key, source_thread_keys, kind, strength, title, minimum_action, why_now, unlocks,
       evidence, explicit_deadline, confidence, sidebar_index, observed_at, last_observed_at, missing_since)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(todo_key) DO UPDATE SET
       project_key=excluded.project_key, source_thread_keys=excluded.source_thread_keys, kind=excluded.kind,
       strength=excluded.strength, title=excluded.title, minimum_action=excluded.minimum_action,
       why_now=excluded.why_now, unlocks=excluded.unlocks, evidence=excluded.evidence,
       explicit_deadline=excluded.explicit_deadline, confidence=excluded.confidence,
       sidebar_index=excluded.sidebar_index, observed_at=excluded.observed_at,
       last_observed_at=excluded.last_observed_at, missing_since=NULL`)
      .run(
        todo.todoKey, todo.projectKey, JSON.stringify(todo.sourceThreadKeys), todo.kind, todo.strength, todo.title,
        todo.minimumAction, todo.whyNow, todo.unlocks, todo.evidence, todo.explicitDeadline ?? null,
        todo.confidence, todo.sidebarIndex ?? null, todo.observedAt, todo.observedAt
      );
    this.db.prepare('UPDATE todos SET action_evidence_json=? WHERE todo_key=?').run(todo.actionEvidence ? JSON.stringify(todo.actionEvidence) : null, todo.todoKey);
  }

  private backfillLegacySummaries(): void {
    const projects = (this.db.prepare('SELECT * FROM projects ORDER BY rowid').all() as Row[]).map(toProject);
    if (projects.length === 0) return;
    const existingBriefKeys = new Set((this.db.prepare('SELECT project_key FROM project_briefs').all() as Row[])
      .map((row) => String(row.project_key)));
    if (projects.every((project) => existingBriefKeys.has(project.projectKey))) return;
    const threads = (this.db.prepare('SELECT * FROM threads ORDER BY rowid').all() as Row[]).map(toThread);
    const observedAt = latestTimestamp([
      ...projects.map((project) => project.observedAt),
      ...threads.map((thread) => thread.lastObservedAt)
    ]) || new Date().toISOString();
    const summaries = deriveLegacySummaries(projects, threads, observedAt);
    const existingTodos = (this.db.prepare('SELECT * FROM todos WHERE missing_since IS NULL').all() as Row[]).map(toTodo);
    const existingSourceThreads = new Set(existingTodos.flatMap((todo) => todo.sourceThreadKeys));
    const existingSignatures = new Set(existingTodos.map(todoIdentity));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const brief of summaries.projectBriefs) {
        const current = this.db.prepare('SELECT project_key FROM project_briefs WHERE project_key = ?').get(brief.projectKey);
        if (!current) this.upsertProjectBrief(brief);
      }
      for (const todo of summaries.todos) {
        const current = this.db.prepare('SELECT todo_key FROM todos WHERE todo_key = ?').get(todo.todoKey);
        const overlapsExistingSource = todo.sourceThreadKeys.some((threadKey) => existingSourceThreads.has(threadKey));
        if (!current && !overlapsExistingSource && !existingSignatures.has(todoIdentity(todo))) this.upsertTodo(todo);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private backfillProjectNodes(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.ensureProjectNodes() > 0) this.bumpRevisionInTransaction();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private ensureProjectNodes(): number {
    const projects = (this.db.prepare(`SELECT p.* FROM projects p
      WHERE NOT EXISTS (SELECT 1 FROM canvas_nodes n WHERE n.project_key=p.project_key)
      ORDER BY COALESCE(p.sidebar_index, 2147483647), p.rowid`).all() as Row[]).map(toProject);
    const occupied = (this.db.prepare(`SELECT * FROM canvas_nodes
      WHERE project_key IS NOT NULL OR (kind='note' AND archived_at IS NULL)`).all() as Row[]).map(row => toNode(row));
    const placements = projects.map((project) => {
      const oldestThreadNode = this.db.prepare(`SELECT n.* FROM canvas_nodes n
        JOIN threads t ON t.thread_key=n.thread_key WHERE t.project_key=?
        ORDER BY n.created_at, n.rowid LIMIT 1`).get(project.projectKey) as Row | undefined;
      const inherited = oldestThreadNode ? toNode(oldestThreadNode) : undefined;
      // Reserve all inherited locations before placing empty projects, including later sidebar entries.
      if (inherited) occupied.push(inherited);
      return { project, inherited };
    });
    for (const { project, inherited } of placements) {
      // Keep the original thread nodes (and all attached annotations/links) intact.
      const targetPageId = inherited?.pageId || this.getDefaultPageId();
      const geometry = inherited ?? {
        ...findInboxPosition(occupied.filter(node => pageId(node) === targetPageId), 176, 176), width: 176, height: 176, zIndex: 0
      };
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO canvas_nodes
        (id, kind, thread_key, project_key, x, y, width, height, z_index, title, body, last_viewed_at, revision, created_at, updated_at, page_id)
        VALUES (?, 'task', NULL, ?, ?, ?, ?, ?, ?, ?, '', NULL, 0, ?, ?, ?)`)
        .run(projectNodeId(project.projectKey), project.projectKey, geometry.x, geometry.y,
          geometry.width, geometry.height, geometry.zIndex, project.name, now, now, targetPageId);
      occupied.push(this.getNode(projectNodeId(project.projectKey)));
    }
    return projects.length;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_key TEXT PRIMARY KEY, project_id TEXT, host_id TEXT, name TEXT NOT NULL, cwd TEXT,
        sidebar_index INTEGER, observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        thread_key TEXT PRIMARY KEY, source_kind TEXT NOT NULL, host_id TEXT, thread_id TEXT NOT NULL,
        project_key TEXT REFERENCES projects(project_key), title TEXT NOT NULL, cwd TEXT, sidebar_index INTEGER,
        observed_at TEXT NOT NULL, source_updated_at TEXT, runtime_state TEXT NOT NULL, work_state TEXT NOT NULL,
        human_action TEXT NOT NULL, action_strength TEXT NOT NULL, stop_point TEXT NOT NULL, evidence TEXT NOT NULL,
        confidence TEXT NOT NULL, last_observed_at TEXT NOT NULL, missing_since TEXT
      );
      CREATE TABLE IF NOT EXISTS canvas_nodes (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('task','note')), thread_key TEXT UNIQUE REFERENCES threads(thread_key),
        x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL, z_index INTEGER NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, last_viewed_at TEXT, manual_priority TEXT CHECK(manual_priority IN ('p1','p2','p3')),
        note_schedule TEXT, content_edited_at TEXT,
        aspect_locked INTEGER CHECK(aspect_locked IN (0,1)),
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deleted_note_requests (node_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS conversation_note_requests (node_id TEXT PRIMARY KEY, digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS annotations (
        id TEXT PRIMARY KEY, target_node_id TEXT NOT NULL REFERENCES canvas_nodes(id) ON DELETE CASCADE,
        body TEXT NOT NULL, resolved INTEGER NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_links (
        id TEXT PRIMARY KEY, source_node_id TEXT NOT NULL REFERENCES canvas_nodes(id) ON DELETE CASCADE,
        target_node_id TEXT NOT NULL REFERENCES canvas_nodes(id) ON DELETE CASCADE, label TEXT NOT NULL,
        revision INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ink_strokes (
        id TEXT PRIMARY KEY, tool TEXT NOT NULL CHECK(tool IN ('pen','highlighter')), points_json TEXT NOT NULL,
        color TEXT NOT NULL, size REAL NOT NULL, opacity REAL NOT NULL,
        layer TEXT NOT NULL CHECK(layer IN ('background','foreground')), z_index INTEGER NOT NULL,
        revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operation_journal (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
        patch_json TEXT NOT NULL, related_node_ids TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('applied','undone','barrier')), created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operation_journal_state_sequence ON operation_journal(state, sequence);
      CREATE TABLE IF NOT EXISTS snapshot_imports (
        digest TEXT PRIMARY KEY, generated_at TEXT NOT NULL, source TEXT NOT NULL, imported_at TEXT NOT NULL,
        project_count INTEGER NOT NULL, thread_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_briefs (
        project_key TEXT PRIMARY KEY REFERENCES projects(project_key), overview TEXT NOT NULL, current_stage TEXT NOT NULL,
        work_state TEXT NOT NULL, stop_point TEXT NOT NULL, codex_or_external_next TEXT NOT NULL,
        evidence_level TEXT NOT NULL, evidence_reason TEXT NOT NULL, confidence TEXT NOT NULL,
        last_meaningful_at TEXT, observed_at TEXT NOT NULL, last_observed_at TEXT NOT NULL, missing_since TEXT
      );
      CREATE TABLE IF NOT EXISTS todos (
        todo_key TEXT PRIMARY KEY, project_key TEXT NOT NULL REFERENCES projects(project_key), source_thread_keys TEXT NOT NULL,
        kind TEXT NOT NULL, strength TEXT NOT NULL, title TEXT NOT NULL, minimum_action TEXT NOT NULL,
        why_now TEXT NOT NULL, unlocks TEXT NOT NULL, evidence TEXT NOT NULL, explicit_deadline TEXT,
        confidence TEXT NOT NULL, sidebar_index INTEGER, observed_at TEXT NOT NULL,
        last_observed_at TEXT NOT NULL, missing_since TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_todos_active_order ON todos(missing_since, sidebar_index);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_sources (thread_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, source_updated_at TEXT NOT NULL, evidence_checked_at TEXT NOT NULL, runtime_state TEXT);
    `);
    const threadColumns = this.db.prepare('PRAGMA table_info(threads)').all() as Row[];
    if (!(this.db.prepare('PRAGMA table_info(sync_sources)').all() as Row[]).some(column => column.name === 'runtime_state'))
      this.db.exec('ALTER TABLE sync_sources ADD COLUMN runtime_state TEXT');
    if (!threadColumns.some(column => String(column.name) === 'recap_json')) this.db.exec('ALTER TABLE threads ADD COLUMN recap_json TEXT');
    if (!(this.db.prepare('PRAGMA table_info(todos)').all() as Row[]).some(column => String(column.name) === 'action_evidence_json')) this.db.exec('ALTER TABLE todos ADD COLUMN action_evidence_json TEXT');
    if (!threadColumns.some((column) => String(column.name) === 'display_title')) {
      this.db.exec('ALTER TABLE threads ADD COLUMN display_title TEXT');
    }
    this.db.exec("UPDATE threads SET display_title=title WHERE display_title IS NULL OR trim(display_title)=''");
    const nodeColumns = this.db.prepare('PRAGMA table_info(canvas_nodes)').all() as Row[];
    if (!nodeColumns.some((column) => String(column.name) === 'project_key')) {
      this.db.exec('ALTER TABLE canvas_nodes ADD COLUMN project_key TEXT REFERENCES projects(project_key)');
    }
    if (!nodeColumns.some((column) => String(column.name) === 'archived_at')) {
      this.db.exec('ALTER TABLE canvas_nodes ADD COLUMN archived_at TEXT');
    }
    if (!nodeColumns.some((column) => String(column.name) === 'manual_priority')) {
      this.db.exec("ALTER TABLE canvas_nodes ADD COLUMN manual_priority TEXT CHECK(manual_priority IN ('p1','p2','p3'))");
    }
    if (!nodeColumns.some((column) => String(column.name) === 'skin_ref')) {
      this.db.exec('ALTER TABLE canvas_nodes ADD COLUMN skin_ref TEXT');
    }
    if (!nodeColumns.some((column) => String(column.name) === 'aspect_locked')) {
      this.db.exec('ALTER TABLE canvas_nodes ADD COLUMN aspect_locked INTEGER CHECK(aspect_locked IN (0,1))');
    }
    if (!nodeColumns.some((column) => String(column.name) === 'folded_into_node_id')) this.db.exec('ALTER TABLE canvas_nodes ADD COLUMN folded_into_node_id TEXT');
    if (!nodeColumns.some((column) => String(column.name) === 'note_document')) this.db.exec('ALTER TABLE canvas_nodes ADD COLUMN note_document TEXT');
    if (!nodeColumns.some(column => column.name === 'content_edited_at')) this.migrateContentEditTimes();
    if (!nodeColumns.some(column => column.name === 'note_schedule')) this.db.exec('ALTER TABLE canvas_nodes ADD COLUMN note_schedule TEXT');
    if (!nodeColumns.some((column) => String(column.name) === 'note_source')) this.db.exec('ALTER TABLE canvas_nodes ADD COLUMN note_source TEXT');
    if (!nodeColumns.some((column) => String(column.name) === 'content_scale')) this.db.exec('ALTER TABLE canvas_nodes ADD COLUMN content_scale REAL NOT NULL DEFAULT 1');
    if (!nodeColumns.some((column) => String(column.name) === 'note_presentation')) this.db.exec("ALTER TABLE canvas_nodes ADD COLUMN note_presentation TEXT NOT NULL DEFAULT 'note'");
    this.db.exec('CREATE TABLE IF NOT EXISTS media_assets (id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL)');
    const linkColumns = this.db.prepare('PRAGMA table_info(local_links)').all() as Row[];
    if (!linkColumns.some((column) => String(column.name) === 'bend_json')) this.db.exec('ALTER TABLE local_links ADD COLUMN bend_json TEXT');
    const journalColumns = this.db.prepare('PRAGMA table_info(operation_journal)').all() as Row[];
    if (!journalColumns.some((column) => String(column.name) === 'edit_session_id')) this.db.exec('ALTER TABLE operation_journal ADD COLUMN edit_session_id TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_nodes_project ON canvas_nodes(project_key)');
    this.migratePages();
  }
}

function toPage(row: Row): CanvasPageRecord {
  return { id: String(row.id), name: String(row.name), sortOrder: Number(row.sort_order),
    viewport: JSON.parse(String(row.viewport_json)), backgroundSkinRef: nullable(row, 'background_skin_ref'),
    wallpaper: row.wallpaper_json ? JSON.parse(String(row.wallpaper_json)) as Wallpaper : null,
    archivedAt: nullable(row, 'archived_at'), autoCheckPaused: Boolean(row.auto_check_paused), revision: Number(row.revision),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

function emptyDemoCleanup(): DemoCleanupResult {
  return { performed: false, backupPath: null, projectsRemoved: 0, threadsRemoved: 0, taskNodesRemoved: 0 };
}

function defaultDrawingPreferences(): DrawingPreferences {
  return {
    penColor: '#243241', penSize: 4, highlighterColor: '#f1c75b', highlighterSize: 18,
    highlighterColorSlots: ['#f1c75b', '#f39dba', '#a4d785', '#86c9ed', '#b9a1e3', '#f2aa73'],
    eraserMode: 'whole', lassoMode: 'ink', layer: 'background', paletteCollapsed: true
  };
}

function nonnegativeInteger(value: string | null): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export class RevisionConflictError extends Error {
  constructor(readonly current: CanvasNodeRecord | InkStrokeRecord | LocalLinkRecord | CanvasPageRecord) { super('The item changed after it was opened.'); }
}
export class NotFoundError extends Error {}
export class InvalidNodeOperationError extends Error {}
export class DeletedNoteRequestError extends Error {}

function nullable(row: Row, key: string): string | null { return row[key] === null || row[key] === undefined ? null : String(row[key]); }
function nullableBoolean(row: Row, key: string): boolean | null { return row[key] === null || row[key] === undefined ? null : Boolean(row[key]); }
function encodeNullableBoolean(value: boolean | null | undefined): number | null { return value === null || value === undefined ? null : value ? 1 : 0; }
function optional(row: Row, key: string): string | undefined { return row[key] === null || row[key] === undefined ? undefined : String(row[key]); }
function optionalNumber(row: Row, key: string): number | undefined { return row[key] === null || row[key] === undefined ? undefined : Number(row[key]); }

function toProject(row: Row): SnapshotProject {
  return { projectKey: String(row.project_key), projectId: optional(row, 'project_id'), hostId: optional(row, 'host_id'), name: String(row.name), cwd: optional(row, 'cwd'), sidebarIndex: optionalNumber(row, 'sidebar_index'), observedAt: String(row.observed_at) };
}
function toThread(row: Row): BoardState['threads'][number] {
  const recap = typeof row.recap_json === 'string' ? threadRecapSchema.parse(JSON.parse(row.recap_json)) : undefined;
  return {
    threadKey: String(row.thread_key), sourceKind: String(row.source_kind) as BoardState['threads'][number]['sourceKind'], hostId: optional(row, 'host_id'),
    threadId: String(row.thread_id), projectKey: optional(row, 'project_key'), title: String(row.title),
    displayTitle: optional(row, 'display_title') || String(row.title), cwd: optional(row, 'cwd'),
    sidebarIndex: optionalNumber(row, 'sidebar_index'), observedAt: String(row.observed_at), sourceUpdatedAt: optional(row, 'source_updated_at'),
    runtimeState: String(row.runtime_state) as BoardState['threads'][number]['runtimeState'], workState: String(row.work_state) as BoardState['threads'][number]['workState'],
    humanAction: String(row.human_action) as BoardState['threads'][number]['humanAction'], actionStrength: String(row.action_strength) as BoardState['threads'][number]['actionStrength'],
    stopPoint: String(row.stop_point), evidence: String(row.evidence), confidence: String(row.confidence) as BoardState['threads'][number]['confidence'],
    lastObservedAt: String(row.last_observed_at), missingSince: nullable(row, 'missing_since'),
    recap, ...(recap && typeof row.collected_fingerprint === 'string' ? { recapOutdated: recap.sourceFingerprint !== row.collected_fingerprint } : {})
  };
}
function toProjectBrief(row: Row): BoardProjectBrief {
  return {
    projectKey: String(row.project_key),
    overview: String(row.overview),
    currentStage: String(row.current_stage),
    workState: String(row.work_state) as BoardProjectBrief['workState'],
    stopPoint: String(row.stop_point),
    codexOrExternalNext: String(row.codex_or_external_next),
    evidenceLevel: String(row.evidence_level) as BoardProjectBrief['evidenceLevel'],
    evidenceReason: String(row.evidence_reason),
    confidence: String(row.confidence) as BoardProjectBrief['confidence'],
    lastMeaningfulAt: optional(row, 'last_meaningful_at'),
    observedAt: String(row.observed_at),
    lastObservedAt: String(row.last_observed_at),
    missingSince: nullable(row, 'missing_since')
  };
}
function toTodo(row: Row): BoardTodo {
  return {
    todoKey: String(row.todo_key),
    projectKey: String(row.project_key),
    sourceThreadKeys: parseStringArray(row.source_thread_keys),
    kind: String(row.kind) as BoardTodo['kind'],
    strength: String(row.strength) as BoardTodo['strength'],
    title: String(row.title),
    minimumAction: String(row.minimum_action),
    whyNow: String(row.why_now),
    unlocks: String(row.unlocks),
    evidence: String(row.evidence),
    explicitDeadline: optional(row, 'explicit_deadline'),
    actionEvidence: row.action_evidence_json ? JSON.parse(String(row.action_evidence_json)) as BoardTodo['actionEvidence'] : undefined,
    confidence: String(row.confidence) as BoardTodo['confidence'],
    sidebarIndex: optionalNumber(row, 'sidebar_index'),
    observedAt: String(row.observed_at),
    lastObservedAt: String(row.last_observed_at),
    missingSince: nullable(row, 'missing_since')
  };
}
function toNode(row: Row, priorityDate = localCalendarDate()): CanvasNodeRecord {
  const manualPriority = nullable(row, 'manual_priority') as CanvasNodeRecord['manualPriority'];
  const noteSchedule = row.note_schedule ? noteScheduleSchema.parse(JSON.parse(String(row.note_schedule))) : null;
  const source = row.note_source ? { noteSource: conversationNoteSourceSchema.parse(JSON.parse(String(row.note_source))) } : {};
  return { ...priorityOnDate({ manualPriority, noteSchedule }, priorityDate), ...source, noteSchedule, contentEditedAt: nullable(row, 'content_edited_at'), pageId: String(row.page_id ?? DEFAULT_PAGE_ID), contentScale: Number(row.content_scale ?? 1), id: String(row.id), kind: String(row.kind) as 'task' | 'note', threadKey: nullable(row, 'thread_key'), projectKey: nullable(row, 'project_key'), archivedAt: nullable(row, 'archived_at'), manualPriority, skinRef: nullable(row, 'skin_ref'), aspectLocked: nullableBoolean(row, 'aspect_locked'), foldedIntoNodeId: nullable(row, 'folded_into_node_id'), x: Number(row.x), y: Number(row.y), width: Number(row.width), height: Number(row.height), zIndex: Number(row.z_index), title: String(row.title), body: String(row.body), noteDocument: row.note_document ? noteDocumentSchema.parse(JSON.parse(String(row.note_document))) : null, notePresentation: row.note_presentation === 'image' ? 'image' : 'note', lastViewedAt: nullable(row, 'last_viewed_at'), revision: Number(row.revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
function toAnnotation(row: Row): AnnotationRecord {
  return { id: String(row.id), targetNodeId: String(row.target_node_id), body: String(row.body), resolved: Boolean(row.resolved), revision: Number(row.revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
function toLink(row: Row): LocalLinkRecord {
  return { id: String(row.id), sourceNodeId: String(row.source_node_id), targetNodeId: String(row.target_node_id), label: String(row.label), bend: row.bend_json ? JSON.parse(String(row.bend_json)) as LocalLinkRecord['bend'] : null, revision: Number(row.revision), createdAt: String(row.created_at) };
}

function toInkStroke(row: Row): InkStrokeRecord {
  return {
    id: String(row.id),
    pageId: String(row.page_id ?? DEFAULT_PAGE_ID),
    tool: String(row.tool) as InkStrokeRecord['tool'],
    points: parseInkPoints(row.points_json),
    color: String(row.color),
    size: Number(row.size),
    opacity: Number(row.opacity),
    layer: String(row.layer) as InkStrokeRecord['layer'],
    zIndex: Number(row.z_index),
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function parseInkPoints(value: SqlValue | undefined): InkStrokeRecord['points'] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((point): point is InkStrokeRecord['points'][number] => Boolean(point) && typeof point === 'object' &&
      Number.isFinite((point as { x?: unknown }).x) && Number.isFinite((point as { y?: unknown }).y) &&
      Number.isFinite((point as { pressure?: unknown }).pressure));
  } catch {
    return [];
  }
}

// Old merged rows retain only their endpoints. Without a saved content timestamp we cannot date the edit.
function singleContentSaveTime({table, before, after}: HistoryChange): string | undefined {
  if (table !== 'canvas_nodes' || before?.kind !== 'note' || after?.kind !== 'note' || typeof after.updated_at !== 'string'
      || Number(after.revision) !== Number(before.revision) + 1) return undefined;
  if (before.body !== after.body) return after.updated_at;
  if ((before.note_document ?? null) === (after.note_document ?? null)) return undefined;
  const content = (row: NonNullable<HistoryChange['before']>): NoteContent => ({
    body: String(row.body), noteDocument: row.note_document ? noteDocumentSchema.parse(JSON.parse(String(row.note_document))) : null
  });
  return sameDisplayedContent(content(before), content(after)) ? undefined : after.updated_at;
}

function historyKeyColumn(table: HistoryTable): string {
  return table === 'settings' ? 'key' : 'id';
}

function parseHistoryChanges(value: SqlValue | undefined): HistoryChange[] {
  if (typeof value !== 'string') throw new Error('History entry is unreadable.');
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error('History entry is invalid.');
  const allowed = new Set<HistoryTable>(['canvas_pages', 'canvas_nodes', 'annotations', 'local_links', 'ink_strokes', 'settings']);
  return parsed.map((item) => {
    if (!item || typeof item !== 'object' || !allowed.has((item as HistoryChange).table) || typeof (item as HistoryChange).key !== 'string') {
      throw new Error('History entry contains an unsafe table or key.');
    }
    return item as HistoryChange;
  });
}

function nodeHistoryLabel(current: CanvasNodeRecord, patch: Record<string, unknown>): string {
  if ('foldedIntoNodeId' in patch) return patch.foldedIntoNodeId ? '收纳便签' : '展开便签';
  if ('skinRef' in patch) return '设置节点 Skin';
  if ('aspectLocked' in patch) return patch.aspectLocked === false ? '解除气泡比例锁' : '锁定气泡比例';
  if ('body' in patch || 'title' in patch || 'noteDocument' in patch) return current.kind === 'note' ? '编辑便签' : '编辑节点';
  if ('width' in patch || 'height' in patch) return current.kind === 'note' ? '调整便签大小' : '调整气泡大小';
  if ('x' in patch || 'y' in patch) return current.kind === 'note' ? '移动便签' : '移动气泡';
  return '更新节点';
}

function inkHistoryLabel(input: InkBatchInput): string {
  if (input.deletes.length && !input.creates.length && !input.updates.length) return '擦除墨迹';
  if (input.updates.length && !input.creates.length && !input.deletes.length) return '编辑墨迹';
  if (input.creates.length && !input.updates.length && !input.deletes.length) return '绘制墨迹';
  return '批量编辑墨迹';
}

function parseStringArray(value: SqlValue | undefined): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function snapshotSummaries(snapshot: BoardSnapshot): { projectBriefs: ProjectBrief[]; todos: SnapshotTodo[] } {
  if (snapshot.schemaVersion !== 1) return { projectBriefs: snapshot.projectBriefs, todos: snapshot.todos };
  return deriveLegacySummaries(snapshot.projects, snapshot.threads, snapshot.generatedAt);
}

function deriveLegacySummaries(
  projects: SnapshotProject[],
  threads: SnapshotThread[],
  observedAt: string
): { projectBriefs: ProjectBrief[]; todos: SnapshotTodo[] } {
  const projectBriefs = projects.map((project): ProjectBrief => {
    const associated = threads
      .filter((thread) => thread.projectKey === project.projectKey)
      .sort((a, b) => legacyThreadScore(b) - legacyThreadScore(a) || timestampOf(b) - timestampOf(a));
    const lead = associated[0];
    if (!lead) {
      return {
        projectKey: project.projectKey,
        overview: '旧版快照包含该项目，但没有可关联的任务内容。',
        currentStage: '未知（无近期任务证据）',
        workState: 'insufficient_evidence',
        stopPoint: '未知：没有关联任务可以证明项目停在何处。',
        codexOrExternalNext: '先深读项目或导入 V2 快照，再判断下一步。',
        evidenceLevel: 'none',
        evidenceReason: '由 Snapshot V1 保守补全；项目没有关联任务。',
        confidence: 'low',
        observedAt
      };
    }
    return {
      projectKey: project.projectKey,
      overview: `旧版快照记录了 ${associated.length} 条关联任务；未提供独立的项目级摘要。`,
      currentStage: `按代表任务暂记为：${workStateLabel(lead.workState)}`,
      workState: lead.workState,
      stopPoint: lead.stopPoint || '未知：代表任务没有停点说明。',
      codexOrExternalNext: '旧版快照未提供项目级 Codex/外部下一步；需以关联任务证据复核。',
      evidenceLevel: lead.sourceKind === 'codex' && lead.workState === 'insufficient_evidence' ? 'runtime_snapshot' : 'summary_only',
      evidenceReason: `由 Snapshot V1 保守补全；代表任务 ${lead.threadKey}：${lead.evidence || '无进一步证据说明'}`,
      confidence: lead.confidence === 'high' ? 'medium' : lead.confidence,
      lastMeaningfulAt: lead.sourceUpdatedAt || lead.observedAt,
      observedAt
    };
  });

  const groups = new Map<string, SnapshotThread[]>();
  for (const thread of threads) {
    if (!hasExplicitUnresolvedAction(thread) || !thread.projectKey) continue;
    const fingerprint = [thread.projectKey, thread.humanAction, normalizedEvidence(thread.stopPoint)].join('\u0000');
    const group = groups.get(fingerprint) || [];
    group.push(thread);
    groups.set(fingerprint, group);
  }

  const projectByKey = new Map(projects.map((project) => [project.projectKey, project]));
  const todos: SnapshotTodo[] = [...groups.entries()].map(([fingerprint, grouped]) => {
    const sorted = [...grouped].sort((a, b) => legacyThreadScore(b) - legacyThreadScore(a) || timestampOf(b) - timestampOf(a));
    const lead = sorted[0]!;
    const kind = lead.humanAction as TodoActionKind;
    const strength = lead.actionStrength as TodoStrength;
    const digest = createHash('sha256').update(fingerprint).digest('hex').slice(0, 24);
    return {
      todoKey: `legacy:${digest}`,
      projectKey: lead.projectKey!,
      sourceThreadKeys: sorted.map((thread) => thread.threadKey),
      kind,
      strength,
      title: `${actionLabel(kind)}：${lead.title}`,
      minimumAction: `${actionMinimum(kind)}（关联任务：${lead.title}）`,
      whyNow: lead.stopPoint,
      unlocks: '旧版快照未提供明确的解锁说明；完成前请在关联任务中复核。',
      evidence: `Snapshot V1 明确标记 ${strength}/${kind}；${lead.evidence}`,
      confidence: lead.confidence === 'high' ? 'medium' : lead.confidence,
      sidebarIndex: projectByKey.get(lead.projectKey!)?.sidebarIndex ?? lead.sidebarIndex,
      observedAt: latestTimestamp(sorted.map((thread) => thread.observedAt)) || observedAt
    };
  });
  return { projectBriefs, todos };
}

function hasExplicitUnresolvedAction(thread: SnapshotThread): boolean {
  return Boolean(thread.projectKey && thread.stopPoint.trim() && thread.evidence.trim()) &&
    thread.humanAction !== 'none' && thread.humanAction !== 'uncertain' &&
    thread.actionStrength !== 'none' && thread.workState !== 'complete' && thread.workState !== 'intentionally_closed';
}

function normalizedEvidence(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function todoIdentity(todo: Pick<SnapshotTodo, 'projectKey' | 'kind' | 'whyNow'>): string {
  return [todo.projectKey, todo.kind, normalizedEvidence(todo.whyNow)].join('\u0000');
}

function legacyThreadScore(thread: SnapshotThread): number {
  return (thread.actionStrength === 'blocking' ? 100 : thread.actionStrength === 'recommended' ? 40 : thread.actionStrength === 'optional' ? 10 : 0) +
    (thread.workState === 'waiting_for_user' ? 30 : thread.workState === 'needs_validation' ? 20 : 0);
}

function timestampOf(thread: SnapshotThread): number {
  const value = Date.parse(thread.sourceUpdatedAt || thread.observedAt);
  return Number.isFinite(value) ? value : 0;
}

function latestTimestamp(values: string[]): string | undefined {
  return values.filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

function evidenceRank(level: string): number {
  return ({ none: 0, runtime_snapshot: 1, summary_only: 2, deep_read: 3, file_verified: 4 })[level] ?? 0;
}

function workStateLabel(state: SnapshotThread['workState']): string {
  return ({
    in_progress: '进行中', stage_closed: '阶段性收口', intentionally_closed: '主动收口',
    waiting_for_user: '等你行动', waiting_external: '等外部条件', needs_validation: '待验证',
    complete: '已完成', insufficient_evidence: '证据不足'
  })[state];
}

function actionLabel(action: TodoActionKind): string {
  return ({
    test: '测试', review: '审阅', read_learn: '阅读/学习', decide: '决策', provide_material: '补充材料',
    approve: '批准/授权', reply_continue: '回复继续', wait: '等待/监控'
  })[action];
}

function actionMinimum(action: TodoActionKind): string {
  return ({
    test: '完成最小关键测试并记录结果', review: '审阅最新产物并给出一条明确反馈',
    read_learn: '阅读已指明的材料并记录关键结论', decide: '选择当前分支并记录决定',
    provide_material: '补充最小所需文件或数据', approve: '批准或拒绝当前待授权动作',
    reply_continue: '回复继续推进所需的指令', wait: '仅监控外部条件，无需主动推进'
  })[action];
}
