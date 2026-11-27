import { useEffect, useRef, useState } from 'react';
import type { BoardThread, SnapshotProject } from '../shared/schema.js';
import { canLocateExcerpt, excerptUnavailable, type ExcerptSource, type SourceExcerptResult } from '../shared/sourceExcerpt.js';
import { api } from './api.js';

interface Props { project?: SnapshotProject; thread: BoardThread; source: ExcerptSource; canRead: boolean }

export function SourceExcerpt({ project, thread, source, canRead }: Props) {
  if (!project || !canRead || !canLocateExcerpt(project, thread, source)) return null;
  const identity = JSON.stringify([project.projectKey, thread.threadKey, thread.threadId, source, thread.recap?.sourceFingerprint]);
  return <ExcerptControl key={identity} projectKey={project.projectKey} threadKey={thread.threadKey} source={source} />;
}

function ExcerptControl({ projectKey, threadKey, source }: { projectKey: string; threadKey: string; source: ExcerptSource }) {
  const root = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<SourceExcerptResult | null>(null);
  function close() {
    request.current?.abort();
    request.current = null;
    setResult(null);
    setOpen(false);
  }
  useEffect(() => () => { request.current?.abort(); }, []);
  useEffect(() => {
    if (!open) return;
    const groups: HTMLDetailsElement[] = [];
    for (let group = root.current?.closest('details'); group; group = group.parentElement?.closest('details')) groups.push(group);
    const onToggle = () => { if (groups.some(group => !group.open)) close(); };
    groups.forEach(group => group.addEventListener('toggle', onToggle));
    return () => groups.forEach(group => group.removeEventListener('toggle', onToggle));
  }, [open]);
  async function show() {
    if (request.current) return;
    const attempt = new AbortController();
    request.current = attempt;
    setOpen(true);
    try {
      const value = await api.sourceExcerpt(projectKey, threadKey, source.id, attempt.signal);
      if (!attempt.signal.aborted) setResult(value);
    } catch {
      if (!attempt.signal.aborted) setResult({ status: 'unavailable', reason: 'read' });
    }
  }
  return <div className="source-excerpt" ref={root}>
    <button type="button" aria-expanded={open} onClick={open ? close : () => void show()}>{open ? '收起原文' : '查看原文'}</button>
    {open && <div role="status">{result?.status === 'found'
      ? <><small>{source.role === 'user' ? '用户消息' : '助手最终回复'}{result.partial ? ' · 节选' : ' · 原文'}</small>
        <blockquote style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{result.text}</blockquote></>
      : result?.status === 'unavailable' ? excerptUnavailable[result.reason] : '正在读取本机来源…'}</div>}
  </div>;
}
