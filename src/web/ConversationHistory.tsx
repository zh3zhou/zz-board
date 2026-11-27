import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ConversationColumn, ConversationTurn, ConversationHistory as ProjectConversationHistory } from '../shared/conversationHistory.js';
import type { SyncJob } from '../shared/summarySync.js';
import { api } from './api.js';
import { summaryProblem } from './summaryFeedback.js';
import { conversationGroups, floatingBounds, mergeConversationTurns, type FloatingBounds } from './conversationView.js';
import { mergeEarlierConversationPage, readEarlierConversationPage } from './conversationPaging.js';
import { ThreadTitle } from './ThreadSourceLink.js';
import './conversationHistory.css';

const date = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '时间未知';
const busyJob = (job: SyncJob | null) => Boolean(job && ['queued', 'running'].includes(job.state));

export function ConversationHistory({ projectKey, projectName, online, revision, onLocateThread }: { projectKey: string; projectName: string; online: boolean; revision: number; onLocateThread?(key: string): void }) {
  const [open, setOpen] = useState(false);
  const entry = useRef<HTMLButtonElement>(null);
  const lastPage = useRef<ProjectConversationHistory | null>(null);
  return <section className="conversation-launcher" aria-label="最近对话历程">
    <button className="conversation-open" ref={entry} aria-expanded={open} onClick={() => setOpen(true)}><span aria-hidden="true">▥</span>展开对话历程<span aria-hidden="true">↗</span></button>
    {open && <ConversationWindow key={projectKey} projectKey={projectKey} projectName={projectName} online={online} revision={revision} anchor={entry} initial={lastPage.current} onLocateThread={onLocateThread} onClose={page => { lastPage.current = page; setOpen(false); entry.current?.focus(); }} />}
  </section>;
}

function ConversationWindow({ projectKey, projectName, online, revision, anchor, initial, onClose, onLocateThread }: {
  projectKey: string; projectName: string; online: boolean; revision: number; anchor: React.RefObject<HTMLButtonElement | null>; initial: ProjectConversationHistory | null; onClose(page: ProjectConversationHistory | null): void;
  onLocateThread?(key: string): void;
}) {
  const [page, setPage] = useState(initial), [error, setError] = useState(''), [job, setJob] = useState<SyncJob | null>(null);
  const [pending, setPending] = useState(false), [closing, setClosing] = useState(false);
  const [bounds, setBounds] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(`zz-conversation-window:${projectKey}`) || 'null');
      if (saved && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(saved[key])) && saved.width > 0 && saved.height > 0) return floatingBounds(window.innerWidth, window.innerHeight, saved);
    } catch { /* default position when storage is unavailable */ }
    return floatingBounds(window.innerWidth, window.innerHeight);
  });
  useEffect(() => { try { sessionStorage.setItem(`zz-conversation-window:${projectKey}`, JSON.stringify(bounds)); } catch { /* in-memory fallback */ } }, [bounds, projectKey]);
  const panel = useRef<HTMLElement>(null), alive = useRef(true), sequence = useRef(0);
  const animation = useRef<Animation | null>(null), closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drag = useRef<{ x: number; y: number; bounds: FloatingBounds } | null>(null);
  const loadingEarlier = useRef(new Set<string>());
  const pageRef = useRef(page); pageRef.current = page;
  const onlineRef = useRef(online); onlineRef.current = online;
  const reload = useCallback(async () => {
    const id = ++sequence.current;
    const fresh = await api.conversations(projectKey);
    const reordered = new Set<string>();
    for (let i = 0; i < fresh.threads.length; i++) {
      const column = fresh.threads[i]!, old = pageRef.current?.threads.find(t => t.threadKey === column.threadKey);
      if (old && old.orderingRevision !== column.orderingRevision) {
        reordered.add(column.threadKey);
        if (old.turns.length > 20) fresh.threads[i] = await api.conversationTurns(projectKey, column.threadKey, { limit: Math.min(2000, old.turns.length + 20) });
      }
    }
    if (!alive.current || sequence.current !== id) return;
    setPage(old => ({ ...fresh, threads: fresh.threads.map(column => ({ ...column, turns: reordered.has(column.threadKey) ? column.turns : mergeConversationTurns(old?.threads.find(t => t.threadKey === column.threadKey)?.turns ?? [], column.turns) })) }));
  }, [projectKey]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; animation.current?.cancel(); if (closeTimer.current) clearTimeout(closeTimer.current); }; }, []);
  useEffect(() => {
    if (online) void reload().catch(() => { if (alive.current) setError('暂时无法更新显示，已有记录保留。'); });
  }, [online, revision, reload]);
  const runRefresh = useCallback(async () => {
    if (!online) return;
    setPending(true); setError('');
    try { const result = await api.refreshConversations(projectKey); if (!alive.current) return; setJob(result.job); if (result.gaps.length) setError(result.gaps.join(' ')); await reload(); }
    catch { if (alive.current) setError('这次没有整理成功，原有记录保留。稍后可以重试。'); }
    finally { if (alive.current) setPending(false); }
  }, [online, projectKey, reload]);
  useEffect(() => {
    if (!online || !busyJob(job)) return;
    let cancelled = false, fetching = false;
    const timer = setInterval(() => {
      if (fetching) return; fetching = true;
      void api.syncJobs().then(async ({ jobs }) => {
        if (cancelled) return; const fresh = jobs.find(j => j.id === job?.id); if (!fresh) return;
        setJob(fresh); await reload();
        if (!busyJob(fresh) && loadingEarlier.current.size) {
          for (const key of [...loadingEarlier.current]) await loadStoredEarlier(key);
          loadingEarlier.current.clear();
        }
      }).catch(() => { if (!cancelled) setError('暂时连接不上本地服务，已有记录保留。'); }).finally(() => { fetching = false; });
    }, 1500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [online, job?.id, job?.state, reload]);
  async function loadStoredEarlier(threadKey: string): Promise<boolean> {
    const result = await readEarlierConversationPage(
      () => pageRef.current?.threads.find(c => c.threadKey === threadKey),
      beforeTurnId => api.conversationTurns(projectKey, threadKey, { beforeTurnId }),
      () => alive.current && onlineRef.current,
    );
    if (result.status === 'stale') {
      if (alive.current && onlineRef.current) setError('对话顺序刚刚更新，请再试一次；当前记录已保留。');
      return true;
    }
    if (result.status === 'empty') return false;
    if (result.status !== 'loaded') return true;
    const earlierPage = result.page;
    setPage(old => old ? { ...old, threads: old.threads.map(c => c.threadKey === threadKey ? mergeEarlierConversationPage(c, earlierPage) : c) } : old);
    return true;
  }
  async function earlier(column: ConversationColumn) {
    setPending(true); setError('');
    try {
      const before = pageRef.current?.threads.find(c => c.threadKey === column.threadKey);
      if (await loadStoredEarlier(column.threadKey)) return;
      if (!alive.current || !onlineRef.current) return;
      if (column.hasStoredEarlier || before?.hasStoredEarlier) { await reload(); return; }
      const current = pageRef.current?.threads.find(c => c.threadKey === column.threadKey);
      if (!before || !current?.hasEarlier || current.orderingRevision !== before.orderingRevision || current.nextCursor !== before.nextCursor) return;
      loadingEarlier.current.add(column.threadKey);
      const result = await api.earlierConversations(projectKey, current.threadKey, current.nextCursor);
      if (!alive.current) return;
      setJob(result.job); if (result.gaps.length) setError(result.gaps.join(' '));
      if (!busyJob(result.job)) { await reload(); await loadStoredEarlier(column.threadKey); loadingEarlier.current.delete(column.threadKey); }
    } catch { if (alive.current) setError('更早的对话暂未读到，已保留当前内容。'); }
    finally { if (alive.current) setPending(false); }
  }
  function anchorTransform() {
    const origin = anchor.current?.getBoundingClientRect(), target = panel.current?.getBoundingClientRect();
    if (!origin || !target) return 'translateX(32px) scale(.96)';
    return `translate(${origin.left - target.left}px, ${origin.top - target.top}px) scale(${Math.max(.2, origin.width / target.width)}, ${Math.max(.12, origin.height / target.height)})`;
  }
  useLayoutEffect(() => {
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches && panel.current?.animate) animation.current = panel.current.animate([{ transform: anchorTransform(), opacity: .25 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
    panel.current?.focus();
  }, []);
  const close = useRef(() => {});
  close.current = () => {
    if (closing) return; setClosing(true); animation.current?.cancel();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !panel.current?.animate) { onClose(pageRef.current); return; }
    animation.current = panel.current.animate([{ transform: 'none', opacity: 1 }, { transform: anchorTransform(), opacity: .15 }], { duration: 190, easing: 'ease-in', fill: 'forwards' });
    closeTimer.current = setTimeout(() => onClose(pageRef.current), 195);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopImmediatePropagation(); close.current(); return; }
      // A focused reading window must not route Delete/undo/tool shortcuts to the canvas.
      if (panel.current?.contains(event.target as Node)) event.stopImmediatePropagation();
    };
    const resize = () => setBounds(old => floatingBounds(window.innerWidth, window.innerHeight, old));
    window.addEventListener('keydown', key, true); window.addEventListener('resize', resize);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('resize', resize); };
  }, []);
  function startDrag(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || closing || (event.target as Element).closest('button')) return;
    event.preventDefault(); animation.current?.cancel(); event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, bounds }; panel.current?.focus();
  }
  function move(event: PointerEvent<HTMLElement>) {
    if (!drag.current) return; const initial = drag.current;
    setBounds(floatingBounds(window.innerWidth, window.innerHeight, { ...initial.bounds, x: initial.bounds.x + event.clientX - initial.x, y: initial.bounds.y + event.clientY - initial.y }));
  }
  const working = pending || busyJob(job);
  return createPortal(<section ref={panel} tabIndex={-1} role="dialog" aria-modal="false" aria-label={`${projectName} · 对话历程`} className={`conversation-window${closing ? ' is-closing' : ''}`} style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }} onPointerDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()} onContextMenu={e => e.stopPropagation()} onPaste={e => { e.preventDefault(); e.stopPropagation(); }}>
    <header className="conversation-window-header" onPointerDown={startDrag} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <div><small>对话历程 · 拖动标题栏移动</small><h2>{projectName}</h2></div>
      <button aria-label="收回项目侧栏" title="收回侧栏（Esc）" onClick={() => close.current()}>×</button>
    </header>
    <div className="conversation-window-status"><span role="status">{!online ? '离线，保留已读内容' : working ? '正在整理最近的交流…' : job?.state === 'paused' ? summaryProblem(job) : '按对话分别阅读 · 从旧到新'}</span><button disabled={!online || working} onClick={() => void runRefresh()}>检查更新</button>
      {busyJob(job) && <button onClick={() => void api.syncJobAction(job!.id, 'pause').then(setJob).catch(() => setError('暂未暂停成功。'))}>暂停</button>}
    </div>
    {error && <p className="conversation-warning" role="status">{error}</p>}
    {page && <small className="conversation-order">{page.order === 'sidebar' ? '按已保存的侧边栏顺序' : '暂无可靠侧边栏顺序，按最近使用排列'}</small>}
    <div className="conversation-columns">{page?.threads.map(column => <ConversationLane key={column.threadKey} column={column} projectKey={projectKey} online={online} busy={working} onEarlier={() => void earlier(column)} onLocateThread={onLocateThread} />)}
      {!page?.threads.length && <p className="conversation-empty">{working ? '正在寻找最近使用的对话…' : '尚无已保存的逐回合记录。可点“检查更新”整理最近的对话。'}</p>}
    </div>
    {!!page?.gaps.length && <details className="conversation-gaps"><summary>未覆盖的内容</summary>{page.gaps.map((gap, i) => <p key={i}>{gap}</p>)}</details>}
  </section>, document.body);
}

function TurnCard({ turn }: { turn: ConversationTurn }) {
  return <article className={`conversation-turn${turn.unread ? ' has-update' : ''}`} data-turn-id={turn.turnId}><header><time>{date(turn.occurredAt)}</time>{turn.unread && <small>新进展</small>}</header><h4>{turn.title}</h4><p>{turn.summary}</p>{turn.reference && <small>接着此前的「{turn.reference.label}」</small>}<details><summary>查看依据</summary><code>{turn.sourceRefs.join('\n')}</code></details></article>;
}
export function ConversationLane({ column, projectKey, online, busy, onEarlier, onLocateThread }: { column: ConversationColumn; projectKey: string; online: boolean; busy: boolean; onEarlier(): void; onLocateThread?(key: string): void }) {
  const scroller = useRef<HTMLDivElement>(null), initial = useRef(false), snapshot = useRef({ height: 0, top: 0, first: '' });
  const readingAnchor = useRef<{ id: string; offset: number } | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => { try { return JSON.parse(sessionStorage.getItem(`zz-conversation-folds:${projectKey}:${column.threadKey}`) || '{}'); } catch { return {}; } });
  const [read, setRead] = useState<Record<string, number>>({});
  const marked = useRef(new Set<string>());
  const groups = conversationGroups(column.turns);
  function rememberPosition() {
    const element = scroller.current; if (!element) return;
    snapshot.current = { height: element.scrollHeight, top: element.scrollTop, first: column.turns[0]?.turnId || '' };
    const top = element.getBoundingClientRect().top;
    const visible = [...element.querySelectorAll<HTMLElement>('[data-scroll-turn]')].find(item => item.getClientRects().length && item.getBoundingClientRect().bottom > top);
    readingAnchor.current = visible ? { id: visible.dataset.scrollTurn!, offset: visible.getBoundingClientRect().top - top } : null;
  }
  useLayoutEffect(() => {
    const element = scroller.current; if (!element || !column.turns.length) return;
    const first = column.turns[0]!.turnId;
    if (!initial.current) { element.scrollTop = element.scrollHeight; initial.current = true; }
    else {
      const anchor = readingAnchor.current;
      const target = anchor && [...element.querySelectorAll<HTMLElement>('[data-scroll-turn]')].find(item => item.dataset.scrollTurn === anchor.id && item.getClientRects().length);
      if (target && anchor) element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset;
      else if (snapshot.current.first !== first) element.scrollTop = snapshot.current.top + element.scrollHeight - snapshot.current.height;
    }
    rememberPosition();
  }, [column.turns]);
  useEffect(() => {
    if (!online || !scroller.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(e => e.isIntersecting).flatMap(e => {
        const target = e.target as HTMLElement;
        const ids = (target.dataset.readTurns || '').split('\u001f');
        return column.turns.filter(t => ids.includes(t.turnId) && t.unread && !marked.current.has(`${t.turnId}:${t.revision}`));
      });
      if (!visible.length) return;
      for (const turn of visible) marked.current.add(`${turn.turnId}:${turn.revision}`);
      void api.readConversations(projectKey, visible.map(t => ({ threadKey: column.threadKey, turnId: t.turnId, revision: t.revision }))).then(() => setRead(old => ({ ...old, ...Object.fromEntries(visible.map(t => [t.turnId, t.revision])) }))).catch(() => { for (const t of visible) marked.current.delete(`${t.turnId}:${t.revision}`); });
    }, { root: scroller.current, threshold: .6 });
    scroller.current.querySelectorAll('[data-read-turns]').forEach(e => observer.observe(e));
    return () => observer.disconnect();
  }, [column.turns, expanded, online, column.threadKey, projectKey]);
  function toggle(id: string, value: boolean) { setExpanded(old => { const next = { ...old, [id]: value }; try { sessionStorage.setItem(`zz-conversation-folds:${projectKey}:${column.threadKey}`, JSON.stringify(next)); } catch { /* in-memory fallback */ } return next; }); }
  const viewed = (t: ConversationTurn) => ({ ...t, unread: t.unread && (read[t.turnId] ?? 0) < t.revision });
  return <section className="conversation-lane" aria-label={column.title}><header className="conversation-lane-header"><h3><ThreadTitle thread={column} onLocate={onLocateThread} /></h3><small>对话更新：{date(column.sourceUpdatedAt)}</small><small className="conversation-coverage">{column.knownTurns !== undefined ? `已整理 ${Math.max(0,column.knownTurns-(column.pendingTurns ?? 0))} / ${column.knownTurns} 回合` : `显示 ${column.turns.length} 回合`}{Boolean(column.pendingTurns) && ` · ${column.pendingTurns} 回合待整理`}</small><details><summary>覆盖范围</summary><p>来源更新时间不代表所有内容已经整理完成。</p>{column.coverage.map((text, i) => <p key={i}>{text}</p>)}</details></header>
    <div className="conversation-lane-scroll" ref={scroller} onScroll={rememberPosition}>
      {(column.hasEarlier || column.hasStoredEarlier) && <button disabled={!online || busy} onClick={onEarlier}>{column.hasStoredEarlier ? '查看已保存的更早回合' : '从 Codex 读取更早的 20 回合'}</button>}
      {groups.map(group => group.length === 1 ? <div key={group[0].turnId} data-scroll-turn={group[0].turnId} data-read-turns={group[0].turnId}><TurnCard turn={viewed(group[0])} /></div> : <details key={group[0].turnId} className="conversation-group" open={expanded[group[0].turnId] ?? false} onToggle={e => toggle(group[0].turnId, e.currentTarget.open)}>
        <summary data-scroll-turn={`group:${group[0].turnId}`} data-read-turns={group.at(-1)!.turnId}><strong>{group[0].title}</strong><small>{date(group[0].occurredAt)} — {date(group.at(-1)!.occurredAt)} · {group.length} 回合</small><p>{group.at(-1)!.summary}</p>{group.some(t => viewed(t).unread) && <span className="conversation-update">新进展</span>}</summary>
        {group.map(turn => <div key={turn.turnId} data-scroll-turn={turn.turnId} data-read-turns={turn.turnId}><TurnCard turn={viewed(turn)} /></div>)}
      </details>)}
      {!column.turns.length && <p className="conversation-empty">{busy ? '正在整理这条对话…' : '尚无可读回合，不能据此推断没有进展。'}</p>}
    </div>
  </section>;
}
