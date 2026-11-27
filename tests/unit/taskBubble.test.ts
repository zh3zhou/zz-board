import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import type { CanvasNodeRecord } from '../../src/shared/schema.js';
import { noteDisplayText, taskDisplayTitle } from '../../src/web/bubblePresentation.js';
import { BubbleHoverPreview, hoverPreviewContent } from '../../src/web/BubbleHoverPreview.js';
import type { ProjectBubbleContext } from '../../src/web/projectCanvas.js';
import { resizeKeepsAspect, resolvedAspectLock, TaskBubble, type BubbleData } from '../../src/web/TaskBubble.js';

describe('bubble presentation', () => {
  it('keeps screenshot and recoverable archive on the same independent note before and after selection', () => {
    const record: CanvasNodeRecord = { id: 'note:alone', kind: 'note', threadKey: null, title: '', body: '独立便签',
      x: 0, y: 0, width: 150, height: 100, zIndex: 0, revision: 1, createdAt: '', updatedAt: '', lastViewedAt: null };
    const data = { record, selected: false, canResize: false, annotationCount: 0, online: true, onArchiveNote() {}, onResizeEnd() {} };
    const render = (options: Partial<BubbleData>) => renderToStaticMarkup(createElement(ReactFlowProvider, null,
      createElement(TaskBubble, { id: record.id, data: { ...data, ...options } })));
    for (const singleSelection of [false, true]) {
      const html = render({ selected: singleSelection, singleSelection });
      expect(html).toContain('aria-label="保存并复制便签图片"');
      expect(html).toMatch(/<button[^>]*aria-label="归档便签"(?![^>]*disabled)[^>]*>/);
      expect(html).not.toContain('aria-label="收进上游"');
      expect(html.includes('aria-label="便签详情"')).toBe(singleSelection);
      expect(render({ singleSelection, onFold() {} })).toContain('aria-label="收进上游"');
    }
    for (const options of [{ online: false }, { unsavedDraft: true }]) {
      expect(render(options)).toMatch(/<button[^>]*aria-label="归档便签"[^>]*disabled/);
    }
    expect(render({ singleSelection: true, readOnly: true })).not.toContain('aria-label="归档便签"');
    expect(render({ exportMode: true })).not.toContain('aria-label="保存并复制便签图片"');
  });
  it('shows only the note body when a real body exists', () => {
    expect(noteDisplayText({ title: '旧标题', body: '这是用户写下的内容。' })).toBe('这是用户写下的内容。');
  });

  it('shows raw blank or placeholder-looking user input after one-time database migration', () => {
    expect(noteDisplayText({ title: '别忘了校对', body: '写下一句话…' })).toBe('写下一句话…');
    expect(noteDisplayText({ title: '只存在标题', body: '' })).toBe('');
  });

  it('falls back to the persisted task title when no semantic display title is available', () => {
    expect(taskDisplayTitle(undefined, { title: 'Original task title' })).toBe('Original task title');
  });

  it('displays the saved project name, never an arbitrary member or stale node title', () => {
    expect(taskDisplayTitle(undefined, { title: '旧的单条对话标题' }, { name: '当前项目名称' })).toBe('当前项目名称');
    expect(taskDisplayTitle(undefined, { title: '旧的单条对话标题' }, { name: ' ' })).toBe('未命名项目');
  });

  it('keeps the project title on the bubble surface without a runtime or action marker', () => {
    const record: CanvasNodeRecord = {
      id: 'project:sample', kind: 'task', projectKey: 'sample', threadKey: null, archivedAt: null,
      x: 0, y: 0, width: 180, height: 180, zIndex: 1, title: '不应出现的旧标题', body: '不应出现的来源正文',
      lastViewedAt: null, revision: 0, createdAt: '2026-08-31T12:00:00.000Z', updatedAt: '2026-08-31T12:00:00.000Z'
    };
    const project: ProjectBubbleContext = {
      project: { projectKey: 'sample', name: '中文项目名称', observedAt: record.createdAt },
      threads: [], todos: [], memberNodeIds: [record.id]
    };
    const props: NodeProps = {
      id: record.id, type: 'bubble', data: { record, project, foldedCount: 3, onFoldAll() {}, foldedNotes: [{ ...record, id: 'note:folded', kind: 'note', body: '收纳正文不放画布' }], annotationCount: 12, selected: false, canResize: false, onResizeEnd: () => undefined },
      dragging: false, zIndex: 1, selected: false, draggable: false, selectable: true, deletable: false,
      isConnectable: false, positionAbsoluteX: 0, positionAbsoluteY: 0
    };
    const html = renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(TaskBubble, props)));
    expect(html).toContain('<span class="bubble-title">中文项目名称</span>');
    expect(hoverPreviewContent(props.data as BubbleData)).toMatchObject({ title: '中文项目名称', action: '' });
    expect(html).not.toContain('status-dot');
    expect(html).toContain('data-priority="unset"');
    expect(html.match(/bubble-handle/g)).toHaveLength(2);
    expect(html).not.toContain('不应出现');
    expect(html).not.toContain('12 条');
    expect(html).not.toContain('收纳 3');
    expect(html).toContain('>展开全部</button>');
    expect(html).not.toContain('收纳正文不放画布');
    record.manualPriority = 'p1';
    const prioritized = renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(TaskBubble, props)));
    expect(prioritized).toContain('class="bubble-priority-badge"');
    expect(prioritized).toContain('优先级 优先');
    props.data.exportMode = true;
    const exported = renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(TaskBubble, props)));
    expect(exported).not.toContain('bubble-priority-badge');
    props.data.exportMode = false;
    project.threads.push({
      threadKey: 'old', threadId: 'old-source', projectKey: 'sample', title: '旧对话', displayTitle: '旧对话', sourceKind: 'snapshot',
      runtimeState: 'running', workState: 'needs_validation', humanAction: 'test', actionStrength: 'blocking',
      stopPoint: '已交付阶段结果', evidence: '合成证据', confidence: 'medium',
      observedAt: record.createdAt, lastObservedAt: record.createdAt, missingSince: null
    });
    const withOldThread = renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(TaskBubble, props)));
    expect(withOldThread).toContain('1 条对话 · 查看近况');
    expect(withOldThread).not.toMatch(/status-dot|is-running|needs-human|待验证/);
  });

  it('renders one metadata line by default and keeps native titles only on bubble controls', () => {
    const time = '2026-08-31T12:00:00.000Z';
    const record: CanvasNodeRecord = { id: 'note:hover', kind: 'note', threadKey: null, x: 1, y: 2, width: 150, height: 150,
      zIndex: 1, title: '', body: '这段正文不要在悬浮预览重复', lastViewedAt: null, revision: 3, createdAt: time, updatedAt: '2030-02-01T00:00:00.000Z' };
    const data = { record, selected: false, canResize: false, annotationCount: 0, onResizeEnd: () => undefined };
    const render = () => renderToStaticMarkup(createElement(BubbleHoverPreview, { data, x: 0, y: 0 }));
    const plain = render();
    expect(plain.match(/<p>/g)).toHaveLength(1);
    expect(plain).toContain('创建于'); expect(plain).toContain(`dateTime="${time}"`);
    expect(plain).not.toMatch(/上次编辑|便签|未设置|2030|正文|<small/);
    const bubble = renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(TaskBubble, {id: record.id, data})));
    expect(bubble.split('>')[0]).not.toContain('title=');
    expect(bubble).toContain('aria-label="便签：'); expect(bubble).toContain('title="复制原文"');
    record.contentEditedAt = '2026-09-02T09:00:00.000Z'; record.manualPriority = 'p3';
    record.noteSchedule = { dueDate: '2027-01-20', autoPromote: false, attentionDays: 7, priorityDays: 1, completed: true };
    expect(render()).toContain('上次编辑'); expect(render()).toContain('关注 · 已完成的期限 2027-01-20'); expect(render()).not.toContain(record.body);
  });

  it('summarizes project evidence in the hover preview without exposing it on the bubble face', () => {
    const record: CanvasNodeRecord = {
      id: 'project:hover', kind: 'task', projectKey: 'hover', threadKey: null, archivedAt: null,
      x: 0, y: 0, width: 180, height: 180, zIndex: 1, title: '旧标题', body: '', lastViewedAt: null,
      revision: 0, createdAt: '2026-08-31T12:00:00.000Z', updatedAt: '2026-08-31T12:00:00.000Z'
    };
    const project: ProjectBubbleContext = {
      project: { projectKey: 'hover', name: '悬停项目', observedAt: record.createdAt },
      threads: [{
        threadKey: 'decision', projectKey: 'hover', threadId: 'thread-id', title: '原对话', displayTitle: '讨论方案', sourceKind: 'snapshot',
        runtimeState: 'idle', workState: 'waiting_for_user', humanAction: 'decide', actionStrength: 'blocking', stopPoint: '停在两个方案的取舍。',
        evidence: '用户需要做决定', confidence: 'high', observedAt: record.createdAt, lastObservedAt: record.createdAt, missingSince: null
      }],
      todos: [], memberNodeIds: [record.id]
    };
    expect(hoverPreviewContent({ record, project, annotationCount: 0, selected: false, canResize: true, onResizeEnd: () => undefined })).toMatchObject({
      title: '悬停项目', summary: '停在两个方案的取舍。', source: expect.stringContaining('原对话'), action: '决策'
    });
  });

  it('exposes the persisted/default shape lock beside the selected resize handle', () => {
    const record: CanvasNodeRecord = {
      id: 'project:lock', kind: 'task', projectKey: 'lock', threadKey: null, archivedAt: null, aspectLocked: null,
      x: 0, y: 0, width: 180, height: 180, zIndex: 1, title: '锁形项目', body: '', lastViewedAt: null,
      revision: 0, createdAt: '2026-08-31T12:00:00.000Z', updatedAt: '2026-08-31T12:00:00.000Z'
    };
    const props: NodeProps = {
      id: record.id, type: 'bubble', data: { record, annotationCount: 0, selected: true, canResize: true, aspectLockedDefault: true, shape: 'circle', onResizeEnd: () => undefined, onAspectLockChange: () => undefined },
      dragging: false, zIndex: 1, selected: true, draggable: true, selectable: true, deletable: false,
      isConnectable: false, positionAbsoluteX: 0, positionAbsoluteY: 0
    };
    const html = renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(TaskBubble, props)));
    expect(html).toContain('data-shape="circle"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('解除比例锁');
  });

  it('lets persisted choice override Skin defaults and Alt unlock only the active resize gesture', () => {
    expect(resolvedAspectLock({ kind: 'task', aspectLocked: null }, true)).toBe(true);
    expect(resolvedAspectLock({ kind: 'task', aspectLocked: false }, true)).toBe(false);
    expect(resolvedAspectLock({ kind: 'note', aspectLocked: true }, false)).toBe(true);
    expect(resizeKeepsAspect({ kind: 'task', aspectLocked: true }, true, false)).toBe(true);
    expect(resizeKeepsAspect({ kind: 'task', aspectLocked: true }, true, true)).toBe(false);
    expect(resolvedAspectLock({ kind: 'task', aspectLocked: true }, true)).toBe(true);
  });
});
