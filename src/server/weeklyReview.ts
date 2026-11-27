import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Milestone } from '../shared/milestones.js';

export type ReviewWeek = 'previous' | 'current';

function localDay(date: Date): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function calendarWeek(week: ReviewWeek, now: Date) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (start.getDay() + 6) % 7 - (week === 'previous' ? 7 : 0));
  const next = new Date(start);
  next.setDate(start.getDate() + 7);
  const sunday = new Date(next.getTime() - 1);
  const through = week === 'previous' ? sunday : now;
  return { start, through, period: {week, startDate:localDay(start), endDate:localDay(sunday), through:through.toISOString(),
    timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone} };
}

/** Date-only evidence names a local calendar day. Timed evidence must name its offset. */
function evidenceTime(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return NaN;
  const day = value.slice(0, 10);
  const valid = new Date(day + 'T00:00:00Z');
  if (!Number.isFinite(valid.getTime()) || valid.toISOString().slice(0, 10) !== day) return NaN;
  return Date.parse(value.length === 10 ? value + 'T00:00:00' : value);
}

type Fact = {
  kind: Milestone['kind']; id: string; occurredAt: string; title: string; sourceKind: 'file' | 'thread';
  detail: string | null; resolution: Milestone['resolution']; version: Milestone['version'];
};
type Activity = {kind:'conversation' | 'noteCreated' | 'noteEdited'; id:string; occurredAt:string};
type Evidence = Fact | Activity;
type Project = {projectKey:string; name:string; archived:boolean};
type Accumulator = {
  project:Project; facts:Map<string, Fact>; conversations:Map<string, Activity>; noteChanges:Activity[]; earlier:Evidence | null;
};
const factLimit = 4;
const activityLimit = 2;
const order = (a:Evidence, b:Evidence) => evidenceTime(b.occurredAt) - evidenceTime(a.occurredAt) || a.id.localeCompare(b.id);
const textOrNull = (value: unknown) => typeof value === 'string' ? value : null;

// A legacy key can embed an absolute workspace inside a larger source ID. Reserve the alias prefix for generated IDs.
function weeklyReference(kind:'project' | 'thread' | 'note' | 'event', key:string):string {
  if (key && !/[^\p{L}\p{M}\p{N} ._:@-]/u.test(key) && !/(?:^|:)(?:cwd|path):/i.test(key) && !/^zzb-week:/i.test(key)) return key;
  return 'zzb-week:' + kind + ':' + createHash('sha256').update(kind + '\0' + key).digest('hex').slice(0,32);
}
function cited<T extends Evidence>(item:T):T {
  const kind = item.kind === 'conversation' ? 'thread' : item.kind === 'noteCreated' || item.kind === 'noteEdited' ? 'note' : 'event';
  return {...item, id:weeklyReference(kind,item.id)};
}
function weeklyName(name:string):string {
  const directory = /\\|[a-z]:\/|(?:^|[\s:=])\/\S|(?:^|:)(?:cwd|path|file):|%(?:25)*(?:2f|5c)|^[a-z]:$/i;
  const label = name.trim();
  if (!directory.test(label)) return label || '项目';
  const leaf = label.split(/[\\/]/).filter(Boolean).at(-1)?.trim();
  return leaf && !directory.test(leaf) ? leaf : '项目';
}

/** Reads narrowly selected columns from saved records. No work, imports, or read receipts are scheduled. */
export function readWeeklyReview(db:DatabaseSync, week:ReviewWeek, now:Date) {
  const {start, through, period} = calendarWeek(week, now);
  const projects = new Map<string, Accumulator>();
  let demoProjectsExcluded = 0, undatedMilestones = 0;
  for (const row of db.prepare(`SELECT p.project_key,p.name,n.archived_at AS bubble_archived,pg.archived_at AS page_archived,
      (p.host_id='demo' AND NOT EXISTS(SELECT 1 FROM threads t WHERE t.project_key=p.project_key AND t.source_kind<>'demo')) AS demo
    FROM projects p LEFT JOIN canvas_nodes n ON n.project_key=p.project_key AND n.kind='task'
    LEFT JOIN canvas_pages pg ON pg.id=n.page_id ORDER BY p.project_key`).iterate()) {
    if (row.demo) { demoProjectsExcluded++; continue; }
    const key = String(row.project_key);
    const project = {projectKey:weeklyReference('project', key), name:weeklyName(String(row.name)), archived:Boolean(row.bubble_archived || row.page_archived)};
    projects.set(key, {project, facts:new Map(), conversations:new Map(), noteChanges:[], earlier:null});
  }
  // Compare facts by their event date only. A recently imported or re-summarized old event stays old.
  function observe(group:Accumulator, item:Evidence):boolean {
    const time = evidenceTime(item.occurredAt);
    if (!Number.isFinite(time) || time > through.getTime()) return false;
    if (time >= start.getTime()) return true;
    if (!group.earlier || order(item, group.earlier) < 0) group.earlier = item;
    return false;
  }

  const milestones = db.prepare(`SELECT m.project_key,m.event_key,m.group_key,m.sort_date AS occurred_at,
      json_extract(m.data_json,'$.sourceKind') AS source_kind, json_extract(m.data_json,'$.value.kind') AS kind,
      json_extract(m.data_json,'$.value.title') AS title, json_extract(m.data_json,'$.value.resolution') AS resolution,
      substr(coalesce(json_extract(m.data_json,'$.value.decision'),json_extract(m.data_json,'$.value.result'),
        json_extract(m.data_json,'$.value.problem')),1,240) AS detail, json_extract(m.data_json,'$.value.version') AS version
    FROM project_milestones m WHERE json_extract(m.data_json,'$.sourceKind')='file'
      OR (json_extract(m.data_json,'$.sourceKind')='thread' AND EXISTS (SELECT 1 FROM threads t
        WHERE t.thread_key=m.source_key AND t.project_key=m.project_key AND t.source_kind<>'demo'))`);
  for (const row of milestones.iterate()) {
    const group = projects.get(String(row.project_key));
    if (!group) continue;
    if (!Number.isFinite(evidenceTime(row.occurred_at))) { undatedMilestones++; continue; }
    const fact:Fact = {kind:row.kind as Fact['kind'], id:String(row.event_key), occurredAt:String(row.occurred_at),
      title:String(row.title), sourceKind:row.source_kind as Fact['sourceKind'], detail:textOrNull(row.detail),
      resolution:row.resolution as Fact['resolution'], version:row.version ? JSON.parse(String(row.version)) : null};
    if (!observe(group, fact)) continue;
    // Different sources can corroborate one product/version/stage. Keep withdrawn or conflicting resolutions distinguishable.
    const key = fact.version ? JSON.stringify([row.group_key, fact.version.stage, fact.resolution]) : fact.id;
    const existing = group.facts.get(key);
    if (!existing || order(fact, existing) < 0) group.facts.set(key, fact);
  }

  // Retained source-turn dates can place a conversation in an older week even after its latest update moved on.
  // Neither the text of turns nor any source file paths enter this projection.
  const conversations = db.prepare(`WITH real AS (SELECT thread_key,project_key,source_updated_at,recap_json
      FROM threads WHERE source_kind<>'demo' AND project_key IS NOT NULL)
    SELECT project_key,thread_key,source_updated_at AS occurred_at FROM real WHERE source_updated_at IS NOT NULL
    UNION ALL SELECT t.project_key,t.thread_key,json_extract(s.value,'$.occurredAt') FROM real t,json_each(t.recap_json,'$.sources') s
      WHERE json_extract(s.value,'$.role') IN ('user','assistant')
    UNION ALL SELECT t.project_key,t.thread_key,json_extract(v.data,'$.occurredAt') FROM real t
      JOIN conversation_columns c ON c.thread_key=t.thread_key AND c.project_key=t.project_key
      JOIN conversation_turns v ON v.thread_key=t.thread_key WHERE v.data IS NOT NULL`);
  for (const row of conversations.iterate()) {
    const group = projects.get(String(row.project_key));
    if (!group) continue;
    const item:Activity = {kind:'conversation', id:String(row.thread_key), occurredAt:String(row.occurred_at)};
    if (!observe(group, item)) continue;
    const existing = group.conversations.get(item.id);
    if (!existing || order(item, existing) < 0) group.conversations.set(item.id, item);
  }

  // A shared, orphaned, or ambiguously linked note cannot substantiate a particular project's activity.
  const notes = db.prepare(`WITH edges(note_id,task_id) AS (
      SELECT source_node_id,target_node_id FROM local_links UNION ALL SELECT target_node_id,source_node_id FROM local_links
    ), owners AS (
      SELECT e.note_id,e.task_id,CASE WHEN a.thread_key IS NULL THEN a.project_key
        WHEN t.source_kind<>'demo' AND (a.project_key IS NULL OR a.project_key=t.project_key) THEN t.project_key END AS project_key
      FROM edges e JOIN canvas_nodes a ON a.id=e.task_id AND a.kind='task' JOIN canvas_nodes n ON n.id=e.note_id AND n.kind='note'
      LEFT JOIN threads t ON t.thread_key=a.thread_key
    )
    SELECT n.id, min(o.project_key) AS project_key,n.created_at,n.content_edited_at FROM owners o JOIN canvas_nodes n ON n.id=o.note_id
    GROUP BY n.id HAVING count(o.project_key)=count(*) AND count(DISTINCT o.project_key)=1
      AND (n.note_source IS NULL OR json_extract(n.note_source,'$.projectKey')=min(o.project_key))`);
  for (const row of notes.iterate()) {
    const group = projects.get(String(row.project_key));
    if (!group) continue;
    const record = (kind:Activity['kind'], raw:unknown) => {
      if (typeof raw !== 'string') return;
      const item = {kind, id:String(row.id), occurredAt:raw};
      if (observe(group, item)) group.noteChanges.push(item);
    };
    record('noteCreated', row.created_at);
    if (row.content_edited_at !== row.created_at) record('noteEdited', row.content_edited_at);
  }

  const activeProjects = [], oldProjects = [];
  for (const {project, facts, conversations:threads, noteChanges, earlier} of projects.values()) {
    if (!facts.size && !threads.size && !noteChanges.length) {
      if (earlier && !project.archived) oldProjects.push({ ...project, lastRecorded:cited(earlier) });
      continue;
    }
    activeProjects.push({...project, counts:{milestones:facts.size, conversations:threads.size,
      notesCreated:noteChanges.filter(n => n.kind === 'noteCreated').length, notesEdited:noteChanges.filter(n => n.kind === 'noteEdited').length},
      milestones:[...facts.values()].sort(order).slice(0, factLimit).map(cited), activities:[...threads.values(), ...noteChanges].sort(order).slice(0, activityLimit).map(cited)});
  }
  activeProjects.sort((a,b) => b.counts.milestones - a.counts.milestones || a.projectKey.localeCompare(b.projectKey));
  oldProjects.sort((a,b) => order(a.lastRecorded, b.lastRecorded) || a.projectKey.localeCompare(b.projectKey));
  return {schemaVersion:1, period, coverage:{registeredProjects:projects.size, activeProjects:activeProjects.length,
    withoutDatedActivityThisWeek:projects.size-activeProjects.length, demoProjectsExcluded, undatedMilestones},
    activeProjects, earlierProjects:oldProjects.slice(0,2)};
}
