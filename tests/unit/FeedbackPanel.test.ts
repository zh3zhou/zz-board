import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FeedbackPanel, FeedbackPreview, FeedbackRetentionNotice, PublicIssuePreview, receiptLabel, submissionNotice } from '../../src/web/FeedbackPanel.js';
import { publicFeedbackText } from '../../src/web/feedbackClient.js';
import type { LocalFeedbackReceipt } from '../../src/web/feedbackStore.js';

describe('feedback presentation', () => {
  it('describes user publication on GitHub and makes no send claim on initial render', () => {
    const html = renderToStaticMarkup(createElement(FeedbackPanel, { onClose() {} }));
    expect(html).toContain('在本机预览、复制或保存'); expect(html).toContain('在 GitHub 确认发布');
    expect(html).not.toContain('反馈已送达'); expect(html).not.toContain('type="file"');
  });
  it.each([['problem', 'bug.yml'], ['idea', 'feature.yml']] as const)('opens the %s form without forwarding the draft or private fields', (kind, template) => {
    const fields = { kind, goal: '合成 <goal>', actual: '合成表现', expected: '合成预期', dataImpact: 'none' as const,
      contact: 'PRIVATE_CONTACT', diagnostics: 'PRIVATE_DIAGNOSTICS', deleteToken: 'PRIVATE_TOKEN', reportId: 'PRIVATE_ID' };
    const text = publicFeedbackText(fields);
    expect(text).toContain('合成 <goal>'); expect(text).not.toContain('PRIVATE_');
    expect(text.includes('数据影响')).toBe(kind === 'problem');
    const html = renderToStaticMarkup(createElement(PublicIssuePreview, { fields, onCopy() {}, onDownload() {}, onEdit() {} }));
    expect(html).toContain('合成 &lt;goal&gt;'); expect(html).not.toContain('PRIVATE_');
    expect(html.match(/href="([^"]+)"/g)).toEqual([`href="https://github.com/zh3zhou/zz-board/issues/new?template=${template}"`]);
    for (const label of ['复制公开报告', '保存为文本', '复制表单地址', '返回编辑']) expect(html).toContain(label);
  });
  it('renders user content as inert text in a selectable preview', () => {
    const html = renderToStaticMarkup(createElement(FeedbackPreview, { text: '<script>unsafe()</script>' }));
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).toContain('反馈报告预览');
  });
  it('distinguishes local pending, unknown submission, and unknown deletion from acknowledged states', () => {
    const base = { schemaVersion: 1, reportId: crypto.randomUUID(), deleteToken: 'x'.repeat(43), createdAt: new Date().toISOString() } as const;
    expect(receiptLabel({ ...base, state: 'prepared' })).toContain('尚无送达回执');
    expect(receiptLabel({ ...base, state: 'uncertain' })).toContain('未确认');
    expect(receiptLabel({ ...base, state: 'received' })).toContain('尚不代表已处理');
    expect(receiptLabel({ ...base, state: 'deleting' } as LocalFeedbackReceipt)).toContain('已停止提交重试');
  });
  it('bounds retention to the main table and does not equate a delete receipt with platform erasure', () => {
    const html = renderToStaticMarkup(createElement(FeedbackRetentionNotice));
    expect(html).toContain('反馈服务中的报告在接收 90 天后到期');
    expect(html).toContain('定时清理可能滞后最多 24 小时');
    expect(html).toContain('平台日志和备份另有保留期限');
    expect(html).toContain('清除时间尚未核实');
    expect(html).toContain('删除回执只确认这份报告已删除');
    expect(html).toContain('用本机凭证提前请求删除报告');
    expect(html).not.toContain('服务最多保留 90 天');
  });
  it('does not present a late acknowledgement as successful delivery while deletion wins', () => {
    const pending = submissionNotice({ state: 'deleting' });
    expect(pending).toContain('送达回执晚于删除请求'); expect(pending).toContain('删除结果仍待确认'); expect(pending).not.toContain('反馈已送达');
    const deleted = submissionNotice({ state: 'deleted' });
    expect(deleted).toContain('本机已收到删除回执'); expect(deleted).not.toContain('反馈已送达'); expect(deleted).not.toContain('删除结果仍待确认');
  });
});
