import type { DatabaseSync } from 'node:sqlite';
import type { ProjectRefreshResult, SavedProjectCheck } from '../shared/projectRefresh.js';
import { blockingCheckFailure, LOCAL_REFRESH_LIMIT } from '../shared/projectRefresh.js';
import type { SyncJob } from '../shared/summarySync.js';

/** One bounded receipt per project. No excerpts, model prompts or canvas history. */
export class ProjectCheckStore {
  private readonly verified = new Set<(token: string) => void>();
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS project_checks (
      project_key TEXT PRIMARY KEY REFERENCES projects(project_key) ON DELETE CASCADE,
      job_id TEXT, recovery_token TEXT, complete_scope INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS project_checks_job ON project_checks(job_id) WHERE job_id IS NOT NULL;`);
    // A read without a submitted job cannot resume after process exit.
    db.prepare(`UPDATE project_checks SET data=json_set(data, '$.outcome','failed', '$.failureCode','interrupted')
      WHERE job_id IS NULL AND json_extract(data,'$.outcome')='checking'`).run();
    // Recover if the process exited between the job write and the receipt write.
    const pending = db.prepare(`SELECT p.project_key,j.data FROM project_checks p LEFT JOIN sync_jobs j ON j.id=p.job_id
      WHERE p.job_id IS NOT NULL AND json_extract(p.data,'$.outcome')='checking'`).all();
    for (const row of pending) {
      if (typeof row.data === 'string') this.observeJob(JSON.parse(row.data) as SyncJob);
      else db.prepare(`UPDATE project_checks SET job_id=NULL,data=json_set(data,'$.jobId',NULL,'$.outcome','failed','$.failureCode','interrupted') WHERE project_key=?`).run(row.project_key!);
    }
  }

  get(projectKey: string): SavedProjectCheck {
    const row = this.db.prepare('SELECT data FROM project_checks WHERE project_key=?').get(projectKey);
    const status: SavedProjectCheck = row ? JSON.parse(String(row.data)) : { projectKey, attemptedAt: null, lastVerifiedAt: null,
      latestEvidenceCheckAt: null, outcome: 'unknown', readCount: 0, sources: [], limitedExcerpts: false, updatedThreadKeys: [], jobId: null, failureCode: null };
    // Older boards saved checks per conversation, without a project receipt.
    const latest = this.db.prepare(`SELECT MAX(COALESCE(s.evidence_checked_at,json_extract(t.recap_json,'$.evidenceCheckedAt'))) AS checked
      FROM threads t LEFT JOIN sync_sources s USING(thread_key)
      WHERE t.project_key=? AND t.source_kind='codex' AND COALESCE(t.host_id,'local')='local'`).get(projectKey)?.checked;
    if (typeof latest === 'string' && (!status.latestEvidenceCheckAt || Date.parse(latest) > Date.parse(status.latestEvidenceCheckAt))) status.latestEvidenceCheckAt = latest;
    return status;
  }

  begin(projectKey: string, attemptedAt: string, token: string | null): void {
    const prior = this.get(projectKey);
    const data: SavedProjectCheck = { ...prior, attemptedAt, outcome: 'checking', readCount: 0, sources: [], limitedExcerpts: false, updatedThreadKeys: [], jobId: null, failureCode: null };
    this.db.prepare(`INSERT INTO project_checks(project_key,recovery_token,data) VALUES (?,?,?) ON CONFLICT(project_key)
      DO UPDATE SET job_id=NULL,recovery_token=excluded.recovery_token,complete_scope=0,data=excluded.data`)
      .run(projectKey, token, JSON.stringify(data));
  }

  failed(projectKey: string, attemptedAt: string, code: string): void {
    this.db.prepare(`UPDATE project_checks SET data=json_set(data,'$.outcome','failed','$.failureCode',?)
      WHERE project_key=? AND json_extract(data,'$.attemptedAt')=? AND job_id IS NULL`).run(code, projectKey, attemptedAt);
  }

  collected(result: ProjectRefreshResult, job: SyncJob | null): void {
    const status = this.get(result.projectKey);
    if (status.attemptedAt !== result.checkedAt) return;
    status.sources = (result.sources ?? []).slice(0, LOCAL_REFRESH_LIMIT);
    status.limitedExcerpts = result.limitedExcerpts === true;
    status.readCount = result.readCount;
    if (result.readCount && (!status.latestEvidenceCheckAt || Date.parse(status.latestEvidenceCheckAt) < Date.parse(result.checkedAt))) status.latestEvidenceCheckAt = result.checkedAt;
    status.jobId = job?.id ?? null;
    if (!status.jobId) { status.outcome = 'failed'; status.failureCode = 'read_failed'; }
    this.db.prepare('UPDATE project_checks SET job_id=?,complete_scope=?,data=? WHERE project_key=?')
      .run(status.jobId, Number(result.coverageComplete === true), JSON.stringify(status), result.projectKey);
    if (job?.id) this.observeJob(job);
  }

  observeJob(job: SyncJob): void {
    const row = this.db.prepare('SELECT project_key,complete_scope,recovery_token,data FROM project_checks WHERE job_id=?').get(job.id);
    if (!row) return;
    const status = JSON.parse(String(row.data)) as SavedProjectCheck;
    if ((job.state === 'queued' || job.state === 'running') && status.outcome === 'checking') return;
    status.updatedThreadKeys = job.updatedThreadKeys ?? [];
    status.failureCode = null;
    if (job.state === 'complete') {
      // A skip may also mean a stale read, archived page or someone else's unfinished job.
      // Only a persisted recap for the evidence read in this attempt confirms the check.
      const matched = this.db.prepare(`SELECT 1 FROM threads t JOIN sync_sources s USING(thread_key)
        WHERE t.project_key=? AND t.thread_key=? AND s.evidence_checked_at=? AND s.fingerprint=?
        AND json_extract(t.recap_json,'$.sourceFingerprint')=s.fingerprint`);
      const confirmed = row.complete_scope && status.readCount > 0 && status.sources.length === status.readCount &&
        status.sources.every(source => source.state === 'read' && source.evidenceFingerprint && matched.get(status.projectKey, source.threadKey, status.attemptedAt, source.evidenceFingerprint));
      status.outcome = !confirmed ? 'partial' : status.updatedThreadKeys.length ? 'updated' : 'unchanged';
      if (confirmed) status.lastVerifiedAt = status.attemptedAt;
    } else if (job.state === 'paused' || job.state === 'cancelled') {
      status.outcome = job.completed ? 'partial' : 'failed';
      status.failureCode = job.state === 'cancelled' ? 'cancelled' : blockingCheckFailure(job) ?? job.failures?.[0]?.code ?? 'paused';
    } else status.outcome = 'checking';
    this.db.prepare('UPDATE project_checks SET data=? WHERE project_key=?').run(JSON.stringify(status), status.projectKey);
    if (typeof row.recovery_token === 'string' && (status.outcome === 'updated' || status.outcome === 'unchanged')) {
      for (const listener of this.verified) listener(row.recovery_token);
    }
  }

  hasVerified(token: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM project_checks WHERE recovery_token=? AND json_extract(data,'$.outcome') IN ('updated','unchanged')`).get(token));
  }
  onVerified(listener: (token: string) => void): () => void {
    this.verified.add(listener); return () => this.verified.delete(listener);
  }
}
