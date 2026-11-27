import { describe, expect, it } from 'vitest';
import type { CanvasNodeRecord, SnapshotProject } from '../../src/shared/schema.js';
import { compactP1Projects, filterDrawerProjects } from '../../src/web/projectDrawer.js';

const now = '2026-09-05T00:00:00.000Z';
const project = (key: string, index: number): SnapshotProject => ({ projectKey: key, name: `项目 ${key}`, sidebarIndex: index, observedAt: now });
const node = (key: string, priority: CanvasNodeRecord['manualPriority']): CanvasNodeRecord => ({ id: `project:${key}`, kind: 'task', threadKey: null, projectKey: key, archivedAt: null, manualPriority: priority, aspectLocked: null, x: 0, y: 0, width: 180, height: 180, zIndex: 1, title: key, body: '', lastViewedAt: null, revision: 0, createdAt: now, updatedAt: now });

describe('compact project drawer', () => {
  it('shows at most four user-authored P1 projects and reports overflow in sidebar order', () => {
    const projects = ['a', 'b', 'c', 'd', 'e', 'f'].map(project);
    const result = compactP1Projects(projects, [node('a', 'p1'), node('b', 'p2'), node('c', 'p1'), node('d', 'p1'), node('e', 'p1'), node('f', 'p1')]);
    expect(result.items.map((item) => item.projectKey)).toEqual(['a', 'c', 'd', 'e']);
    expect(result.overflow).toBe(1);
  });

  it('filters by search, manual priority and status without changing Codex order', () => {
    const projects = [project('zeta', 0), project('alpha', 1), project('beta', 2)];
    const signals = new Map([
      ['zeta', { actionRequired: true, uncertain: false, closed: false }],
      ['alpha', { actionRequired: false, uncertain: false, closed: false }],
      ['beta', { actionRequired: true, uncertain: false, closed: false }]
    ]);
    expect(filterDrawerProjects({ projects, records: [node('zeta', 'p3'), node('alpha', 'p2')], signals, search: '', priority: 'p2', status: 'all' }).map(item => item.projectKey)).toEqual(['zeta', 'alpha']);
    expect(filterDrawerProjects({ projects, records: [node('zeta', 'p1'), node('alpha', 'p1'), node('beta', 'p1')], signals, search: '项目', priority: 'p1', status: 'action' }).map((item) => item.projectKey)).toEqual(['zeta', 'beta']);
  });
});
