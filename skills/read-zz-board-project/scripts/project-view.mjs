import path from 'node:path';
import { assetIdPattern, canvasPosition, latestNote, noteBlocks, noteChecklist, projectNoteScope, ReadError } from './note-view.mjs';
export { ReadError } from './note-view.mjs';

// Only compare fully qualified paths. A remote path or a basename is never a local identity.
function directoryKey(value) {
  if (typeof value !== 'string') return null;
  // The Windows runtime can return either the regular or the extended form of the same path.
  value = value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\(?=[a-z]:\\)/i, '');
  if (/^\\\\[?.]\\/.test(value)) return null;
  if (/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(value)) {
    return 'win:' + path.win32.normalize(value).replace(/[\\]+$/, '').toLowerCase();
  }
  if (value.startsWith('/')) return 'posix:' + (path.posix.normalize(value).replace(/\/+$/, '') || '/');
  return null;
}

function selectProject(projects, { projectKey, directory }) {
  const cwd = directoryKey(directory);
  const matches = projects.filter(p => projectKey !== undefined ? p.projectKey === projectKey :
    (!p.hostId || p.hostId === 'local') && cwd !== null && directoryKey(p.cwd) === cwd);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new ReadError('ambiguous_project', '目录对应多个记录；请使用确认过的 --project-key。', [...new Set(matches.map(p => p.projectKey))]);
  throw new ReadError('project_not_found', '没有匹配的项目。请从已登记的项目根目录运行，或指定准确的 --project-key；不会按名称猜测。');
}

const DEFAULT_PAGE = 'page:default';
export function isCalendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function metadata(n, projected) {
  const manualPriority = ['p1', 'p2', 'p3'].includes(n.manualPriority) ? n.manualPriority : null;
  const base = {id: n.id, pageId: n.pageId ?? DEFAULT_PAGE, manualPriority, archivedAt: n.archivedAt ?? null,
    createdAt: n.createdAt, nodeUpdatedAt: n.updatedAt, revision: n.revision};
  if (!projected) return {...base, effectivePriority: manualPriority === 'p3' ? 'p2' : manualPriority,
    prioritySource: manualPriority ? 'manual' : null, noteSchedule: null, contentEditedAt: null};
  const s = n.noteSchedule;
  if (!['p1', 'p2', null].includes(n.effectivePriority) || !['manual', 'date', 'both', null].includes(n.prioritySource) ||
      (n.contentEditedAt !== null && !(typeof n.contentEditedAt === 'string' && Number.isFinite(Date.parse(n.contentEditedAt)))) ||
      (s !== null && (!s || !isCalendarDay(s.dueDate) || typeof s.autoPromote !== 'boolean' || typeof s.completed !== 'boolean' ||
        !Number.isSafeInteger(s.attentionDays) || !Number.isSafeInteger(s.priorityDays)))) {
    throw new ReadError('invalid_board', '看板返回的优先级或便签时间格式无效。');
  }
  return {...base, effectivePriority:n.effectivePriority, prioritySource:n.prioritySource, contentEditedAt:n.contentEditedAt,
    noteSchedule:s ? {dueDate:s.dueDate, autoPromote:s.autoPromote, attentionDays:s.attentionDays, priorityDays:s.priorityDays, completed:s.completed} : null};
}
const priorityRank = p => ({p1: 1, p2: 2})[p] ?? 3;
const compareId = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** Project scope: direct notes are anchors. An indirect region can be read only
 * when every bordering anchor belongs exclusively to this project. Classify with archived
 * and unknown roots present; hiding a boundary must never give its branch to another owner. */
export function projectView(board, options) {
  if (!board || !['projects','threads','nodes','links','annotations'].every(k => Array.isArray(board[k])) || !Number.isSafeInteger(board.boardRevision)) {
    throw new ReadError('invalid_board', '服务没有返回可识别的 ZZ Board 看板。');
  }
  const projected = board.priorityDate !== undefined;
  if (projected && !isCalendarDay(board.priorityDate)) throw new ReadError('invalid_board', '看板没有返回有效的优先级评估日。');
  if (options.priorityDate !== undefined && options.priorityDate !== board.priorityDate) {
    throw new ReadError('priority_date_unavailable', '服务未按请求日期评估优先级。请从首页重新读取。');
  }
  if (projected && options.offset > 0 && !options.priorityDate) {
    throw new ReadError('priority_date_required', '续页时请同时传入首页的 --priority-date 与 --board-revision。');
  }
  const project = selectProject(board.projects, options);
  const {nodes, pages, rootIds, routes, visibleNotes, relation, bubble, excludedByArchive} =
    projectNoteScope(board, project.projectKey, options.includeArchived);

  const detail = Boolean(options.latest || options.noteId !== undefined);
  if (options.noteId !== undefined && (!routes.has(options.noteId) || nodes.get(options.noteId).kind !== 'note')) {
    throw new ReadError('note_not_in_scope', '当前项目及归档范围内未找到这张便签。');
  }
  const selected = options.latest ? latestNote(visibleNotes, projected) : nodes.get(options.noteId);
  const projectBubble = bubble && !excludedByArchive ? metadata(bubble, projected) : null;
  const notes = (detail ? (selected ? [selected] : []) : visibleNotes).map(n => {
    const id = n.id;
    if (typeof n.body !== 'string') throw new ReadError('invalid_board', '便签正文格式无效。');
    const blocks = detail ? noteBlocks(n) : null;
    const source = n.noteSource;
    const noteSource = source?.projectKey === project.projectKey && ['codex', 'remote'].includes(source.sourceKind)
      && typeof source.hostId === 'string' && typeof source.threadId === 'string' && (source.threadKey === null || typeof source.threadKey === 'string')
      ? { projectKey: project.projectKey, sourceKind: source.sourceKind, hostId: source.hostId, threadId: source.threadId, threadKey: source.threadKey }
      : null;
    return {...metadata(n, projected), relation: relation(id),
      ...routes.get(id), title: n.title ?? '', body: n.body, ...(noteSource ? {noteSource} : {}),
      notePresentation: n.notePresentation === 'image' ? 'image' : 'note',
      canvas: canvasPosition(n), checklist: noteChecklist(n.body),
      ...(blocks ? {blocks} : {}),
      imageAssetIds: [...new Set((blocks ?? n.noteDocument?.content ?? []).filter(b => b.type === 'image' && typeof b.assetId === 'string' && assetIdPattern.test(b.assetId)).map(b => b.assetId))]};
  }).sort((a, b) => priorityRank(a.effectivePriority) - priorityRank(b.effectivePriority) || compareId(a.id, b.id));
  const annotations = board.annotations.filter(a => detail ? selected && a.targetNodeId === selected.id : routes.has(a.targetNodeId))
    .map(a => ({id: a.id, targetNodeId: a.targetNodeId, targetKind: rootIds.has(a.targetNodeId) ? 'project-member' : 'note',
      pageId: nodes.get(a.targetNodeId).pageId ?? DEFAULT_PAGE, body: a.body, resolved: a.resolved, createdAt: a.createdAt, updatedAt: a.updatedAt, revision: a.revision}))
    .sort((a, b) => Number(a.resolved) - Number(b.resolved) || compareId(a.id, b.id));

  // Page whole records so that a planning prompt never silently loses the end of a note.
  const offset = options.offset ?? 0, total = notes.length + annotations.length;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) throw new ReadError('invalid_offset', '分页位置无效，请从首页重新读取。');
  const resultNotes = [], resultAnnotations = [];
  let next = offset, chars = 0;
  for (; next < total && next - offset < 32; next++) {
    const note = next < notes.length;
    const record = note ? notes[next] : annotations[next - notes.length];
    const size = JSON.stringify(record).length;
    if (next !== offset && chars + size > 16000) break;
    (note ? resultNotes : resultAnnotations).push(record); chars += size;
  }
  const usedPages = new Set([...(projectBubble ? [projectBubble.pageId] : []), ...resultNotes.map(n => n.pageId), ...resultAnnotations.map(a => a.pageId)]);
  return {schemaVersion: 1, boardRevision: board.boardRevision, priorityDate: board.priorityDate ?? null,
    ...(detail ? {selection:{by:options.latest ? 'latest' : 'id', noteId:selected?.id ?? null,
      ...(options.latest && selected ? {timeBasis:projected && selected.contentEditedAt != null ? 'contentEditedAt' : 'createdAt'} : {})}} : {}),
    prioritySupport: projected ? 'board-evaluated' : 'manual-only-legacy',
    project: {projectKey: project.projectKey, projectId: project.projectId ?? null, hostId: project.hostId ?? null, name: project.name,
      matchedBy: options.projectKey !== undefined ? 'projectKey' : 'local-directory', excludedByArchive, bubble: projectBubble},
    includeArchived: Boolean(options.includeArchived), pages: [...usedPages].map(id => ({id, name: pages.get(id)?.name ?? (id === DEFAULT_PAGE ? '默认页' : null), archivedAt: pages.get(id)?.archivedAt ?? null})),
    counts: {notes: notes.length, annotations: annotations.length}, offset, nextOffset: next < total ? next : null, notes: resultNotes, annotations: resultAnnotations};
}
