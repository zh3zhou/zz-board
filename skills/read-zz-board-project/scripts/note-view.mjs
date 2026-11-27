export class ReadError extends Error {
  constructor(code, message, candidates) { super(message); this.code = code; this.candidates = candidates; }
}

export const assetIdPattern = /^[a-f0-9]{64}$/;

/** A node move and a priority change do not make its content newer. */
export function latestNote(notes, projected) {
  let best = null, time = -Infinity;
  for (const note of notes) {
    const field = projected && note.contentEditedAt != null ? 'contentEditedAt' : 'createdAt';
    const saved = Date.parse(note[field]);
    if (!Number.isFinite(saved)) throw new ReadError('invalid_board', '无法核对便签的内容或创建时间。');
    if (saved > time || (saved === time && note.id < best.id)) {
      best = note; time = saved;
    }
  }
  return best;
}

export function canvasPosition(n) {
  // Bounds are saved world units. The screen and text wrapping also depend on the viewport and editor width.
  const bounds = [n.x,n.y,n.width,n.height].every(Number.isFinite) ? {x:n.x,y:n.y,width:n.width,height:n.height} : null;
  return {bounds, unit:'world', folded: Boolean(n.foldedIntoNodeId)};
}

export function noteBlocks(n) {
  const invalid = () => new ReadError('invalid_board', '便签含无法解释的图文块或位置。');
  const doc = n.noteDocument;
  if (doc == null) return n.body ? [{type:'text',text:n.body}] : [];
  if ((doc.version !== undefined && doc.version !== 1) || !Array.isArray(doc.content) || doc.content.length > 2000) throw invalid();
  let images = 0;
  const blocks = doc.content.map(part => {
    if (part?.type === 'text' && typeof part.text === 'string') return {type:'text',text:part.text};
    if (part?.type !== 'image' || typeof part.assetId !== 'string' || !assetIdPattern.test(part.assetId) || ++images > 16) throw invalid();
    const {side = 'right', width = 45, placement, wrap} = part;
    if (!['left','right'].includes(side) || !Number.isFinite(width) || width < 15 || width > 100) throw invalid();
    const image = {type:'image',assetId:part.assetId,side,widthPercent:width};
    if (placement != null) {
      const {xPercent,offsetY} = placement;
      if (![xPercent,offsetY].every(Number.isFinite) || xPercent < 0 || xPercent + width > 100.000001 || offsetY < 0 || offsetY > 10000) throw invalid();
      image.placement = {xPercent,offsetY};
    }
    if (wrap !== undefined) {
      if (wrap !== 'none' || side !== 'left' || placement?.offsetY !== 0 || Math.abs(placement.xPercent - (100 - width) / 2) >= 0.000001) throw invalid();
      image.wrap = wrap;
    }
    return image;
  });
  if (blocks.filter(b => b.type === 'text').map(b => b.text).join('') !== n.body) throw invalid();
  return blocks;
}

export function noteChecklist(body) {
  const items = [];
  let fence = '';
  for (const [index,line] of body.split(/\r?\n/).entries()) {
    const delimiter = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (delimiter?.[1].startsWith(fence) && !delimiter[2].trim()) fence = '';
    } else if (delimiter) fence = delimiter[1];
    else {
      const match = /^\s*[-*] \[([ xX])\]\s+(.+)$/.exec(line);
      if (match) items.push({line:index + 1, completed:match[1] !== ' ', text:match[2]});
    }
  }
  return items;
}

/** Read only notes reachable from this project. Archived and foreign roots still establish ownership boundaries. */
export function projectNoteScope(board, projectKey, includeArchived = false) {
  const DEFAULT_PAGE = 'page:default';
  const nodes = new Map(board.nodes.map(n => [n.id, n]));
  const pages = new Map((board.pages ?? []).map(p => [p.id, p]));
  const threads = new Map(board.threads.map(t => [t.threadKey, t.projectKey]));
  const owner = n => {
    const viaThread = threads.get(n.threadKey);
    if (n.projectKey && n.threadKey && viaThread !== n.projectKey) return null;
    return n.projectKey || viaThread || null;
  };
  const members = board.nodes.filter(n => n.kind === 'task' && owner(n) === projectKey);
  const visible = n => includeArchived || (!n.archivedAt && !pages.get(n.pageId ?? DEFAULT_PAGE)?.archivedAt);
  const candidates = members.filter(n => n.projectKey === projectKey && !n.threadKey);
  const bubble = candidates.find(n => n.id === 'project:' + projectKey) ?? (candidates.length === 1 ? candidates[0] : null);
  // An archived canonical bubble controls the whole project, even if an old thread alias is on an active page.
  const visibleMembers = bubble && !visible(bubble) ? [] : members.filter(visible);
  const rootIds = new Set(members.map(n => n.id));
  const graph = new Map(board.nodes.map(n => [n.id, new Map()]));
  for (const link of board.links) {
    const {sourceNodeId: a, targetNodeId: b} = link;
    if (a !== b && nodes.has(a) && nodes.has(b)) { graph.get(a).set(b, link); graph.get(b).set(a, link); }
  }
  const MINE = 1, OTHER = 2;
  const anchors = new Map();
  for (const n of board.nodes) if (n.kind === 'task') {
    for (const id of graph.get(n.id).keys()) if (nodes.get(id).kind === 'note') {
      anchors.set(id, (anchors.get(id) ?? 0) | (rootIds.has(n.id) ? MINE : OTHER));
    }
  }
  const allowed = new Set([...anchors].filter(([, tag]) => tag & MINE).map(([id]) => id));
  const seen = new Set(anchors.keys());
  for (const n of board.nodes) {
    if (n.kind !== 'note' || seen.has(n.id)) continue;
    const region = [n.id]; seen.add(n.id); let borders = 0;
    for (let i = 0; i < region.length; i++) for (const id of graph.get(region[i]).keys()) {
      if (anchors.has(id)) borders |= anchors.get(id);
      else if (!seen.has(id) && nodes.get(id).kind === 'note') { seen.add(id); region.push(id); }
    }
    if (borders === MINE) for (const id of region) allowed.add(id);
  }
  // Only return content reachable from a visible project member; never transit a shared anchor.
  const queue = visibleMembers.map(n => n.id);
  const routes = new Map(queue.map(id => [id, {distance: 0, viaNodeId: null}]));
  for (let i = 0; i < queue.length; i++) {
    const from = queue[i];
    if (anchors.get(from) === (MINE | OTHER)) continue;
    for (const [id, link] of graph.get(from)) {
      if (!allowed.has(id) || routes.has(id) || !visible(nodes.get(id))) continue;
      // An explicitly shared note may only be disclosed through our own visible direct edge.
      if (anchors.get(id) === (MINE | OTHER) && !rootIds.has(from)) continue;
      routes.set(id, {distance: routes.get(from).distance + 1, viaNodeId: from, viaLinkId: link.id, viaLinkLabel: link.label}); queue.push(id);
    }
  }

  const visibleNotes = queue.filter(id => !rootIds.has(id)).map(id => nodes.get(id));
  function relation(id) {
    return anchors.get(id) === (MINE | OTHER) ? 'shared-direct' : routes.get(id).distance === 1 ? 'direct' : 'indirect';
  }
  return {nodes, pages, rootIds, routes, visibleNotes, relation, bubble, excludedByArchive:Boolean(bubble && !visible(bubble))};
}
