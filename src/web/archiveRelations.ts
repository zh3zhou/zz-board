import type { BoardState, CanvasNodeRecord } from '../shared/schema.js';
import { noteDisplayText, taskDisplayTitle } from './bubblePresentation.js';
import { foldedCanvasProjection } from './foldedCanvas.js';
import { archivedNotes } from './noteArchive.js';
import { canvasLinks, contextForNode, visibleCanvasRecords } from './projectCanvas.js';

export interface ArchivedRelationTarget {
  nodeId: string;
  canvasNodeId: string | null;
  kind: 'task' | 'note';
  title: string;
}

export interface ArchivedNoteRelation {
  note: CanvasNodeRecord;
  related: ArchivedRelationTarget[];
  linkCount: number;
}

export function archivedNoteRelations(board: BoardState): ArchivedNoteRelation[] {
  const visible = visibleCanvasRecords(board);
  const folding = foldedCanvasProjection(visible, canvasLinks(board, visible));
  const endpointMap = new Map<string, CanvasNodeRecord>();
  for (const record of visible) {
    endpointMap.set(record.id, record);
    for (const memberId of contextForNode(board, record)?.memberNodeIds || []) endpointMap.set(memberId, record);
  }
  // Reuse the canvas's validated, saved folds; persisted link endpoints stay unchanged.
  for (const [hostId, notes] of folding.hosted) {
    const host = endpointMap.get(hostId);
    if (host) for (const note of notes) endpointMap.set(note.id, host);
  }
  for (const note of archivedNotes(board.nodes)) endpointMap.set(note.id, note);

  return archivedNotes(board.nodes).map((note) => {
    const attached = board.links.filter((link) => link.sourceNodeId === note.id || link.targetNodeId === note.id);
    const seen = new Set<string>();
    const related = attached.flatMap((link): ArchivedRelationTarget[] => {
      const endpointId = link.sourceNodeId === note.id ? link.targetNodeId : link.sourceNodeId;
      const record = endpointMap.get(endpointId) || board.nodes.find((node) => node.id === endpointId);
      if (!record) return [];
      const canvasRecord = endpointMap.get(endpointId) || record;
      if (seen.has(canvasRecord.id)) return [];
      seen.add(canvasRecord.id);
      const project = contextForNode(board, canvasRecord)?.project;
      const thread = board.threads.find((item) => item.threadKey === canvasRecord.threadKey);
      return [{
        nodeId: endpointId,
        canvasNodeId: canvasRecord.archivedAt ? null : canvasRecord.id,
        kind: canvasRecord.kind,
        title: canvasRecord.kind === 'note'
          ? excerpt(noteDisplayText(canvasRecord) || '空白便签')
          : taskDisplayTitle(thread, canvasRecord, project)
      }];
    });
    return { note, related, linkCount: attached.length };
  });
}

export function archivedRelationsForNode(board: BoardState, record: CanvasNodeRecord): ArchivedNoteRelation[] {
  const endpoints = new Set([record.id, ...(contextForNode(board, record)?.memberNodeIds || [])]);
  return archivedNoteRelations(board).filter((relation) =>
    relation.related.some((target) => target.canvasNodeId !== null && endpoints.has(target.canvasNodeId)) || board.links.some((link) =>
    (link.sourceNodeId === relation.note.id && endpoints.has(link.targetNodeId)) ||
    (link.targetNodeId === relation.note.id && endpoints.has(link.sourceNodeId))));
}

function excerpt(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > 42 ? `${clean.slice(0, 42)}…` : clean;
}
