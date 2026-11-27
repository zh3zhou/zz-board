import { pageId } from './pages.js';
import type { CanvasNodeRecord, LocalLinkRecord } from './schema.js';

export interface NoteFoldEligibility { parentNodeId: string | null; reason: string | null }

/** Operates on projected project nodes, before hiding folded notes. Parallel edges are one graph edge. */
export function getNoteFoldEligibility(nodeId: string, nodes: CanvasNodeRecord[], links: LocalLinkRecord[]): NoteFoldEligibility {
  const target = nodes.find(node => node.id === nodeId);
  const active = new Map(nodes.filter((node) => !node.archivedAt && target && pageId(node) === pageId(target)).map((node) => [node.id, node]));
  const node = active.get(nodeId);
  const fail = (reason: string): NoteFoldEligibility => ({ parentNodeId: null, reason });
  if (!node || node.kind !== 'note') return fail('只有未归档便签可以收纳');
  const graph = new Map([...active.keys()].map((id) => [id, new Set<string>()]));
  for (const link of links) {
    if (link.sourceNodeId === link.targetNodeId || !active.has(link.sourceNodeId) || !active.has(link.targetNodeId)) continue;
    graph.get(link.sourceNodeId)!.add(link.targetNodeId);
    graph.get(link.targetNodeId)!.add(link.sourceNodeId);
  }
  const component = new Set([nodeId]);
  const queue = [nodeId];
  for (let index = 0; index < queue.length; index++) for (const next of graph.get(queue[index]!)!) {
    if (!component.has(next)) { component.add(next); queue.push(next); }
  }
  const roots = queue.filter((id) => active.get(id)!.kind === 'task' && Boolean(active.get(id)!.projectKey));
  if (roots.length !== 1) return fail(roots.length ? '连接包含多个项目上游，暂不支持收纳' : '需要连接到唯一项目气泡');
  const edges = queue.reduce((count, id) => count + graph.get(id)!.size, 0) / 2;
  if (edges !== component.size - 1) return fail('环形或多个上游连接暂不支持收纳');
  const parents = new Map<string, string | null>([[roots[0]!, null]]);
  const ordered = [roots[0]!];
  for (let index = 0; index < ordered.length; index++) for (const next of graph.get(ordered[index]!)!) {
    if (!parents.has(next)) { parents.set(next, ordered[index]!); ordered.push(next); }
  }
  return { parentNodeId: parents.get(nodeId) ?? null, reason: null };
}

/** Follow only validated folds; invalid host state never makes a note unreachable. */
export function visibleFoldHost(nodeId: string, nodes: CanvasNodeRecord[], links: LocalLinkRecord[]): string {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  let current = nodeId;
  while (!seen.has(current)) {
    seen.add(current);
    const host = byId.get(current)?.foldedIntoNodeId;
    if (!host || getNoteFoldEligibility(current, nodes, links).parentNodeId !== host) break;
    current = host;
  }
  return current;
}
