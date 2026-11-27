import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ThreadRecap } from '../shared/schema.js';
import { milestoneDateSchema, milestoneSchema, milestoneGroupKey, type FileEvidence, type Milestone, type MilestoneSource, type ProjectMilestone, type TimelinePage } from '../shared/milestones.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface TimelineOrigin { projectKey: string; sourceKey: string; sourceLabel: string; sourceKind: 'thread' | 'file'; threadKey: string | null; sourceUpdatedAt: string; checkedAt: string; summarizedAt: string }

/** Uses the board's existing connection and transaction. No canvas journal. */
export class TimelineStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS project_milestones (
      event_key TEXT PRIMARY KEY, project_key TEXT NOT NULL, source_key TEXT NOT NULL,
      content_hash TEXT NOT NULL, data_json TEXT NOT NULL, sort_date TEXT NOT NULL, group_key TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL, change_sequence INTEGER NOT NULL, seen_revision INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS idx_milestones_project ON project_milestones(project_key, sort_date DESC, event_key);
      CREATE TABLE IF NOT EXISTS milestone_revisions (
      event_key TEXT NOT NULL, revision INTEGER NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(event_key, revision));
      CREATE TABLE IF NOT EXISTS timeline_sources (
      source_key TEXT PRIMARY KEY, project_key TEXT NOT NULL, fingerprint TEXT NOT NULL, summarized_fingerprint TEXT, updated_at TEXT NOT NULL);
    `);
    if (!db.prepare('PRAGMA table_info(project_milestones)').all().some(column => column.name === 'group_key')) db.exec("ALTER TABLE project_milestones ADD COLUMN group_key TEXT NOT NULL DEFAULT ''");
    for (const row of db.prepare("SELECT event_key,data_json FROM project_milestones WHERE group_key='' ").all()) db.prepare('UPDATE project_milestones SET group_key=? WHERE event_key=?').run(milestoneGroupKey(JSON.parse(String(row.data_json))), row.event_key);
    db.exec('CREATE INDEX IF NOT EXISTS idx_milestones_group ON project_milestones(project_key,group_key)');
  }

  record(origin: TimelineOrigin, values: Milestone[], sources: MilestoneSource[], quiet = false): number {
    let changed = 0;
    for (const raw of values) {
      const value = milestoneSchema.parse(raw);
      const ownSources = sources.filter(source => value.sourceRefs.includes(source.id)).sort((a, b) => a.id.localeCompare(b.id));
      if (new Set(ownSources.map(source => source.id)).size !== new Set(value.sourceRefs).size) throw new Error('Invalid timeline evidence.');
      const identity = value.version ? ['version', value.version.product, value.version.number, value.version.stage] : ['event', value.id];
      const key = hash([origin.projectKey, origin.sourceKey, identity]);
      const old = this.db.prepare('SELECT * FROM project_milestones WHERE event_key=?').get(key);
      if (old) {
        const saved = JSON.parse(String(old.data_json)) as ProjectMilestone;
        if (origin.sourceKind === 'file' ? saved.checkedAt > origin.checkedAt : saved.sourceUpdatedAt > origin.sourceUpdatedAt) continue;
      }
      // IDs/order and check timestamps are not meaningful content changes.
      const contentHash = hash({ ...value, id: undefined, sourceRefs: undefined });
      if (old?.content_hash === contentHash) {
        const saved = JSON.parse(String(old.data_json)) as ProjectMilestone;
        this.db.prepare('UPDATE project_milestones SET data_json=? WHERE event_key=?').run(JSON.stringify({ ...saved, ...origin, value, sources: ownSources }), key);
        continue;
      }
      const revision = Number(old?.revision ?? 0) + 1;
      const sequence = Number(this.db.prepare('SELECT COALESCE(MAX(change_sequence),0)+1 AS n FROM project_milestones').get()!.n);
      const item: ProjectMilestone = { ...origin, key, value, sources: ownSources, revision, changeSequence: sequence, unread: !quiet };
      const data = JSON.stringify(item);
      this.db.prepare(`INSERT INTO project_milestones(event_key,project_key,source_key,content_hash,data_json,sort_date,revision,change_sequence,seen_revision,group_key)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO UPDATE SET content_hash=excluded.content_hash,data_json=excluded.data_json,
        sort_date=excluded.sort_date,revision=excluded.revision,change_sequence=excluded.change_sequence,group_key=excluded.group_key`)
        .run(key, origin.projectKey, origin.sourceKey, contentHash, data, value.occurredAt ?? '', revision, sequence, quiet ? revision : 0, milestoneGroupKey(item));
      this.db.prepare('INSERT INTO milestone_revisions(event_key,revision,data_json) VALUES (?,?,?)').run(key, revision, data);
      changed++;
    }
    return changed;
  }

  recordRecap(projectKey: string, threadKey: string, title: string, sourceUpdatedAt: string, recap: ThreadRecap, quiet = false): number {
    const values: Milestone[] = [...(recap.summary.milestones ?? [])];
    for (const achievement of recap.summary.milestones ? [] : recap.summary.achievements) {
      if (values.some(value => value.kind === 'achievement' && (value.id === achievement.id || value.title === achievement.title && value.result === achievement.detail))) continue;
      values.push({ id: achievement.id, kind: 'achievement', title: achievement.title, occurredAt: validDate(achievement.occurredAt),
        problem: null, options: [], decision: null, result: achievement.detail || achievement.title, resolution: 'delivered', sourceRefs: achievement.sourceRefs, version: null });
    }
    for (const version of recap.summary.milestones ? [] : recap.summary.versions) {
      if (values.some(value => value.version?.number === version.version && value.version.stage === version.stage)) continue;
      values.push({ id: `version:${version.version}:${version.stage}`, kind: 'version', title: version.version, occurredAt: null,
        problem: null, options: [], decision: null, result: ({ source: '源码已实现', built: '包已构建', running: '运行已核验' })[version.stage],
        resolution: version.stage === 'running' ? 'verified' : 'delivered', sourceRefs: version.sourceRefs,
        version: { product: null, number: version.version, stage: version.stage } });
    }
    return this.record({ projectKey, sourceKey: threadKey, sourceLabel: title, sourceKind: 'thread', threadKey, sourceUpdatedAt,
      checkedAt: recap.evidenceCheckedAt, summarizedAt: recap.summarizedAt }, values, recap.sources, quiet);
  }

  page(projectKey: string, offset = 0, limit = 20): TimelinePage {
    const groups = this.db.prepare('SELECT group_key,MAX(sort_date) AS date FROM project_milestones WHERE project_key=? GROUP BY group_key ORDER BY date DESC,group_key LIMIT ? OFFSET ?')
      .all(projectKey, Math.max(1, Math.min(limit, 50)), Math.max(0, offset));
    const rows = groups.flatMap(group => this.db.prepare('SELECT data_json,seen_revision,revision FROM project_milestones WHERE project_key=? AND group_key=? ORDER BY sort_date DESC,event_key').all(projectKey, group.group_key));
    const items = rows.map(row => ({ ...JSON.parse(String(row.data_json)) as ProjectMilestone, unread: Number(row.revision) > Number(row.seen_revision) }));
    const counts = this.db.prepare('SELECT COUNT(DISTINCT group_key) AS total,COALESCE(SUM(revision>seen_revision),0) AS unread,COALESCE(MAX(change_sequence),0) AS seq FROM project_milestones WHERE project_key=?').get(projectKey)!;
    const total = Number(counts.total);
    return { items, total, unread: Number(counts.unread), nextOffset: offset + groups.length < total ? offset + groups.length : null, throughSequence: Number(counts.seq) };
  }

  recentForSource(sourceKey: string): ProjectMilestone[] {
    return this.db.prepare('SELECT data_json FROM project_milestones WHERE source_key=? ORDER BY change_sequence DESC LIMIT 20').all(sourceKey)
      .map(row => JSON.parse(String(row.data_json)) as ProjectMilestone);
  }
  revisions(key: string): ProjectMilestone[] {
    return this.db.prepare('SELECT data_json FROM milestone_revisions WHERE event_key=? ORDER BY revision DESC LIMIT 50').all(key).map(row => JSON.parse(String(row.data_json)) as ProjectMilestone);
  }
  markRead(projectKey: string, throughSequence: number, keys: string[]): void {
    const statement = this.db.prepare('UPDATE project_milestones SET seen_revision=revision WHERE project_key=? AND change_sequence<=? AND event_key=?');
    for (const key of new Set(keys)) statement.run(projectKey, throughSequence, key);
  }
  fileCached(file: Pick<FileEvidence, 'fileKey' | 'fingerprint'>): boolean {
    return this.db.prepare('SELECT summarized_fingerprint FROM timeline_sources WHERE source_key=?').get(file.fileKey)?.summarized_fingerprint === file.fingerprint;
  }
  prepareFile(file: FileEvidence): void {
    this.db.prepare(`INSERT INTO timeline_sources(source_key,project_key,fingerprint,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(source_key) DO UPDATE SET fingerprint=excluded.fingerprint,updated_at=excluded.updated_at WHERE excluded.updated_at>=timeline_sources.updated_at`)
      .run(file.fileKey, file.projectKey, file.fingerprint, file.checkedAt);
  }
  fileCurrent(file: FileEvidence): boolean { return this.db.prepare('SELECT fingerprint FROM timeline_sources WHERE source_key=?').get(file.fileKey)?.fingerprint === file.fingerprint; }
  finishFile(file: FileEvidence): void { this.db.prepare('UPDATE timeline_sources SET summarized_fingerprint=? WHERE source_key=? AND fingerprint=?').run(file.fingerprint, file.fileKey, file.fingerprint); }
}
function validDate(value: string): string | null { const parsed = milestoneDateSchema.safeParse(value); return parsed.success ? parsed.data : null; }
