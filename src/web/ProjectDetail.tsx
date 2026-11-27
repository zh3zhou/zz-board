import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { BoardThread, SnapshotProject, ThreadRecap } from '../shared/schema.js';
import { type ProjectBubbleContext } from './projectCanvas.js';
import { actionLabel, confidenceLabel, runtimeLabel, workLabel } from './labels.js';
import { orderedProjectThreads, recapNeedsUpdate, recordedWorkState, threadSourceTime } from '../shared/projectProgress.js';
import { actionEvidenceThread, actionRecordTime, awaitsResponse, historicalAction, projectActions, type ProjectAction } from './projectActions.js';
import { projectReading, readingDate, readingQualifier, shortRecordDate, sourceEventTime, versionLabels } from './projectContextReading.js';
import { SourceExcerpt } from './SourceExcerpt.js';
import { duplicateThreadLabels, SourceThreadTitles, ThreadSourceLink, ThreadTitle } from './ThreadSourceLink.js';
import './summarySync.css';
import './panelEditorial.css';

const nextReasons = { explicit: '', not_stated: '暂无明确下一步', intentionally_closed: '主动收口', insufficient_evidence: '证据不足，未明确下一步' };

const detailedDate = new Intl.DateTimeFormat('zh-CN', {
  year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23', timeZoneName:'short'
});
function SourceTimestamp({value}: {value?: string}) {
  if (!value || !Number.isFinite(Date.parse(value))) return <>未记录</>;
  return <time dateTime={value}>{/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : detailedDate.format(new Date(value))}</time>;
}

function Freshness({ thread }: { thread: BoardThread }) {
  return recapNeedsUpdate(thread) && <p className="source-coverage" role="status">对话有新记录，摘要尚待更新。</p>;
}

/** Never make an executable or network-share path into a clickable artifact. */
export function artifactTarget(uri: string): 'web' | 'local' | 'blocked' {
  if (/[\u0000-\u001f\u007f]/.test(uri)) return 'blocked';
  if (/^https?:\/\//i.test(uri)) {
    try { const url = new URL(uri); return url.username || url.password ? 'blocked' : 'web'; } catch { return 'blocked'; }
  }
  return /^[a-z]:[\\/]/i.test(uri) || /^\/(?![\/\\])/.test(uri) ? 'local' : 'blocked';
}

function Artifact({ artifact }: { artifact: ThreadRecap['summary']['artifacts'][number] }) {
  const [status, setStatus] = useState('');
  const kind = artifactTarget(artifact.uri);
  async function copyPath() {
    try { await navigator.clipboard.writeText(artifact.uri); setStatus('路径已复制'); }
    catch { setStatus('复制失败，请手动复制路径'); }
  }
  if (kind === 'web') return <a href={artifact.uri} target="_blank" rel="noopener noreferrer">{artifact.label}</a>;
  return <span className="recap-artifact">{artifact.label}{kind === 'local' ? <><button title={artifact.uri} onClick={() => void copyPath()}>复制路径</button><code>{artifact.uri}</code></> : <small>不支持打开此产物地址</small>}<small role="status">{status}</small></span>;
}

type EvidenceProps = { thread: BoardThread; project?: SnapshotProject; canReadSource?: boolean };
type EvidenceSource = ThreadRecap['sources'][number];
function CitationLocator({ value }: { value: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  async function copy() {
    try { await navigator.clipboard.writeText(value); setState('copied'); }
    catch { setState('manual'); }
  }
  return <><button type="button" className="recap-thread-link citation-locator" onClick={() => void copy()}>{state === 'copied' ? '已复制引用' : '复制引用'}</button>
    {state === 'manual' && <code role="status">{value}</code>}</>;
}

function EvidenceRecords({ thread, project, canReadSource = false, sources }: EvidenceProps & { sources: EvidenceSource[] }) {
  return <>{sources.map(source => <div className="citation-record" key={source.id}>
    <span>{source.role === 'user' ? '用户消息' : source.role === 'file' ? '文件记录' : '助手回复'} · <SourceTimestamp value={source.occurredAt} /></span>
    {source.path && <code>{source.path}</code>}
    <CitationLocator value={[project?.projectKey, thread.hostId, thread.threadKey, thread.threadId, source.turnId, source.id, source.occurredAt, source.path].filter(Boolean).join('\n')} />
    <SourceExcerpt project={project} thread={thread} source={source} canRead={canReadSource} />
  </div>)}</>;
}

function Sources({ refs, label = '原始记录', ...evidence }: EvidenceProps & { refs: string[]; label?: string }) {
  const sources = evidence.thread.recap?.sources.filter(source => refs.includes(source.id));
  return sources?.length ? <details className="recap-sources"><summary>{label}</summary><EvidenceRecords {...evidence} sources={sources} /></details> : null;
}

/** The date opens only the cited records. The title beside it navigates to the saved conversation. */
function ReadingOrigin({ date, children, evidence }: { date: string; children: ReactNode; evidence?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <>
    <div className="reading-origin">
      {evidence ? <button type="button" className="citation-toggle" aria-expanded={open} aria-controls={id}
        title={open ? '收起引用记录' : '展开引用记录'} aria-label={[open ? '收起引用记录' : '展开引用记录', date].filter(Boolean).join('，')}
        onClick={() => setOpen(!open)}><span aria-hidden="true">{open ? '▾' : '▸'}</span> {date || '引用记录'}</button> : date}
      {(date || evidence) && ' · '}{children}
    </div>
    {evidence && <div id={id} className="citation-content" hidden={!open}>{open && evidence}</div>}
  </>;
}

function Versions(props: EvidenceProps) {
  const recap = props.thread.recap!;
  const versions = [...new Set(recap.summary.versions.map(value => value.version))];
  return versions.length > 0 && <details className="recap-versions"><summary>这条对话的版本记录 · {versions.length}</summary>{versions.map(number => <div key={number}><strong>{number}</strong>{recap.summary.versions.filter(value => value.version === number).map((version, index) => <div key={index}><span>{versionLabels[version.stage]}</span><Sources {...props} refs={version.sourceRefs} /></div>)}</div>)}</details>;
}

function Achievement({ thread, achievement, ...rest }: EvidenceProps & { achievement: ThreadRecap['summary']['achievements'][number] }) {
  const recap = thread.recap!;
  return <article className="recap-achievement"><strong>{achievement.title}</strong>{achievement.detail && <p>{achievement.detail}</p>}<small>{shortRecordDate(achievement.occurredAt)}</small><div className="recap-artifacts">{recap.summary.artifacts.filter(artifact => achievement.artifactIds.includes(artifact.id)).map(artifact => <Artifact key={artifact.id} artifact={artifact} />)}</div><Sources thread={thread} {...rest} refs={achievement.sourceRefs} label="成果的引用记录" /></article>;
}

function ActionRow({ action, project, canReadSource, labels, onLocate }: { action: ProjectAction; project: SnapshotProject; canReadSource: boolean; labels: Map<string, string>; onLocate?(key: string): void }) {
  const { todo, sources } = action;
  const thread = actionEvidenceThread(action);
  const refs = todo ? todo.actionEvidence?.sourceRefs : thread?.recap?.summary.nextStep?.sourceRefs;
  const cited = refs ? thread?.recap?.sources.filter(source => refs.includes(source.id)) : undefined;
  const saved = todo?.evidence || (!thread?.recap && thread?.evidence);
  const date = shortRecordDate(actionRecordTime(action));
  const origin = todo ? todo.actionEvidence?.origin : thread?.recap?.summary.nextStep?.origin;
  const qualifier = [historicalAction(action) && '上次记录，待核对', sources.some(recapNeedsUpdate) && '摘要待更新',
    !awaitsResponse(action) && origin && {user_request: '用户提出', accepted_plan: '已确认计划', explicit_handoff: '对话交接'}[origin]].filter(Boolean).join(' · ');
  return <article><p className="reading-fact">{qualifier && <span className="reading-qualifier">{qualifier} · </span>}{action.text}</p>
    <ReadingOrigin date={date ? '记录于 ' + date : ''} evidence={(saved || cited?.length || todo?.actionEvidence) ? <>
      {saved && <p>{!todo?.actionEvidence && '旧快照依据 · '}{saved}</p>}
      {thread && cited?.length ? <EvidenceRecords thread={thread} project={project} canReadSource={canReadSource} sources={cited} /> : null}
      {todo?.actionEvidence && (!cited || cited.length < todo.actionEvidence.sourceRefs.length) &&
        <CitationLocator value={[...todo.sourceThreadKeys, ...todo.actionEvidence.sourceRefs].join('\n')} />}
    </> : undefined}>{sources.length ? <>来自「<SourceThreadTitles threads={sources} labels={labels} onLocate={onLocate} />」</> : '来自项目待办'}</ReadingOrigin>
  </article>;
}

export function ProjectDetail({ context, focusedThreadKey, view = 'all', onFocusThread, updatedThreadKeys = [], canReadSource = false }: {
  context: ProjectBubbleContext; focusedThreadKey: string | null; view?: 'all' | 'overview' | 'threads';
  onFocusThread?(key: string): void; updatedThreadKeys?: readonly string[]; canReadSource?: boolean;
}) {
  const threads = orderedProjectThreads(context.threads);
  const labels = duplicateThreadLabels(threads);
  const lines = view === 'threads' ? [] : projectReading(context);
  const actions = view === 'threads' ? [] : projectActions(context);
  const current = actions.filter(awaitsResponse);
  const other = actions.filter(action => !awaitsResponse(action));
  const row = (action: ProjectAction) => <ActionRow key={action.todo ? `todo:${action.todo.todoKey}` : `thread:${action.sources[0]!.threadKey}`}
    action={action} project={context.project} canReadSource={canReadSource} labels={labels} onLocate={onFocusThread} />;
  return <div className="project-recap">
    {view !== 'threads' && <>
      <section className="project-stop-point"><h3>最近进展</h3>
        {lines.length ? lines.map(line => {
          const thread = line.thread;
          const qualifier = readingQualifier(line);
          const sources = thread?.recap?.sources.filter(source => line.sourceRefs.includes(source.id));
          const saved = thread ? thread.evidence : context.brief?.evidenceReason;
          return <article key={thread?.threadKey ?? 'brief'}>
            <p className="reading-fact">{qualifier && <span className="reading-qualifier">{qualifier} · </span>}{line.text}</p>
            <ReadingOrigin date={readingDate(line)} evidence={thread && sources?.length
              ? <EvidenceRecords project={context.project} thread={thread} sources={sources} canReadSource={canReadSource} />
              : saved ? <p>旧快照依据 · {saved}</p> : undefined}>
              {thread ? <>来自「<ThreadTitle thread={thread} label={labels.get(thread.threadKey)} onLocate={onFocusThread} />」</> : '来自旧项目简报'}
            </ReadingOrigin>
          </article>;
        }) : <p className="empty-summary">还没有可追溯的进展记录。</p>}
      </section>
      {(current.length > 0 || other.length > 0) && <section className="project-next-actions">
        {current.length > 0 && <><h3>明确待办</h3>{row(current[0]!)}
          {current.length > 1 && <details className="other-project-actions"><summary>其余 {current.length - 1} 项明确待办</summary>{current.slice(1).map(row)}</details>}</>}
        {other.length > 0 && <details className="other-project-actions"><summary>其他已记录行动 · {other.length}</summary>{other.map(row)}</details>}
      </section>}
    </>}
    {view !== 'overview' && <section className="thread-summaries"><h3>对话 · {threads.length}</h3>{threads.length ? threads.map(thread => <ThreadSummary key={thread.threadKey} thread={thread} title={labels.get(thread.threadKey)} project={context.project} canReadSource={canReadSource} focused={thread.threadKey === focusedThreadKey} updated={updatedThreadKeys.includes(thread.threadKey)} />) : <p className="empty-summary">还没有关联的对话。</p>}</section>}
  </div>;
}

export function ThreadSummary({ thread, project, title = thread.title, focused = false, updated = false, canReadSource = false }: EvidenceProps & { title?: string; focused?: boolean; updated?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const recap = thread.recap;
  const evidence = {thread, project, canReadSource};
  const date = shortRecordDate(threadSourceTime(thread));
  useEffect(() => {
    if (focused) { ref.current?.focus({ preventScroll: true }); ref.current?.scrollIntoView({ block: 'nearest' }); }
  }, [focused, thread.threadKey]);
  return <article ref={ref} data-thread-key={thread.threadKey} tabIndex={-1} className={`thread-summary ${focused ? 'is-focused' : ''}${updated ? ' has-update' : ''}`}>
    <div className="conversation-heading"><h4>{title}</h4>{updated && <span className="conversation-update">已更新</span>}<ThreadSourceLink thread={thread} project={project} /></div>
    {date && <small className="recap-time">对话更新于 {date}</small>}
    {(recap || thread.displayTitle && thread.displayTitle !== thread.title) && <p><strong>{recap?.summary.headline || thread.displayTitle}</strong></p>}
    {thread.missingSince && <p className="source-coverage">这次没读到这条对话，下面是上次保存的内容。</p>}
    <Freshness thread={thread} />
    <p><strong>上次做到哪儿　</strong>{recap?.summary.stopPoint || thread.stopPoint || '还没有足够记录说明上次做到哪儿。'}</p>
    {recap ? <><Sources {...evidence} refs={recap.summary.stopPointRefs} /><Versions {...evidence} />{recap.summary.achievements.map(achievement => <Achievement key={achievement.id} {...evidence} achievement={achievement} />)}{recap.summary.nextStep ? <><p><strong>{recap.summary.nextStep.kind === 'wait' ? '等待外部：' : thread.missingSince || recapNeedsUpdate(thread) ? '上次记录的待办：' : '已记录的行动：'}</strong>{recap.summary.nextStep.text}</p><Sources {...evidence} refs={recap.summary.nextStep.sourceRefs} /></> : <p className="source-coverage">{nextReasons[recap.summary.nextStepReason]}</p>}
    </> : thread.actionStrength === 'blocking' && !['none', 'wait', 'uncertain'].includes(thread.humanAction) && <p><strong>已记录动作：</strong>{actionLabel(thread.humanAction)}</p>}
    <details className="thread-origin-details"><summary>这条对话的来源</summary><p>{thread.evidence || '尚未记录依据。'}</p>{recap && <>
      <EvidenceRecords {...evidence} sources={recap.sources} />
      <small>停点引用于 <SourceTimestamp value={sourceEventTime(recap, recap.summary.stopPointRefs)} /><br />检查于 <SourceTimestamp value={recap.evidenceCheckedAt} /><br />整理于 <SourceTimestamp value={recap.summarizedAt} /></small>
    </>}<small>记录时判断：{workLabel(recordedWorkState(thread))} · {confidenceLabel(recap?.summary.confidence || thread.confidence)}<br />
      观测于 <SourceTimestamp value={thread.lastObservedAt} /> · {runtimeLabel(thread.runtimeState)}<br />
      来源 {thread.sourceKind}{thread.hostId ? ` · 主机 ${thread.hostId}` : ''}</small>
      <code>{thread.threadId}</code>
    </details>
  </article>;
}
