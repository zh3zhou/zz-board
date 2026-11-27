import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProjectRefreshStatus, RefreshActivity, RefreshSources, refreshStatusText, savedCheckText } from '../../src/web/ProjectRefreshStatus.js';
import type { ProjectRefreshResult, SavedProjectCheck } from '../../src/shared/projectRefresh.js';
import type { SyncJob } from '../../src/shared/summarySync.js';
const result: ProjectRefreshResult = { projectKey: 'synthetic', checkedAt: '2026-09-21T00:00:00Z', scope: 'local-codex', readCount: 3, gaps: [], job: null };
const job: SyncJob = { id: 'job', state: 'queued', createdAt: result.checkedAt, updatedAt: result.checkedAt, completed: 0, total: 3, skipped: 0, error: null, usage: null, model: 'test', effort: 'medium', coverage: { projectsFound: 1, threadsFound: 3, deepRead: 3, fileChecked: 0, truncated: true, inaccessible: [] }, needsResubmit: false };
describe('project refresh presentation', () => {
  it('keeps a failed, partial or ongoing project check visible when another conversation has newer evidence', () => {
    const status: SavedProjectCheck = { projectKey: 'synthetic', attemptedAt: result.checkedAt, lastVerifiedAt: null, latestEvidenceCheckAt: '2026-10-09T06:30:00Z',
      outcome: 'failed', readCount: 1, sources: [], limitedExcerpts: false, updatedThreadKeys: [], jobId: null, failureCode: 'account_read_timeout' };
    expect(savedCheckText(status)).toContain('账号信息超时');
    expect(savedCheckText({ ...status, outcome: 'partial' })).toContain('部分近期内容未能核对');
    expect(savedCheckText({ ...status, outcome: 'checking' })).toContain('正在核对');
    for (const outcome of ['unknown', 'unchanged', 'updated'] as const) expect(savedCheckText({ ...status, outcome })).toContain('最近核对过对话');
  });
  it('shows new conversations and individual failures independently of summary success', () => {
    const sources = [{ threadKey: 'review', title: '合成长期复盘', discovered: true, state: 'unavailable' as const, reason: '有界正文未取得', sourceUpdatedAt: result.checkedAt }];
    const html = renderToStaticMarkup(createElement(RefreshSources, { sources, onFocusThread: () => {} }));
    expect(html).toContain('发现 1 条新对话'); expect(html).toContain('合成长期复盘');
    expect(html).toContain('本次正文不可用'); expect(html).not.toContain('open=""');
    expect(refreshStatusText({ ...result, sources }, { ...job, state: 'complete', completed: 1 })).toContain('本次未检查');
  });
  it('shows indeterminate activity with real phases, never an invented percentage', () => {
    for (const [value, label] of [[null, '正在查看最近对话'], [job, '等待整理'], [{ ...job, state: 'running' }, '正在整理近况']] as const) {
      const html = renderToStaticMarkup(createElement(RefreshActivity, { active: true, job: value as SyncJob | null }));
      expect(html).toContain(label); expect(html).toContain('role="progressbar"'); expect(html).not.toContain('aria-valuenow');
    }
    expect(renderToStaticMarkup(createElement(RefreshActivity, { active: false, job: null }))).toBe('');
  });
  it('does not report a successful refresh for empty evidence or unfinished jobs', () => {
    expect(refreshStatusText(result, null)).toContain('暂时无法');
    expect(refreshStatusText(result, job)).toContain('可以继续浏览');
    expect(refreshStatusText(result, { ...job, state: 'paused' })).toContain('暂未更新');
    expect(refreshStatusText(result, { ...job, state: 'complete', completed: 2, updatedThreadKeys:['a','b'], skipped: 1 })).toContain('更新 2 条');
    expect(refreshStatusText(result, { ...job, state: 'complete', completed: 2, updatedThreadKeys:[] })).toContain('摘要没有变化');
    expect(refreshStatusText(result,{...job,state:'paused',failures:[{threadKey:'a',code:'runtime_timeout'}]})).toContain('时间较长');
    expect(refreshStatusText(result,{...job,state:'paused',failures:[{threadKey:'a',code:'runtime_timeout'},{threadKey:'b',code:'quota_exhausted'}]})).toContain('额度暂时不可用');
  });
  it('labels local-only access, model usage and offline cache honestly', () => {
    const html = renderToStaticMarkup(createElement(ProjectRefreshStatus, { projectKey: 'synthetic', online: false, onBoardChange: async () => {} }));
    expect(html).toContain('离线中，显示上次保存'); expect(html).toContain('远程与 ChatGPT'); expect(html).toContain('可能使用 Codex 登录额度'); expect(html).toContain('disabled');
    expect(html).not.toContain('<details open'); expect(html).not.toContain('不只是重载看板');
  });
});
