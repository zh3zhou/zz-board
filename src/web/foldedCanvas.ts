import type { CanvasNodeRecord, LocalLinkRecord } from '../shared/schema.js';
import { getNoteFoldEligibility } from '../shared/noteFolding.js';

/** View-only redirection: never modify true link endpoints or saved positions. */
export function foldedCanvasProjection(nodes: CanvasNodeRecord[], links: LocalLinkRecord[]) {
  const valid = new Map<string, string>();
  for (const node of nodes) {
    if (!node.foldedIntoNodeId) continue;
    const eligibility = getNoteFoldEligibility(node.id, nodes, links);
    if (eligibility.parentNodeId === node.foldedIntoNodeId) valid.set(node.id, node.foldedIntoNodeId);
  }
  const host = (id: string) => {
    const seen = new Set<string>();
    while (valid.has(id) && !seen.has(id)) { seen.add(id); id = valid.get(id)!; }
    return id;
  };
  const hosted = new Map<string, CanvasNodeRecord[]>();
  for (const node of nodes) if (valid.has(node.id)) {
    const key = host(node.id);
    hosted.set(key, [...(hosted.get(key) || []), node]);
  }
  const records = new Map(nodes.map((node) => [node.id, node]));
  const label = (id: string) => {
    const node = records.get(id);
    return (node?.kind === 'note' ? node.body : node?.title)?.replace(/\s+/g, ' ').slice(0, 28) || '空白便签';
  };
  return {
    hiddenIds: new Set(valid.keys()), hosted,
    links: links.flatMap((link) => {
      const sourceNodeId = host(link.sourceNodeId), targetNodeId = host(link.targetNodeId);
      if (sourceNodeId === targetNodeId) return [];
      const projectedLabel = sourceNodeId !== link.sourceNodeId || targetNodeId !== link.targetNodeId
        ? `收纳关联：${label(link.sourceNodeId)} ↔ ${label(link.targetNodeId)}` : undefined;
      return [{ ...link, sourceNodeId, targetNodeId, projectedLabel }];
    })
  };
}
