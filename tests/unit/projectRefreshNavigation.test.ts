import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactNode, type ReactElement } from 'react';
const hooks = vi.hoisted(() => ({ values: [] as unknown[], refs: [] as Array<{ current: any }>, state: 0, ref: 0,
  effects: [] as Array<{ run: () => void | (() => void); deps: readonly unknown[] }>,
  mounted: [] as Array<{ deps: readonly unknown[]; dispose: void | (() => void) }> }));
const apiMock = vi.hoisted(() => ({ refreshProject: vi.fn(), syncJobs: vi.fn(), projectRefreshStatus: vi.fn() }));
vi.mock('../../src/web/api.js', () => ({ api: apiMock }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => { const index = hooks.state++; if (!(index in hooks.values)) hooks.values[index] = initial; return [hooks.values[index], (value: any) => { hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value; }]; },
  useRef: (initial: unknown) => { const index = hooks.ref++; return hooks.refs[index] ??= { current: initial }; },
  useEffect: (run: () => void | (() => void), deps: readonly unknown[]) => { hooks.effects.push({ run, deps }); }
}));
import { ProjectRefreshStatus } from '../../src/web/ProjectRefreshStatus.js';
function elements(node: ReactNode): Array<ReactElement<Record<string, any>>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
const onBoardChange = vi.fn(async () => {});
const updated = vi.fn();
function render(online = true, readOnly = false, showControls = true, showOverview = false) {
  hooks.state = 0; hooks.ref = 0; hooks.effects = [];
  const tree = ProjectRefreshStatus({ projectKey: 'project:synthetic', online, readOnly, showControls, showOverview, onBoardChange, onUpdatedThreads: updated });
  hooks.effects.forEach(({ run, deps }, i) => {
    const previous = hooks.mounted[i];
    if (previous && deps.every((dep, k) => Object.is(dep, previous.deps[k]))) return;
    previous?.dispose?.(); hooks.mounted[i] = { deps, dispose: run() };
  });
  return { tree, cleanup: () => { hooks.mounted.forEach(effect => effect.dispose?.()); hooks.mounted = []; } };
}
beforeEach(() => { hooks.values = []; hooks.refs = []; hooks.mounted = []; vi.clearAllMocks(); apiMock.refreshProject.mockReset(); apiMock.refreshProject.mockResolvedValue({ job: null, checkedAt: '', sources: [], gaps: [] });
  apiMock.projectRefreshStatus.mockResolvedValue({ outcome: 'unknown', attemptedAt: null, latestEvidenceCheckAt: null, sources: [] }); });
describe('passive page navigation refresh policy', () => {
  it('keeps unrelated tabs quiet until an explicit update fails, then offers a retry on the current page', async () => {
    expect(render(true, false, false).tree).toBeNull();
    apiMock.refreshProject.mockRejectedValueOnce(new Error('offline'));
    elements(render().tree).find(item => item.type === 'button')!.props.onClick();
    await Promise.resolve();
    const failed = render(true, false, false);
    const retry = elements(failed.tree).find(item => item.props.children === '重试更新');
    expect(retry?.props.disabled).toBe(false);
    expect(apiMock.refreshProject).toHaveBeenCalledTimes(1);
    retry!.props.onClick();
    await Promise.resolve();
    expect(apiMock.refreshProject).toHaveBeenCalledTimes(2);
    failed.cleanup();
  });
  it('shows the saved evidence date and a manual entry on the overview with no source read or job', async () => {
    apiMock.projectRefreshStatus.mockResolvedValue({ outcome: 'unknown', attemptedAt: null, latestEvidenceCheckAt: '2026-09-25T09:00:00Z', sources: [] });
    render(true, false, false, true); await Promise.resolve();
    const view = render(true, false, false, true);
    expect(elements(view.tree).some(item => typeof item.props.children === 'string' && item.props.children.includes('最近核对过对话') && item.props.children.includes('25'))).toBe(true);
    expect(elements(view.tree).some(item => item.type === 'button' && item.props.children === '检查更新')).toBe(true);
    expect(apiMock.projectRefreshStatus).toHaveBeenCalledTimes(1); expect(apiMock.refreshProject).not.toHaveBeenCalled(); expect(apiMock.syncJobs).not.toHaveBeenCalled();
    view.cleanup();
  });
  it('runs exactly one manual check after the explicit button', async () => {
    const first = render(); expect(apiMock.refreshProject).not.toHaveBeenCalled();
    elements(first.tree).find(element => element.type === 'button')!.props.onClick(); first.cleanup();
    const second = render(); await Promise.resolve();
    expect(apiMock.refreshProject).toHaveBeenCalledWith('project:synthetic', { automatic: false }); second.cleanup();
    render(false).cleanup(); render().cleanup();
    expect(apiMock.refreshProject).toHaveBeenCalledTimes(1);
  });
  it('only reads saved content on mount, archive inspection and reconnect', () => {
    render().cleanup(); render().cleanup();
    const offline = render(false); expect(elements(offline.tree).find(element => element.type === 'button')!.props.disabled).toBe(true); offline.cleanup();
    render().cleanup();
    const archived = render(true, true);
    expect(apiMock.refreshProject).not.toHaveBeenCalled();
    expect(elements(archived.tree).find(element => element.type === 'button')!.props.disabled).toBe(true);
    archived.cleanup();
  });
  it('reconnects to the same job and delivers its finished result without sending another source request', async () => {
    const running = { id: 'job-one', state: 'running', completed: 0, total: 1 };
    apiMock.refreshProject.mockResolvedValue({ job: running, checkedAt: '', sources: [], gaps: [] });
    apiMock.syncJobs.mockResolvedValueOnce({ jobs: [running] }).mockImplementationOnce(async () => {
      apiMock.projectRefreshStatus.mockResolvedValue({ outcome: 'updated', attemptedAt: '2026-10-01T08:00:00Z', readCount: 1, sources: [], updatedThreadKeys: ['picked'] });
      return { jobs: [{ ...running, state:'complete', completed:1, updatedThreadKeys:['picked'] }] };
    });
    elements(render().tree).find(item => item.type === 'button')!.props.onClick();
    await Promise.resolve(); await Promise.resolve();
    render(); await Promise.resolve();
    render(false); render(); await Promise.resolve(); await Promise.resolve();
    render(); await Promise.resolve(); const finished = render();
    expect(apiMock.refreshProject).toHaveBeenCalledTimes(1); expect(apiMock.syncJobs).toHaveBeenCalledTimes(2);
    expect(updated).toHaveBeenLastCalledWith(['picked']);
    expect(elements(finished.tree).find(item => item.type === 'button')!.props.disabled).toBe(false);
    expect(elements(finished.tree).some(item => typeof item.props.children === 'string' && item.props.children.includes('1 条有更新'))).toBe(true);
    finished.cleanup();
  });
});
