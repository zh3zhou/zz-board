import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createDemoSnapshot } from '../../src/shared/demo.js';
import type { BoardThread } from '../../src/shared/schema.js';
import type { ConversationNoteSource } from '../../src/shared/conversationNote.js';
import { NoteOriginLink } from '../../src/web/NoteOriginLink.js';

const demo = createDemoSnapshot(1);
const project = { ...demo.projects[0]!, hostId: 'local' };
const source: ConversationNoteSource = { projectKey: project.projectKey, sourceKind: 'codex', hostId: 'local',
  threadId: '00000000-0000-4000-8000-00000000000a', threadKey: null };
const thread: BoardThread = { ...demo.threads[0]!, ...source, threadId: source.threadId.toUpperCase(), title: '起草决定', threadKey: 'saved:one', missingSince: null, lastObservedAt: demo.generatedAt };
function props(threads: BoardThread[], origin: ConversationNoteSource | null = source) {
  return { note: { noteSource: origin }, board: { projects: [project], threads }, onLocate: vi.fn() };
}
describe('a captured note returns to its exact conversation', () => {
  it('opens the only saved match in the board, including a newly synced current chat', () => {
    const input = props([{ ...thread, threadKey: 'unrelated', threadId: 'unrelated' }, thread]);
    const button = NoteOriginLink(input)!;
    expect(button.type).toBe('button'); button.props.onClick();
    expect(input.onLocate).toHaveBeenCalledWith(thread.threadKey);
    expect(renderToStaticMarkup(button)).not.toContain('codex://');
  });
  it('offers a local original before indexing and resolves neither an ambiguous nor a conflicting origin', () => {
    const view = (input: ReturnType<typeof props>) => renderToStaticMarkup(createElement(NoteOriginLink, input));
    expect(view(props([]))).toContain('codex://threads/' + source.threadId);
    expect(view(props([thread, { ...thread, threadKey: 'second' }]))).toContain('复制对话定位');
    expect(view(props([{ ...thread, projectKey: 'another' }]))).not.toContain('codex://');
    expect(view(props([], { ...source, hostId: 'remote', sourceKind: 'remote' }))).toContain('复制对话定位');
    expect(view(props([], null))).toBe('');
  });
});
