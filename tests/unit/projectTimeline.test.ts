import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MilestoneCard, timelineGroups, mergeMilestones, mergeTimelinePages } from '../../src/web/ProjectTimeline.js';
import type { ProjectMilestone } from '../../src/shared/milestones.js';
function event(stage: 'source' | 'built' | 'running', product: string | null = '合成产品'): ProjectMilestone {
  return { key: `${product}-${stage}`, projectKey: 'p', sourceKey: 't', sourceKind: 'thread', threadKey: 't', sourceLabel: '讨论记录', checkedAt: '2026-09-10', summarizedAt: '2026-09-10', sourceUpdatedAt: '2026-09-10', revision: 1, changeSequence: 1, unread: true, sources: [],
    value: { id: stage, kind: 'version', title: '交付', occurredAt: null, problem: '保存失败', options: ['方案 A'], decision: '采用方案 A', result: '已完成源码修复', resolution: 'delivered', sourceRefs: ['a'], version: { number: '1', product, stage } } };
}
describe('project timeline presentation', () => {
  it('replaces revised older records when paging without duplicating them', () => {
    const old = event('built'); const revised = { ...old, revision: 2, value: { ...old.value, result: '包核验结果已更正' } };
    expect(mergeMilestones([event('source'), old], [revised, event('running')])).toEqual([event('source'), revised, event('running')]);
  });
  it('does not acknowledge an unseen revision arriving between page requests', () => {
    const first = { items: [event('source')], total: 2, unread: 2, nextOffset: 1, throughSequence: 10 };
    const next = { ...first, items: [event('built')], nextOffset: null, throughSequence: 11 };
    expect(mergeTimelinePages(first, next)).toMatchObject({ throughSequence: 10, items: [event('source'), event('built')], nextOffset: null });
  });
  it('groups known product versions, not unrelated products or ambiguous identities', () => {
    expect(timelineGroups([event('source'), event('built'), event('running')])).toHaveLength(1);
    expect(timelineGroups([event('source'), event('built', '另一个产品')])).toHaveLength(2);
    expect(timelineGroups([event('source', null), { ...event('built', null), sourceKey: 'other' }])).toHaveLength(2);
  });
  it('shows problem, decision, result, unknown dates and safe text without engineering-first identifiers', () => {
    const markup = renderToStaticMarkup(createElement(MilestoneCard, { items: [event('source'), event('built')] }));
    for (const text of ['问题', '决定', '结果', '时间未明确', '新进展', '讨论过的方案', '源码实现', '包已构建']) expect(markup).toContain(text);
    expect(markup).not.toContain('运行核验');
  });
  it('folds repeated evidence under one stage heading instead of repeating the version-stage list', () => {
    const markup = renderToStaticMarkup(createElement(MilestoneCard, { items: [event('source'), { ...event('source'), key: 'other-source', sourceKey: 'other' }, event('built')] }));
    expect(markup.match(/<h5>源码实现/g)).toHaveLength(1);
    expect(markup).toContain('其他 1 条相关记录');
  });
  it('labels observed partial progress without presenting it as a finished result', () => {
    const item = event('source');
    item.value = { ...item.value, kind: 'discussion', version: null, decision: null, result: '已完成一部分，其余仍在处理。', resolution: 'open' };
    const markup = renderToStaticMarkup(createElement(MilestoneCard, { items: [item] }));
    expect(markup).toContain('<b>当前进展</b>');
    expect(markup).not.toContain('<b>结果</b>');
    expect(markup).toContain('尚未决定');
  });
});
