import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createDemoSnapshot } from '../../src/shared/demo.js';
import { ProjectDetail } from '../../src/web/ProjectDetail.js';
import type { ProjectBubbleContext } from '../../src/web/projectCanvas.js';

function context(): ProjectBubbleContext {
  const snapshot = createDemoSnapshot(16);
  const project = snapshot.projects[0];
  return {
    project, memberNodeIds: [], todos: [],
    brief: { ...snapshot.projectBriefs[0], workState: 'complete', confidence: 'high', lastObservedAt: snapshot.generatedAt, missingSince: null },
    threads: snapshot.threads.filter((thread) => thread.projectKey === project.projectKey).map((thread, index) => ({ ...thread, title: `原始对话标题 ${index}`, displayTitle: `独立中文总结 ${index}`, stopPoint: `各自停点 ${index}`, evidence: `证据 ${index}`, runtimeState: 'idle', workState: 'in_progress', humanAction: 'none', actionStrength: 'none', lastObservedAt: snapshot.generatedAt, missingSince: null }))
  };
}

describe('project detail evidence', () => {
  it('lists original names and reserves technical identifiers for the source disclosure', () => {
    const value = context();
    const html = renderToStaticMarkup(createElement(ProjectDetail, { context: value, focusedThreadKey: null }));
    for (const [index, thread] of value.threads.entries()) {
      expect(html).toContain(`原始对话标题 ${index}`);
      expect(html).toContain(`独立中文总结 ${index}`);
      expect(html).toContain(`各自停点 ${index}`);
      expect(html).toContain(`<code>${thread.threadId}</code>`);
      expect(html).not.toContain(`<h4>${thread.threadId}`);
    }
    expect(html).toContain('这条对话的来源');
  });
  it('does not present a stale completed brief as the project status when a decision remains', () => {
    const value = context();
    value.threads[0] = { ...value.threads[0], humanAction: 'decide', actionStrength: 'blocking', workState: 'waiting_for_user' };
    const html = renderToStaticMarkup(createElement(ProjectDetail, { context: value, focusedThreadKey: value.threads[0].threadKey }));
    expect(html).toContain('已记录动作：'); expect(html).toContain('决策');
    expect(html).not.toContain('<span>已完成</span>');
    expect(html).not.toContain('class="status-pills"'); expect(html).not.toContain('当前阶段');
  });
  it('keeps running and unknown-source conflicts visible instead of declaring completion', () => {
    for (const runtimeState of ['running', 'unknown'] as const) {
      const value = context();
      value.threads[0] = { ...value.threads[0], runtimeState, workState: 'insufficient_evidence' };
      const html = renderToStaticMarkup(createElement(ProjectDetail, { context: value, focusedThreadKey: null }));
      expect(html).toContain('记录时判断：证据不足'); expect(html).not.toContain('class="status-pills"');
      expect(html).not.toContain('<span>已完成</span>');
    }
  });
});
