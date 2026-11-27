import { describe, expect, it } from 'vitest';
import { getNoteFoldEligibility, visibleFoldHost } from '../../src/shared/noteFolding.js';
import type { CanvasNodeRecord, LocalLinkRecord } from '../../src/shared/schema.js';

const node = (id: string, project = false): CanvasNodeRecord => ({ id, kind: project ? 'task' : 'note', projectKey: project ? id : null, threadKey: null, x: 0, y: 0, width: 200, height: 150, zIndex: 0, title: '', body: '', revision: 0, createdAt: '', updatedAt: '', lastViewedAt: null });
const edge = (a: string, b: string): LocalLinkRecord => ({ id: `${a}-${b}`, sourceNodeId: a, targetNodeId: b, label: '', revision: 0, createdAt: '' });

describe('upstream note folding', () => {
  it('finds immediate upstream independently of edge direction, position and duplicates', () => {
    const nodes = [node('root', true), node('a'), node('b'), node('branch')];
    const links = [edge('a', 'root'), edge('root', 'a'), edge('b', 'a'), edge('a', 'branch')];
    expect(getNoteFoldEligibility('b', nodes, links)).toEqual({ parentNodeId: 'a', reason: null });
    expect(getNoteFoldEligibility('a', nodes, links).parentNodeId).toBe('root');
    nodes[1]!.foldedIntoNodeId = 'root'; nodes[2]!.foldedIntoNodeId = 'a';
    expect(visibleFoldHost('b', nodes, links)).toBe('root');
    nodes[1]!.archivedAt = 'now';
    expect(visibleFoldHost('b', nodes, links)).toBe('b');
  });

  it('rejects no-root, multi-root, cycles, archived notes and root folding', () => {
    const nodes = [node('root', true), node('root2', true), node('a'), node('b')];
    expect(getNoteFoldEligibility('a', nodes, []).reason).toBeTruthy();
    expect(getNoteFoldEligibility('a', nodes, [edge('root', 'a'), edge('root2', 'a')]).reason).toMatch(/多个/);
    expect(getNoteFoldEligibility('a', nodes, [edge('root', 'a'), edge('a', 'b'), edge('b', 'root')]).reason).toMatch(/环形/);
    expect(getNoteFoldEligibility('root', nodes, []).reason).toBeTruthy();
  });
});
