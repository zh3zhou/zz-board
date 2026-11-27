import type { BoardState, CanvasNodeRecord } from '../shared/schema.js';
import { codexThreadUuid } from '../shared/conversationNote.js';
import { ThreadSourceLink } from './ThreadSourceLink.js';

export function NoteOriginLink({ note, board, onLocate }: {
  note: Pick<CanvasNodeRecord, 'noteSource'>;
  board: Pick<BoardState, 'projects' | 'threads'>;
  onLocate(threadKey: string): void;
}) {
  const source = note.noteSource;
  if (!source) return null;
  const project = board.projects.find(item => item.projectKey === source.projectKey);
  const id = codexThreadUuid(source.threadId) ?? source.threadId;
  const candidates = board.threads.filter(item => (codexThreadUuid(item.threadId) ?? item.threadId) === id || item.threadKey === source.threadKey);
  const sameOrigin = candidates.filter(item => {
    const host = item.hostId ?? (item.sourceKind === 'codex' && item.threadKey === `codex:local:${item.threadId}` ? 'local' : undefined);
    return (codexThreadUuid(item.threadId) ?? item.threadId) === id && item.sourceKind === source.sourceKind && host === source.hostId;
  });
  const matching = sameOrigin.filter(item => !source.threadKey || item.threadKey === source.threadKey);
  if (project && (!project.hostId || project.hostId === source.hostId) && matching.length === 1 && sameOrigin.every(item => item.projectKey === source.projectKey)) {
    const thread = matching[0]!;
    return <button type="button" className="recap-thread-link" onClick={() => onLocate(thread.threadKey)}>来源对话 · {thread.title}</button>;
  }
  return <span className="note-origin"><small>来源对话尚未在看板定位</small>{' '}
    <ThreadSourceLink thread={source} project={project} copyOnly={candidates.length > 0 || !project} />
  </span>;
}
