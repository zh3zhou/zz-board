import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createDemoSnapshot } from '../../src/shared/demo.js';
import type { BoardThread } from '../../src/shared/schema.js';
import { ProjectDetail } from '../../src/web/ProjectDetail.js';
import { localCodexThreadUrl, SourceThreadTitles, ThreadTitle } from '../../src/web/ThreadSourceLink.js';

const demo = createDemoSnapshot(16);
const project = { ...demo.projects[0]!, hostId: 'local' };
const id = '00000000-0000-4000-8000-000000000001';
const thread: BoardThread = { ...demo.threads[0]!, title: '验收', threadKey: 'saved:first', threadId: id,
  sourceKind: 'codex', hostId: 'local', projectKey: project.projectKey, missingSince: null, lastObservedAt: demo.generatedAt };
const second = { ...thread, threadKey: 'saved:second', threadId: '00000000-0000-4000-8000-000000000002' };
const html = renderToStaticMarkup;

describe('locate a saved conversation before opening its native source', () => {
  it('selects the requested full board key even for identical titles; the first step contains no external link', () => {
    const locate = vi.fn();
    const names = html(createElement(SourceThreadTitles, { threads: [thread, second], onLocate: locate }));
    expect(names).toContain('验收（同名对话 1）'); expect(names).toContain('验收（同名对话 2）');
    expect(names).not.toMatch(/local|0000000[12]|saved:/);
    expect(names).not.toContain('href='); expect(locate).not.toHaveBeenCalled();
    ThreadTitle({ thread: second, onLocate: locate }).props.onClick();
    expect(locate).toHaveBeenCalledExactlyOnceWith('saved:second');
  });
  it('keeps the overview in the board and highlights the exact detail, with a link built from its native ID', () => {
    const context = { project, threads: [thread, second], todos: [], memberNodeIds: [] };
    const overview = html(createElement(ProjectDetail, { context, focusedThreadKey: null, view: 'overview', onFocusThread: vi.fn() }));
    expect(overview).not.toContain('codex://');
    const details = html(createElement(ProjectDetail, { context, focusedThreadKey: second.threadKey, view: 'threads' }));
    const focused = details.split('<article').find(card => card.includes('thread-summary is-focused'));
    expect(focused).toContain(`href="codex://threads/${second.threadId}"`);
    expect(focused).not.toContain(`codex://threads/${id}`);
  });
  it('uses only confirmed local conversation identity, including canonical local keys in old records', () => {
    expect(localCodexThreadUrl({ ...thread, hostId: undefined }, project)).toBeNull();
    expect(localCodexThreadUrl({ ...thread, hostId: undefined, threadKey: `codex:local:${id}` })).toBe(`codex://threads/${id}`);
    expect(localCodexThreadUrl({ ...thread, hostId: undefined })).toBeNull();
    expect(localCodexThreadUrl({ ...thread, hostId: 'other' }, project)).toBeNull();
    expect(localCodexThreadUrl(thread, { ...project, hostId: 'other' })).toBeNull();
    expect(localCodexThreadUrl(thread, { ...project, projectKey: 'another-project' })).toBeNull();
    for (const sourceKind of ['chatgpt','snapshot','remote','unknown','demo'] as const)
      expect(localCodexThreadUrl({ ...thread, sourceKind }, project)).toBeNull();
    for (const threadId of ['new', 'missing', id + '/new', id + '?hostId=remote', id + '#fragment', id + '\n', 'codex://threads/new'])
      expect(localCodexThreadUrl({ ...thread, threadId }, project)).toBeNull();
    const remote = html(createElement(ProjectDetail, { context: { project, threads: [{ ...second, hostId:'other' }], todos:[], memberNodeIds:[] },
      view:'threads', focusedThreadKey:second.threadKey }));
    expect(remote).toContain('复制对话定位'); expect(remote).not.toContain('codex://');
  });
});
