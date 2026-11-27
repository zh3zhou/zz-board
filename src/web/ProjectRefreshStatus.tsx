import { useEffect, useRef, useState } from 'react';
import { checkFailureMessage, type ProjectRefreshResult, type ProjectSourceCheck, type SavedProjectCheck } from '../shared/projectRefresh.js';
import type { SyncJob } from '../shared/summarySync.js';
import { api } from './api.js';
import { processedCount, summaryProblem } from './summaryFeedback.js';

export function refreshStatusText(result: ProjectRefreshResult, job: SyncJob | null): string {
  if (!job) return '暂时无法检查这些对话，原有内容仍在。';
  if (job.state === 'cancelled') return '更新已停止，已整理的内容已保留。';
  if (job.state === 'paused') return `${job.completed ? `已整理 ${job.completed} 条。` : ''}${summaryProblem(job)}`;
  if (job.state !== 'complete') return '可以继续浏览，整理好后会自动显示。';
  if (!job.total && job.skipped) return result.coverageComplete === false ? '已读到的内容无需重新整理，部分来源未能核对。' : '本次已读的内容无需重新整理。';
  const incomplete = result.sources?.filter(source => source.state !== 'read').length || 0;
  const updated = job.updatedThreadKeys?.length;
  return `${updated === undefined ? `已整理 ${job.completed} 条对话。` : updated ? `已更新 ${updated} 条对话。` : '检查完成，摘要没有变化。'}${incomplete ? `另有 ${incomplete} 条本次未检查。` : ''}`;
}

export function RefreshSources({ sources, updatedThreadKeys = [], onFocusThread }: { sources: ProjectSourceCheck[]; updatedThreadKeys?: string[]; onFocusThread?(key: string): void }) {
  const discovered = sources.filter(source => source.discovered);
  const visible = sources.filter(source => source.discovered || source.state !== 'not-read');
  return <div className="refresh-sources">
    {discovered.length > 0 && <p className="source-discovery" role="status">发现 {discovered.length} 条新对话，已加入列表。</p>}
    {visible.length > 0 && <details>
      <summary>查看检查记录</summary>
      {visible.map(source => <article key={source.threadKey}>
        <button className="recap-thread-link" onClick={() => onFocusThread?.(source.threadKey)} disabled={!onFocusThread}>{source.title}</button>
        <small>{source.discovered ? '新发现 · ' : ''}{source.state === 'read' ? updatedThreadKeys.includes(source.threadKey) ? '这次更新了对话记录' : '已读取近期正文' : source.state === 'unavailable' ? '本次正文不可用，原有内容保留' : '已建档，本次未深读'}</small>
        {source.sourceUpdatedAt && <small>源活动：{new Date(source.sourceUpdatedAt).toLocaleString('zh-CN')}</small>}
        {source.evidenceLatestAt && <small>本次最新有效正文：{new Date(source.evidenceLatestAt).toLocaleString('zh-CN')}</small>}
        {source.latestTurnNotice && <small>最新回合：{source.latestTurnNotice}</small>}
        <p>{source.reason}</p>
      </article>)}
    </details>}
  </div>;
}

const checkDate = (time: string) => new Date(time).toLocaleString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export function savedCheckText(status: SavedProjectCheck): string {
  const lastSource = status.latestEvidenceCheckAt ? `最近核对过对话 · ${checkDate(status.latestEvidenceCheckAt)}` : null;
  if (!status.attemptedAt) return lastSource || '还没有项目核对记录';
  const date = checkDate(status.attemptedAt);
  switch (status.outcome) {
    case 'failed': return `${date} · ${checkFailureMessage(status.failureCode)}`;
    case 'partial': return `${date} · 部分近期内容未能核对${status.failureCode ? '。' + checkFailureMessage(status.failureCode) : ''}`;
    case 'unknown': return lastSource || '还没有项目核对记录';
    case 'checking': return '正在核对最近的本机对话…';
    default:
      if (lastSource && status.latestEvidenceCheckAt && Date.parse(status.latestEvidenceCheckAt) > Date.parse(status.attemptedAt)) return lastSource;
      return `${date} 核对了 ${status.readCount} 条对话 · ${status.updatedThreadKeys.length ? `${status.updatedThreadKeys.length} 条有更新` : '已读内容无变化'}`;
  }
}

export function RefreshActivity({ active, job }: { active: boolean; job: SyncJob | null }) {
  if (!active) return null;
  const label = job?.state === 'queued' ? '等待整理…'
    : job?.state === 'running' ? `正在整理近况 · ${processedCount(job)}/${job.total}`
      : '正在查看最近对话…';
  return <div className="refresh-activity" role="status">
    <span>{label}</span><div className="refresh-activity-track" role="progressbar" aria-label={label}><i /></div>
  </div>;
}

/** A project-scoped source read, separate from fetching the board cache. */
export function ProjectRefreshStatus({ projectKey, online, onBoardChange, onFocusThread, onUpdatedThreads, onOpenPermissions, revision, readOnly = false, showControls = true, showOverview = false, unavailableReason = '' }: {
  projectKey: string; online: boolean; revision?: number; onBoardChange(): Promise<void>; onFocusThread?(key: string): void; onUpdatedThreads?(keys: string[]): void;
  onOpenPermissions?(): void; readOnly?: boolean; showControls?: boolean; showOverview?: boolean; unavailableReason?: string;
}) {
  const canRefresh = online && !readOnly;
  const updateListener = useRef(onUpdatedThreads);
  updateListener.current = onUpdatedThreads;
  const submission = useRef<symbol | null>(null);
  const [starting, setStarting] = useState(false);
  const [result, setResult] = useState<ProjectRefreshResult | null>(null);
  const [job, setJob] = useState<SyncJob | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<SavedProjectCheck | null>(null);
  const [lookupFailed, setLookupFailed] = useState(false);
  const [receiptVersion, setReceiptVersion] = useState(0);
  const pendingId = job && (job.state === 'running' || job.state === 'queued') ? job.id : null;
  const busy = canRefresh && (starting || pendingId !== null || saved?.outcome === 'checking');
  const visible = showControls || showOverview;
  useEffect(() => () => { submission.current = null; }, [projectKey]);
  useEffect(() => {
    if (!online || !visible) return;
    let ended = false;
    let timer: ReturnType<typeof setTimeout>;
    const readSaved = async () => {
      try {
        const status = await api.projectRefreshStatus(projectKey);
        if (ended) return;
        setSaved(status); setLookupFailed(false);
        if (status.outcome === 'checking') timer = setTimeout(readSaved, 2000);
      } catch { if (!ended) setLookupFailed(true); }
    };
    void readSaved();
    return () => { ended = true; clearTimeout(timer); };
  }, [projectKey, online, visible, revision, receiptVersion]);

  async function check() {
    if (!canRefresh || unavailableReason || submission.current || pendingId) return;
    const ticket = Symbol();
    submission.current = ticket;
    setStarting(true); setError(''); setResult(null); setJob(null);
    updateListener.current?.([]);
    try {
      const next = await api.refreshProject(projectKey, { automatic: false });
      if (submission.current !== ticket) return;
      setResult(next); setJob(next.job); updateListener.current?.(next.job?.updatedThreadKeys || []);
      setReceiptVersion(version => version + 1);
      await onBoardChange();
    } catch {
      if (submission.current === ticket) setError('暂时无法确认检查结果，原有近况保留。可在同步记录查看。');
    } finally {
      if (submission.current === ticket) { submission.current = null; setStarting(false); }
    }
  }

  useEffect(() => {
    if (!canRefresh || !pendingId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = (await api.syncJobs()).jobs.find(j => j.id === pendingId);
        if (disposed) return;
        if (!next) {
          const receipt = await api.projectRefreshStatus(projectKey);
          if (disposed) return;
          setJob(null); setSaved(receipt);
          if (receipt.jobId === pendingId && receipt.outcome !== 'checking') {
            setResult(null); setError(''); updateListener.current?.(receipt.updatedThreadKeys); await onBoardChange();
          } else setError('暂时无法确认这次检查的结果。');
          return;
        }
        setJob(next); setError('');
        updateListener.current?.(next.updatedThreadKeys || []);
        if (next.state === 'running' || next.state === 'queued') timer = setTimeout(poll, 1500);
        else { setReceiptVersion(version => version + 1); await onBoardChange(); }
      } catch {
        if (!disposed) { setError('暂时无法读取检查进度，正在重连。'); timer = setTimeout(poll, 3000); }
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [projectKey, canRefresh, pendingId, onBoardChange]);
  const needsRetry = Boolean(error || saved?.outcome === 'partial' || saved?.outcome === 'failed' || (result && (!job || job.state === 'paused' || job.needsResubmit || job.failures?.length)));
  if (!visible && !needsRetry && !pendingId && !starting) return null;
  const currentSources = result && (!saved?.attemptedAt || result.checkedAt >= saved.attemptedAt) ? result.sources : saved?.sources;
  const label = readOnly ? '页面已归档，显示上次保存的内容。' : !online ? '离线中，显示上次保存的内容。' : unavailableReason || error;
  return <section className="project-refresh" aria-label="项目源更新" aria-busy={busy}>
    {(visible || needsRetry) && <div className="project-refresh-heading"><span>{saved ? savedCheckText(saved) : lookupFailed ? '暂时读不到核对记录' : '最近的本机对话'}</span>
      {onOpenPermissions && unavailableReason && !readOnly && online ? <button onClick={onOpenPermissions}>来源授权</button> :
        <button disabled={!canRefresh || busy || Boolean(unavailableReason)} onClick={() => void check()}>{busy ? '更新中…' : needsRetry && !unavailableReason ? '重试更新' : '检查更新'}</button>}</div>}
    <RefreshActivity active={busy} job={job} />
    {label ? <p role="status">{label}</p> : result && (!saved || saved.outcome === 'checking') ? <p role="status">{refreshStatusText(result, job)}</p> : null}
    {showControls && currentSources && <RefreshSources sources={currentSources} updatedThreadKeys={saved?.updatedThreadKeys ?? job?.updatedThreadKeys} onFocusThread={onFocusThread} />}
    {showControls && <details className="refresh-diagnostics"><summary>更新说明</summary>
      <p>检查本机最近 3 条对话，不代表全部历史。远程与 ChatGPT 对话请在设置中同步。整理变化内容可能使用 Codex 登录额度。</p>
      {saved?.lastVerifiedAt && <small>上次成功核对　{checkDate(saved.lastVerifiedAt)}</small>}
      {saved?.latestEvidenceCheckAt && saved.latestEvidenceCheckAt !== saved.lastVerifiedAt && <small>最近核对过的对话　{checkDate(saved.latestEvidenceCheckAt)}</small>}
      {saved?.limitedExcerpts && <p>部分回合正文只保留了摘录，或最近回合尚无可读内容。可点对话查看来源。</p>}
      {result?.gaps.map((gap, i) => <p key={i}>{gap}</p>)}
      {job?.warnings?.length ? <p>文字摘要已保留；部分产物链接未能确认，因此没有显示。</p> : null}
      {job?.error && <p>{job.error}</p>}
      {job?.failures?.map((item, index) => <small key={index}>{result?.sources?.find(source => source.threadKey === item.threadKey)?.title || '对话'} · {item.code}</small>)}
    </details>}
  </section>;
}
