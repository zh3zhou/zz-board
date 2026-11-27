import { useEffect, useRef, useState } from 'react';
import { milestoneGroupKey, type HistoryPreview, type ProjectMilestone, type TimelinePage } from '../shared/milestones.js';
import type { SyncJob } from '../shared/summarySync.js';
import { api } from './api.js';
import { SyncJobCard } from './SummarySyncPanel.js';
import './timeline.css';

const stages = { source: '源码实现', built: '包已构建', running: '运行核验' };
const kinds = { achievement: '成果', decision: '决定', discussion: '讨论', version: '版本' };
const date = (value: string | null) => !value ? '时间未明确' : /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '时间未明确';
export function timelineGroups(items: ProjectMilestone[]): ProjectMilestone[][] {
  const groups = new Map<string, ProjectMilestone[]>();
  for (const item of items) {
    const key = milestoneGroupKey(item);
    const group = groups.get(key) ?? []; group.push(item); groups.set(key, group);
  }
  return [...groups.values()];
}
export function mergeMilestones(previous: ProjectMilestone[], fresh: ProjectMilestone[]): ProjectMilestone[] {
  const records = new Map(previous.map(item => [item.key, item]));
  for (const item of fresh) records.set(item.key, item);
  return [...records.values()];
}
export function mergeTimelinePages(previous: TimelinePage, next: TimelinePage): TimelinePage {
  // A revision can land between page requests. The older page was not read at
  // the newer watermark, so never acknowledge that unseen revision.
  return { ...next, throughSequence: Math.min(previous.throughSequence, next.throughSequence), items: mergeMilestones(previous.items, next.items) };
}
export function MilestoneCard({ items }: { items: ProjectMilestone[] }) {
  const item = items[0]!; const value = item.value; const version = value.version;
  return <article className={`milestone-card${items.some(item => item.unread) ? ' has-update' : ''}`}>
    <header><span>{kinds[value.kind]} · {date(value.occurredAt)}</span>{items.some(item => item.unread) && <small className="conversation-update">新进展</small>}</header>
    <h4>{version ? `${version.product || ''} ${version.number}`.trim() : value.title}</h4>
    {version ? (Object.keys(stages) as Array<keyof typeof stages>).map(stage => {
      const records = items.filter(entry => entry.value.version?.stage === stage);
      if (!records.length) return null;
      return <div className="milestone-stage" key={stage}><h5>{stages[stage]} · {date(records[0]!.value.occurredAt)}</h5>
        <MilestoneDetails entry={records[0]!} />
        {records.length > 1 && <details><summary>其他 {records.length - 1} 条相关记录</summary>{records.slice(1).map(entry => <div key={entry.key}><small>{date(entry.value.occurredAt)}</small><MilestoneDetails entry={entry} /></div>)}</details>}
      </div>;
    }) : <div className="milestone-stage"><MilestoneDetails entry={item} /></div>}
  </article>;
}
function MilestoneDetails({ entry }: { entry: ProjectMilestone }) {
  return <>
      {entry.value.problem && <p><b>问题</b>{entry.value.problem}</p>}
      {entry.value.options.length > 0 && <details><summary>讨论过的方案</summary><ul>{entry.value.options.map((option, i) => <li key={i}>{option}</li>)}</ul></details>}
      {entry.value.decision && <p><b>决定</b>{entry.value.decision}</p>}
      {!entry.value.decision && ['discussion', 'decision'].includes(entry.value.kind) && entry.value.resolution === 'open' && <p className="timeline-muted">尚未决定</p>}
      {entry.value.resolution === 'withdrawn' && <p>此前决定已撤回，以这里的更新依据为准。</p>}
      {entry.value.result && <p><b>{entry.value.resolution === 'open' ? '当前进展' : '结果'}</b>{entry.value.result}</p>}
      <small className="timeline-muted">{entry.sourceLabel}</small>
      <details className="milestone-evidence"><summary>查看依据{entry.revision > 1 ? ` · 已修订 ${entry.revision - 1} 次` : ''}</summary>
        {entry.sources.map(source => <p key={source.id}>{source.role === 'file' ? '项目记录' : source.role === 'user' ? '用户记录' : '助手记录'} · {date(source.occurredAt)}{source.heading && <span>{source.heading}</span>}<code>{source.path || source.turnId || source.id}</code></p>)}
        <small>检查于 {date(entry.checkedAt)} · 整理于 {date(entry.summarizedAt)}；不代表事件发生时间。</small>
        {entry.revision > 1 && <MilestoneRevisions item={entry} />}
      </details>
  </>;
}
function MilestoneRevisions({ item }: { item: ProjectMilestone }) {
  const [history, setHistory] = useState<ProjectMilestone[]>([]); const [error, setError] = useState('');
  return <div><button onClick={() => void api.timelineRevisions(item.projectKey, item.key).then(result => { setHistory(result.items); setError(''); }).catch(() => setError('暂时无法读取修订记录。'))}>查看修订记录</button>{error && <p>{error}</p>}{history.slice(1).map(entry => <div key={entry.revision}><small>修订 {entry.revision} · {date(entry.summarizedAt)}</small><p>{entry.value.decision || entry.value.problem || entry.value.title}</p>{entry.value.result && <p>{entry.value.result}</p>}</div>)}</div>;
}
export function ProjectTimeline({ projectKey, online, revision, compact = false, onOpen }: { projectKey: string; online: boolean; revision: number; compact?: boolean; onOpen?(): void }) {
  const [page, setPage] = useState<TimelinePage | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<HistoryPreview | null>(null); const [job, setJob] = useState<SyncJob | null>(null);
  const generation = useRef(0); const nextOffset = useRef<number | null>(null); const loadedPages = useRef(1);
  useEffect(() => { setPage(null); setPreview(null); setJob(null); nextOffset.current = null; loadedPages.current = 1; }, [projectKey]);
  function acknowledge(result: TimelinePage, id: number) {
    const keys = new Set(result.items.map(item => item.key));
    void api.readTimeline(projectKey, result.throughSequence, [...keys]).then(() => {
      if (generation.current !== id) return;
      const seen = (item: ProjectMilestone) => keys.has(item.key) && item.changeSequence <= result.throughSequence;
      setPage(current => current ? { ...current, unread: Math.max(0, current.unread - current.items.filter(item => item.unread && seen(item)).length),
        items: current.items.map(item => seen(item) ? { ...item, unread: false } : item) } : current);
    }).catch(() => undefined);
  }
  useEffect(() => {
    const id = ++generation.current; if (!online) return;
    void (async () => {
      let result = await api.timeline(projectKey);
      // Refresh the range the reader opened, not just page one: an old event
      // may gain a decision without changing its original occurrence date.
      for (let index = 1; index < loadedPages.current && result.nextOffset !== null && generation.current === id; index++) {
        const next = await api.timeline(projectKey, result.nextOffset);
        result = mergeTimelinePages(result, next);
      }
      return result;
    })().then(result => {
      if (generation.current !== id) return;
      setPage(result);
      nextOffset.current = result.nextOffset; setError('');
      if (!compact && result.items.length) acknowledge(result, id);
    }).catch(() => { if (generation.current === id) setError('暂时无法读取历程，已有内容保留。'); });
    return () => { generation.current++; };
  }, [projectKey, online, revision, compact]);
  useEffect(() => {
    if (!online || !job || !['queued', 'running'].includes(job.state)) return;
    let cancelled = false; const timer = setInterval(() => void api.syncJobs().then(result => { if (!cancelled) setJob(current => result.jobs.find(value => value.id === current?.id) ?? current); }).catch(() => undefined), 1500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [online, job?.id, job?.state]);
  async function more() {
    if (nextOffset.current === null) return; setBusy(true); const id = generation.current;
    try { const result = await api.timeline(projectKey, nextOffset.current); if (id !== generation.current) return;
      setPage(current => ({ ...result, items: mergeMilestones(current?.items ?? [], result.items) })); nextOffset.current = result.nextOffset; loadedPages.current++;
      acknowledge(result, id);
    } catch { setError('更早的历程暂时没有加载成功。'); } finally { setBusy(false); }
  }
  async function backfill(apply: boolean) {
    setBusy(true); setError('');
    try { if (!apply) setPreview(await api.historyPreview(projectKey)); else if (preview) { setJob(await api.backfillHistory(projectKey, preview.fingerprint)); setPreview(null); } }
    catch (error) { setError(error instanceof Error ? error.message : '未能补充历史。'); } finally { setBusy(false); }
  }
  const groups = timelineGroups(page?.items ?? []);
  return <section className="project-timeline" aria-label={compact ? '历程精选' : '项目历程'}>
    <div className="timeline-heading"><h3>{compact ? '历程精选' : '项目历程'}</h3>{Boolean(page?.unread) && <small className="conversation-update">{page!.unread} 项新进展</small>}</div>
    {error && <p role="status">{error}</p>}
    {!page && !error && <p className="timeline-muted">{online ? '正在读取历程…' : '连接后可查看历程。'}</p>}
    {(compact ? groups.slice(0, 3) : groups).map(items => <MilestoneCard key={items[0]!.key} items={items} />)}
    {page && !groups.length && <p className="timeline-muted">这里会留下重要成果、决定和讨论。旧记录可在历程页按需补充。</p>}
    {compact ? <button onClick={onOpen}>查看项目历程</button> : <>
      {nextOffset.current !== null && <button disabled={!online || busy} onClick={() => void more()}>更早的历程</button>}
      <details className="history-backfill"><summary>补充历史记录</summary><p>只读取本机项目的版本与进度文档，不回看完整对话。没有变化的章节不重复总结。</p>
        <button disabled={!online || busy} onClick={() => void backfill(false)}>查看可补充的记录</button>
        {preview && <div>{preview.files.map(file => <p key={file.name}>{file.name} · {file.blocks} 段，其中 {file.pending} 段需要整理</p>)}
          <p>预计新增 {preview.pending} 次总结，输入约 {preview.estimatedInputTokens.map(value => value.toLocaleString('zh-CN')).join('–')} token；不含输出、推理和运行时开销。</p>
          {preview.gaps.map((gap, i) => <small className="timeline-muted" key={i}>{gap}</small>)}<button disabled={!online || busy || preview.pending === 0} onClick={() => void backfill(true)}>确认补充</button></div>}
      </details>
      {job && <SyncJobCard job={job} online={online} busy={busy} onAction={action => void api.syncJobAction(job.id, action).then(setJob).catch(() => setError('操作未完成，请到同步设置重试。'))} />}
    </>}
  </section>;
}
