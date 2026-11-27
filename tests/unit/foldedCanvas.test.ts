import { describe, expect, it } from 'vitest';
import { foldedCanvasProjection } from '../../src/web/foldedCanvas.js';
import type { CanvasNodeRecord, LocalLinkRecord } from '../../src/shared/schema.js';
const node = (id: string, foldedIntoNodeId: string | null = null): CanvasNodeRecord => ({ id, kind: id === 'root' ? 'task' : 'note', threadKey: null, projectKey: id === 'root' ? 'project' : null, title: id, body: id, x: 1, y: 2, width: 100, height: 100, zIndex: 0, foldedIntoNodeId, revision: 0, createdAt: '', updatedAt: '', lastViewedAt: null });
const link = (sourceNodeId: string, targetNodeId: string, id = `${sourceNodeId}-${targetNodeId}`): LocalLinkRecord => ({ id, sourceNodeId, targetNodeId, label: '', revision: 0, createdAt: '' });
describe('folded view projection', () => {
  it('redirects downstream links without rewriting ids, coordinates or actual endpoints', () => {
    const nodes = [node('root'), node('a', 'root'), node('b')]; const links = [link('root', 'a'), link('a', 'b')];
    const before = structuredClone({ nodes, links }); const view = foldedCanvasProjection(nodes, links);
    expect([...view.hiddenIds]).toEqual(['a']);
    expect(view.links[0]).toMatchObject({ id: 'a-b', sourceNodeId: 'root', targetNodeId: 'b' });
    expect(view.links[0].projectedLabel).toContain('a'); expect({ nodes, links }).toEqual(before);
  });
  it('flattens nested retrieval and keeps historical duplicate relations individually addressable', () => {
    const view = foldedCanvasProjection([node('root'), node('a', 'root'), node('b', 'a'), node('c')], [link('root','a'),link('a','b'),link('b','c'),link('b','c','legacy')]);
    expect(view.hosted.get('root')?.map((n) => n.id)).toEqual(['a','b']);
    expect(view.links.map((l) => l.id)).toEqual(['b-c','legacy']);
  });
  it('invalid relations show nodes instead of trapping them invisibly', () => {
    const view = foldedCanvasProjection([node('root'),node('a','root'),node('b')], [link('root','a'),link('a','b'),link('b','root')]);
    expect(view.hiddenIds.size).toBe(0);
  });
});
