import { Fragment, useState } from 'react';
import type { BoardThread, SnapshotProject } from '../shared/schema.js';

type ThreadIdentity = Pick<BoardThread, 'projectKey' | 'sourceKind' | 'hostId' | 'threadId'> & { threadKey?: string | null; title?: string };

/** The desktop thread route accepts an existing local ID. Snapshot keys and titles are not URLs. */
export function localCodexThreadUrl(thread: ThreadIdentity, project?: SnapshotProject): string | null {
  if (thread.sourceKind !== 'codex' || (project && thread.projectKey !== project.projectKey)) return null;
  if (project?.hostId !== undefined && project.hostId !== 'local') return null;
  const local = thread.hostId === 'local' || (thread.hostId === undefined && thread.threadKey === `codex:local:${thread.threadId}`);
  if (!local) return null;
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(thread.threadId)) return null;
  return `codex://threads/${thread.threadId}`;
}

type TitledThread = Pick<BoardThread, 'title' | 'threadKey'>;

/** Pair repeated titles with their position in the saved project conversation order. */
export function duplicateThreadLabels(threads: readonly TitledThread[]): Map<string, string> {
  const groups = new Map<string, string[]>();
  for (const thread of threads) {
    const keys = groups.get(thread.title);
    if (keys) keys.push(thread.threadKey);
    else groups.set(thread.title, [thread.threadKey]);
  }
  const labels = new Map<string, string>();
  for (const [title, keys] of groups) {
    if (keys.length > 1) keys.forEach((key, i) => labels.set(key, `${title}（同名对话 ${i + 1}）`));
  }
  return labels;
}

export function ThreadTitle({ thread, onLocate, label = thread.title }: { thread: TitledThread; onLocate?(key: string): void; label?: string }) {
  return onLocate ? <button type="button" className="recap-thread-link" onClick={() => onLocate(thread.threadKey)}>{label}</button> : <>{label}</>;
}

export function SourceThreadTitles({ threads, onLocate, labels = duplicateThreadLabels(threads) }: { threads: BoardThread[]; labels?: Map<string, string>; onLocate?(key: string): void }) {
  return <>{threads.map((thread, i) => <Fragment key={thread.threadKey}>{i > 0 && '、'}<ThreadTitle thread={thread} onLocate={onLocate}
    label={labels.get(thread.threadKey)} /></Fragment>)}</>;
}

export function ThreadSourceLink({ thread, project, copyOnly }: { thread: ThreadIdentity; project?: SnapshotProject; copyOnly?: boolean }) {
  const [copy, setCopy] = useState<'idle' | 'done' | 'manual'>('idle');
  const href = copyOnly ? null : localCodexThreadUrl(thread, project);
  if (href) return <a className="recap-thread-link thread-origin" href={href}>在 Codex 打开</a>;
  const locator = [project?.name, thread.projectKey, thread.title, thread.sourceKind, `对话主机 ${thread.hostId || '未记录'}`,
    `对话 ID ${thread.threadId}`, thread.threadKey && `看板来源 ${thread.threadKey}`].filter(Boolean).join('\n');
  async function copyLocator() {
    try { await navigator.clipboard.writeText(locator); setCopy('done'); }
    catch { setCopy('manual'); }
  }
  return <span className="thread-origin"><button type="button" className="recap-thread-link" onClick={() => void copyLocator()}>{copy === 'done' ? '已复制定位信息' : '复制对话定位'}</button>
    {copy === 'manual' && <small role="status">可手动复制<code>{locator}</code></small>}</span>;
}
