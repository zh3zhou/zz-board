import type { BoardState, BoardThread, CanvasNodeRecord } from '../shared/schema.js';
import { boardPages, pageId, type CanvasPageRecord } from '../shared/pages.js';
import { canvasLinks, visibleCanvasRecords } from './projectCanvas.js';

export function pageRecords(board: BoardState, id: string): CanvasNodeRecord[] {
  return visibleCanvasRecords(board).filter(record => pageId(record) === id);
}

export interface PageSearchMatch {
  record: CanvasNodeRecord;
  page?: CanvasPageRecord;
  thread?: BoardThread;
  identity?: string;
}

function shortIdentity(thread: BoardThread) {
  return `${thread.hostId ?? thread.sourceKind} · ${thread.threadId.slice(-8)}`;
}

export function pageSearch(board: BoardState, query: string, records = visibleCanvasRecords(board)): PageSearchMatch[] {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return [];
  const pages = new Map(boardPages(board).map(page => [page.id, page]));
  const projectNodes = new Map<string, CanvasNodeRecord>();
  const standaloneNodes = new Map<string, CanvasNodeRecord>();
  const knownThreads = new Set(board.threads.map(thread => thread.threadKey));
  const matches: Array<{ hit: PageSearchMatch; rank: number }> = [];
  const homonyms = new Map<string, BoardThread[]>();

  for (const record of records) {
    if (record.kind === 'task' && record.threadKey) {
      standaloneNodes.set(record.threadKey, record);
      if (knownThreads.has(record.threadKey)) continue;
    }
    if (record.kind === 'task' && record.projectKey && !record.threadKey) projectNodes.set(record.projectKey, record);
    const title = record.title.trim().toLocaleLowerCase();
    const titleMatch = title.includes(term);
    if (!titleMatch && !record.body.toLocaleLowerCase().includes(term)) continue;
    matches.push({ hit: { record, page: pages.get(pageId(record)) }, rank: title === term ? 1 : titleMatch ? 2 : 3 });
  }
  for (const thread of board.threads) {
    const title = thread.title.trim().toLocaleLowerCase();
    if (!title.includes(term)) continue;
    const record = (thread.projectKey && projectNodes.get(thread.projectKey)) || standaloneNodes.get(thread.threadKey);
    if (!record) continue;
    const peers = homonyms.get(title);
    if (peers) peers.push(thread); else homonyms.set(title, [thread]);
    matches.push({ hit: { record, page: pages.get(pageId(record)), thread }, rank: title === term ? 0 : 2 });
  }
  // Rank every match before applying the shared limit. Preserve source order for ties.
  return matches.sort((a, b) => a.rank - b.rank).slice(0, 60).map(({ hit }) => {
    const { thread } = hit;
    if (thread) {
      const peers = homonyms.get(thread.title.trim().toLocaleLowerCase())!;
      if (peers.length > 1) {
        const short = shortIdentity(thread);
        hit.identity = peers.some(peer => peer !== thread && shortIdentity(peer) === short) ? thread.threadKey : short;
      }
    }
    return hit;
  });
}

export function pageMovePreview(board: BoardState, ids: readonly string[], inkIds: readonly string[]) {
  const records = visibleCanvasRecords(board);
  const selected = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) if (record.foldedIntoNodeId && selected.has(record.foldedIntoNodeId) && !selected.has(record.id)) {
      selected.add(record.id); changed = true;
    }
  }
  const moved = records.filter(record => selected.has(record.id));
  const links = canvasLinks(board, records);
  return { nodes: moved, ink: board.inkStrokes.filter(stroke => inkIds.includes(stroke.id)),
    externalLinks: links.filter(link => selected.has(link.sourceNodeId) !== selected.has(link.targetNodeId)).length };
}
