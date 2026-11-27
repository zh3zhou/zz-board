import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationColumn, ConversationHistory as History, ConversationTurn } from '../../src/shared/conversationHistory.js';
import type { SyncJob } from '../../src/shared/summarySync.js';

const hooks = vi.hoisted(() => ({
  phase: 'launcher' as 'launcher' | 'window', open: false, index: 0, initial: null as History | null,
  pageRef: null as { current: History | null } | null, pending: false,
  setters: [] as Array<ReturnType<typeof vi.fn>>, effects: [] as Array<() => unknown>,
}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = hooks.index++;
    const value = hooks.phase === 'launcher' ? hooks.open : typeof initial === 'function' ? initial() : initial;
    const setter = vi.fn((next: unknown) => { if (hooks.phase === 'window' && index === 3) hooks.pending = Boolean(next); });
    if (hooks.phase === 'window') hooks.setters[index] = setter;
    return [value, setter];
  },
  useRef: (initial: unknown) => {
    const ref = { current: initial };
    if (hooks.phase === 'window' && initial === hooks.initial) hooks.pageRef = ref as { current: History | null };
    return ref;
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => unknown) => { hooks.effects.push(effect); }, useLayoutEffect: () => {},
}));
vi.mock('react-dom', async original => ({ ...await original<typeof import('react-dom')>(), createPortal: (node: unknown) => node }));
vi.mock('../../src/web/api.js', () => ({ api: {
  conversationTurns: vi.fn(), earlierConversations: vi.fn(), conversations: vi.fn(),
  refreshConversations: vi.fn(), syncJobs: vi.fn(),
} }));
import { ConversationHistory, ConversationLane } from '../../src/web/ConversationHistory.js';
import { api } from '../../src/web/api.js';

const turn = (): ConversationTurn => ({
  turnId: 'synthetic-turn-20', ordinal: 20, previousTurnId: null, continuesPrevious: false,
  title: '合成讨论', summary: '合成记录，未调用真实服务。', occurredAt: null, sourceRefs: ['synthetic:user'],
  reference: null, revision: 1, unread: false, sequence: 20, sourceFingerprint: 'synthetic-fingerprint',
});
const column = (patch: Partial<ConversationColumn> = {}): ConversationColumn => ({
  threadKey: 'synthetic:thread', title: '合成对话', sourceUpdatedAt: null, turns: [turn()],
  hasEarlier: true, hasStoredEarlier: false, nextCursor: 'original-cursor', coverage: [], checkedAt: null, orderingRevision: 4, ...patch,
});
const empty = (value: ConversationColumn): ConversationColumn => ({ ...value, turns: [] });
const runningJob = { id: 'synthetic-job', state: 'running' } as SyncJob;

function elements(node: unknown): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('type' in node) || !('props' in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props.children)];
}
function harness(initial = column()) {
  hooks.initial = { projectKey: 'synthetic-project', enabled: true, order: 'sidebar', threads: [initial], gaps: [] };
  hooks.phase = 'launcher'; hooks.open = true; hooks.index = 0;
  const launcher = ConversationHistory({ projectKey: 'synthetic-project', projectName: '合成项目', online: true, revision: 1 });
  const windowElement = elements(launcher).find(element => typeof element.type === 'function' && 'anchor' in element.props);
  if (!windowElement) throw new Error('Expected the real ConversationWindow element.');
  hooks.phase = 'window'; hooks.index = 0; hooks.effects = [];
  // Exercise paging with a previously opened window's cached, synthetic first page.
  const windowTree = (windowElement.type as (props: Record<string, unknown>) => unknown)({ ...windowElement.props, initial: hooks.initial });
  const lane = elements(windowTree).find(element => element.type === ConversationLane);
  if (!lane || typeof lane.props.onEarlier !== 'function' || !hooks.pageRef) throw new Error('Expected the real earlier callback and page ref.');
  return {
    earlier: lane.props.onEarlier as () => void,
    update(patch: Partial<ConversationColumn>) {
      const current = hooks.pageRef!.current!;
      hooks.pageRef!.current = { ...current, threads: current.threads.map(value => ({ ...value, ...patch })) };
    },
    current: () => hooks.pageRef!.current!.threads[0]!,
  };
}
async function settled() {
  // The lane intentionally returns void. Drain its bounded promise chain and
  // prove that the real callback reaches finally rather than awaiting a model.
  for (let i = 0; i < 20 && hooks.pending; i++) await Promise.resolve();
  expect(hooks.pending).toBe(false);
}
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; }

beforeEach(() => {
  vi.clearAllMocks(); hooks.phase = 'launcher'; hooks.open = false; hooks.index = 0; hooks.initial = null; hooks.pageRef = null; hooks.pending = false; hooks.setters = []; hooks.effects = [];
  vi.stubGlobal('window', { innerWidth: 1600, innerHeight: 1000, addEventListener: vi.fn(), removeEventListener: vi.fn() }); vi.stubGlobal('document', { body: {} });
  vi.mocked(api.conversationTurns).mockReset(); vi.mocked(api.earlierConversations).mockReset();
  vi.mocked(api.earlierConversations).mockResolvedValue({ projectKey: 'synthetic-project', job: runningJob, gaps: [] });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('real conversation window earlier callback flow', () => {
  it('leaves the history window and database idle when browsing a project overview', () => {
    const launcher = ConversationHistory({ projectKey: 'synthetic-project', projectName: '合成项目', online: true, revision: 1 });
    expect(elements(launcher).some(element => 'anchor' in element.props)).toBe(false);
    hooks.effects.forEach(effect => effect());
    expect(api.conversations).not.toHaveBeenCalled();
    expect(api.refreshConversations).not.toHaveBeenCalled();
  });
  it('opening the window loads saved history without starting a source read or model job', async () => {
    harness(); vi.mocked(api.conversations).mockResolvedValue(hooks.initial!);
    const disposers = hooks.effects.map(effect => effect());
    await Promise.resolve();
    expect(api.conversations).toHaveBeenCalledExactlyOnceWith('synthetic-project');
    expect(api.refreshConversations).not.toHaveBeenCalled();
    expect(api.earlierConversations).not.toHaveBeenCalled();
    for (const dispose of disposers) if (typeof dispose === 'function') dispose();
  });
  it('a button advertised as stored-only cannot start a source read if its local page disappears', async () => {
    const h = harness(column({ hasStoredEarlier: true }));
    vi.mocked(api.conversationTurns).mockResolvedValue(empty(h.current())); vi.mocked(api.conversations).mockResolvedValue(hooks.initial!);
    h.earlier(); await settled();
    expect(api.earlierConversations).not.toHaveBeenCalled();
    expect(api.conversations).toHaveBeenCalledOnce();
  });
  it('does not start model work when both cached-page reads remain stale', async () => {
    const h = harness(); vi.mocked(api.conversationTurns).mockResolvedValue(empty(column({ orderingRevision: 3 })));
    h.earlier(); await settled();
    expect(api.conversationTurns).toHaveBeenCalledTimes(2);
    expect(api.conversationTurns).toHaveBeenNthCalledWith(1, 'synthetic-project', 'synthetic:thread', { beforeTurnId: 'synthetic-turn-20' });
    expect(api.earlierConversations).not.toHaveBeenCalled();
    expect(hooks.setters[1]).toHaveBeenCalledWith(expect.stringContaining('顺序刚刚更新'));
  });
  it('starts model work only for a valid empty cache page and uses the latest current cursor', async () => {
    const h = harness(); h.update({ nextCursor: 'current-cursor' });
    vi.mocked(api.conversationTurns).mockResolvedValue(empty(h.current()));
    h.earlier(); await settled();
    expect(api.conversationTurns).toHaveBeenCalledOnce();
    expect(api.earlierConversations).toHaveBeenCalledExactlyOnceWith('synthetic-project', 'synthetic:thread', 'current-cursor');
    expect(api.conversations).not.toHaveBeenCalled();
  });
  it('does not start model work after ordering changes while the cache request is awaiting', async () => {
    const first = deferred<ConversationColumn>(); const initial = column(); const h = harness(initial);
    vi.mocked(api.conversationTurns).mockReturnValueOnce(first.promise);
    h.earlier(); expect(hooks.pending).toBe(true);
    h.update({ orderingRevision: 5 }); vi.mocked(api.conversationTurns).mockResolvedValueOnce(empty(h.current()));
    first.resolve(empty(initial)); await settled();
    expect(api.conversationTurns).toHaveBeenCalledTimes(2);
    expect(api.earlierConversations).not.toHaveBeenCalled();
  });
  it('does not start model work after hasEarlier becomes false while the cache request is awaiting', async () => {
    const first = deferred<ConversationColumn>(); const initial = column(); const h = harness(initial);
    vi.mocked(api.conversationTurns).mockReturnValueOnce(first.promise);
    h.earlier(); expect(hooks.pending).toBe(true);
    h.update({ hasEarlier: false }); vi.mocked(api.conversationTurns).mockResolvedValueOnce(empty(h.current()));
    first.resolve(empty(initial)); await settled();
    expect(api.earlierConversations).not.toHaveBeenCalled();
  });
  it('does not start model work after the source cursor changes while the cache request is awaiting', async () => {
    const first = deferred<ConversationColumn>(); const initial = column(); const h = harness(initial);
    vi.mocked(api.conversationTurns).mockReturnValueOnce(first.promise);
    h.earlier(); h.update({ nextCursor: 'new-source-cursor' });
    vi.mocked(api.conversationTurns).mockResolvedValueOnce(empty(h.current()));
    first.resolve(empty(initial)); await settled();
    expect(api.conversationTurns).toHaveBeenCalledTimes(2);
    expect(api.earlierConversations).not.toHaveBeenCalled();
  });
});
