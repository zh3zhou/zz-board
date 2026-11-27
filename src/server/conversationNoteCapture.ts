import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { codexThreadUuid, type CaptureConversationNoteInput, type ConversationNoteSource } from '../shared/conversationNote.js';

export class ConversationNoteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

interface ProjectRow { projectKey: string; name: string; hostId: string | null; cwd: string | null }
interface ThreadRow { threadKey: string; sourceKind: string; hostId: string | null; threadId: string; projectKey: string | null }
interface ProjectAnchor {
  nodeId: string; pageId: string; pageName: string; x: number; y: number; width: number;
  pageArchived: string | null; nodeArchived: string | null;
}

function directoryKey(value: string | null): string | null {
  if (!value) return null;
  const windows = value.replaceAll('/', '\\').replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\(?=[a-z]:\\)/i, '');
  if (/^\\\\[?.]\\/.test(windows)) return null;
  if (/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+)/i.test(windows)) {
    return 'win:' + path.win32.normalize(windows).replace(/\\+$/, '').toLowerCase();
  }
  return value.startsWith('/') && !value.startsWith('//') ? 'posix:' + (path.posix.normalize(value).replace(/\/+$/, '') || '/') : null;
}

export function captureTarget(db: DatabaseSync, input: CaptureConversationNoteInput) {
  const select = 'SELECT project_key AS projectKey, name, host_id AS hostId, cwd FROM projects';
  let projects: ProjectRow[];
  if ('directory' in input.project) {
    const directory = directoryKey(input.project.directory);
    if (!directory) throw new ConversationNoteError(400, 'invalid_capture', '请提供已登记的项目绝对目录。');
    const local = db.prepare(select + " WHERE host_id='local' OR host_id IS NULL").all() as unknown as ProjectRow[];
    projects = local.filter(project => directoryKey(project.cwd) === directory);
  } else {
    projects = db.prepare(select + ' WHERE project_key=?').all(input.project.projectKey) as unknown as ProjectRow[];
  }
  if (projects.length > 1) throw new ConversationNoteError(409, 'ambiguous_project', '该目录有多个项目，请核对项目键。');
  const project = projects[0];
  if (!project) throw new ConversationNoteError(404, 'project_not_found', '看板找不到目标项目。');
  if (input.expectedProjectKey && project.projectKey !== input.expectedProjectKey) {
    throw new ConversationNoteError(409, 'project_changed', '预览后项目归属已变化，请重新预览。');
  }
  const anchor = db.prepare(
    "SELECT n.id AS nodeId,n.page_id AS pageId,n.x,n.y,n.width,n.archived_at AS nodeArchived,p.name AS pageName,p.archived_at AS pageArchived " +
    "FROM canvas_nodes n JOIN canvas_pages p ON p.id=n.page_id WHERE n.project_key=? AND n.kind='task' AND n.thread_key IS NULL"
  ).get(project.projectKey) as unknown as ProjectAnchor | undefined;
  if (!anchor) throw new ConversationNoteError(404, 'project_not_found', '看板缺少该项目的主气泡。');
  if (anchor.nodeArchived || anchor.pageArchived) throw new ConversationNoteError(409, 'project_archived', '项目或所在页面已归档。');
  return { project, anchor, source: captureSource(db, project, input) };
}

function captureSource(db: DatabaseSync, project: ProjectRow, input: CaptureConversationNoteInput): ConversationNoteSource {
  const { hostId, threadId, threadKey } = input.source;
  const mismatch = () => new ConversationNoteError(409, 'source_mismatch', '当前对话与看板所存的项目、主机或来源信息不一致。');
  if (project.hostId && project.hostId !== hostId) throw mismatch();
  const uuid = codexThreadUuid(threadId);
  const collate = uuid ? ' COLLATE NOCASE' : '';
  const localKey = 'codex:local:' + (uuid ?? threadId);
  const rows = db.prepare(
    'SELECT thread_key AS threadKey,source_kind AS sourceKind,host_id AS hostId,thread_id AS threadId,project_key AS projectKey ' +
    'FROM threads WHERE thread_id=?' + collate + ' OR thread_key=? OR thread_key=?' + collate
  ).all(threadId, threadKey ?? null, hostId === 'local' ? localKey : null) as unknown as ThreadRow[];
  const sameNativeId = (row: ThreadRow) => uuid ? row.threadId.toLowerCase() === uuid : row.threadId === threadId;
  const hasLocalKey = (row: ThreadRow) => (uuid ? row.threadKey.toLowerCase() : row.threadKey) === localKey;
  if (rows.some(row => hasLocalKey(row) && (!sameNativeId(row) || row.sourceKind !== 'codex' || row.hostId && row.hostId !== 'local'))) throw mismatch();
  const verified = rows.filter(row => {
    if (!sameNativeId(row)) return false;
    const host = row.hostId ?? (hasLocalKey(row) && row.sourceKind === 'codex' ? 'local' : null);
    return host === hostId && (row.sourceKind === 'codex' || row.sourceKind === 'remote' && host !== 'local');
  });
  if (verified.some(row => row.projectKey !== project.projectKey)) throw mismatch();
  const matches = threadKey ? verified.filter(row => row.threadKey === threadKey) : verified;
  if (matches.length > 1) throw new ConversationNoteError(409, 'ambiguous_source', '该对话有多个来源键，请核对准确的来源键。');
  const found = matches[0];
  if (found) return { projectKey: project.projectKey, hostId, threadId: found.threadId, threadKey: found.threadKey, sourceKind: found.sourceKind === 'remote' ? 'remote' : 'codex' };
  if (rows.length) throw mismatch();
  // A running local session can save its own origin before a board sync has indexed that thread.
  // This records provenance on the note only. An opaque or remote origin needs a saved board match.
  if (!threadKey && hostId === 'local' && project.hostId === 'local' && 'directory' in input.project && uuid) {
    return { projectKey: project.projectKey, hostId, threadId: uuid, threadKey: null, sourceKind: 'codex' };
  }
  throw new ConversationNoteError(404, 'source_not_found', '尚无可核对的来源对话，请先确认项目和来源身份。');
}
