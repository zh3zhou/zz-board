import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OnboardingPanel, CodexUsageGuide } from '../../src/web/OnboardingPanel.js';
import { SummarySyncPanel, SyncJobCard } from '../../src/web/SummarySyncPanel.js';
import { AutoCheckPanel } from '../../src/web/AutoCheckPanel.js';
import { api } from '../../src/web/api.js';
import { agentGuidePrompt, skinGuidePrompt, skillGuidePrompt, sourceGuidePrompt } from '../../src/web/onboarding.js';
import type { CodexAccess } from '../../src/shared/codexAccess.js';
import type { SyncJob } from '../../src/shared/summarySync.js';

const access: CodexAccess = { schemaVersion: 1, localRead: false, modelUse: false, decidedAt: null };
const callbacks = { onClose() {}, onCreateNote() {}, onTryInk() {}, onFitView() {}, onOpenSettings() {}, onOpenSkins() {}, onOpenFeedback() {}, onOpenProjects() {}, async onStartBlankPage() { return true; } };
afterEach(() => vi.unstubAllGlobals());

describe('beginner guide and deliberate Codex preparation', () => {
  it('offers Codex and a local blank canvas before tools and preserves unconfirmed access', () => {
    const html = renderToStaticMarkup(createElement(OnboardingPanel, { ...callbacks, online: true, access }));
    expect(html).toContain('查看我的 Codex 项目'); expect(html).toContain('从空白页开始'); expect(html).not.toContain('创建练习便签');
    expect(html).toContain('原有偏好保留'); expect(html).toContain('确认前相关自动操作暂停');
    expect(html).toContain('不会读取 Codex 历史、调用模型或自动带你走流程');
    expect(html).toContain('aria-modal="true"'); expect(html).toContain('维护源码');
  });
  it('keeps preparation disabled before reading consent and explains metadata indexing separately from generation', () => {
    const html = renderToStaticMarkup(createElement(OnboardingPanel, { ...callbacks, initialTab: 'codex', online: true, access }));
    expect(html).toContain('允许读取本机'); expect(html).toContain('允许将选定证据');
    expect(html).toContain('扫描本机会话元数据'); expect(html).toContain('不会发送正文做模型生成');
    expect(html).toContain('每日检查从下一周期继续'); expect(html).toContain('查看每日检查');
    expect(html).toContain('首次总结前还会单独探测'); expect(html).not.toContain('安全运行时：');
    expect(html).toMatch(/<button disabled="">准备并检查 Codex<\/button>/);
    expect(html).not.toContain('checked=""');
    expect(html).toContain('项目 → 项目更新');
    expect(html).toContain('打开项目更新');
    expect(html).not.toContain('设置 → 同步');
  });
  it('teaches the actual note gestures and the import, preview and apply path for a shared skin', () => {
    const html = renderToStaticMarkup(createElement(OnboardingPanel, { ...callbacks, initialTab: 'features', online: true, access }));
    expect(html).toContain('单击正文原处编辑，双击进入专注读写');
    expect(html).toContain('点纸面留白选中整张便签');
    expect(html).toContain('皮肤库 → 已导入');
    expect(html).toContain('导入后先看预览，点应用时才改变看板外观');
    expect(html).toContain('仅用于这张便签');
  });
  it('returns project authorization to the same project and keeps the general guide out of that screen', () => {
    const html = renderToStaticMarkup(createElement(OnboardingPanel, { ...callbacks, initialTab: 'codex', online: true, access,
      onBack() {}, backLabel: '项目详情' }));
    expect(html).toContain('>来源授权</h2>');
    expect(html).toContain('返回项目详情');
    expect(html).toContain('aria-label="收起看板菜单"');
    expect(html).toContain('核对成功后，每日检查从下一周期继续');
    expect(html).not.toContain('新手引导分类');
  });
  it('presents scoped customization and Agent handoff without promising executable Skins', () => {
    const html = renderToStaticMarkup(createElement(OnboardingPanel, { ...callbacks, initialTab: 'agent', online: true, access }));
    expect(html).toContain('圆角矩形'); expect(html).toContain('任意几何路径或新交互需要改源码');
    expect(html).toContain('docs/USER_AGENT_GUIDE.md'); expect(html).toContain('持久改动');
    expect(skinGuidePrompt).toContain('skills/create-zz-board-skin/SKILL.md');
    expect(skinGuidePrompt).toContain('不要加入脚本、外部网址或字体');
    expect(skinGuidePrompt).toContain('匹配版本源码项目'); expect(html).toContain('长期维护回到匹配版本的源码项目');
    expect(sourceGuidePrompt).toContain('agent.project.yaml');
    expect(agentGuidePrompt).toContain('不要读取真实看板'); expect(skillGuidePrompt).toContain('会读或写什么');
    expect(html).toContain('复制源码维护短提示'); expect(html).toContain('复制完整 Agent 指南'); expect(sourceGuidePrompt).toContain('不要改绑定');
  });
  it('keeps startup-failure help static and disables board exercises', () => {
    const html = renderToStaticMarkup(createElement(OnboardingPanel, { ...callbacks, canUseBoard: false, online: false, access: null }));
    expect(html).toMatch(/<button disabled="">从空白页开始<\/button>/);
    expect(html).toContain('维护源码');
    const features = renderToStaticMarkup(createElement(OnboardingPanel, { ...callbacks, initialTab: 'features', canUseBoard: false, online: false, access: null }));
    expect(features).toMatch(/<button disabled="">创建练习便签<\/button>/);
    expect(features).toMatch(/<button disabled="">试试画笔<\/button>/);
    expect(features).toMatch(/<button disabled="">打开皮肤库<\/button>/);
  });
  it('states unknown estimates and separate collectors without inventing a Plus percentage', () => {
    const html = renderToStaticMarkup(createElement(CodexUsageGuide));
    expect(html).toContain('0 模型 token'); expect(html).toContain('输入估算暂为未知');
    expect(html).toContain('采集对话本身也消耗额度'); expect(html).toContain('无法固定换算');
    expect(html).toContain('/status'); expect(html).toContain('独立按量计费');
  });
  it('keeps sync preparation and auto-check blocked while allowing cancellation of saved work', () => {
    const html = renderToStaticMarkup(createElement(SummarySyncPanel, { online: true, codexAccess: access }));
    expect(html).toContain('模型目录尚未检查');
    expect(html).toMatch(/<button disabled="">准备 Codex 并读取模型目录<\/button>/);
    const check = renderToStaticMarkup(createElement(AutoCheckPanel, { online: true, canRun: false }));
    expect(check).toMatch(/<button disabled="">现在检查本机项目<\/button>/);
    const job: SyncJob = { id: 'synthetic', state: 'paused', createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z', completed: 0, total: 1, skipped: 0, error: null, model: 'synthetic', effort: 'medium', needsResubmit: false, usage: null, coverage: { projectsFound: 1, threadsFound: 1, deepRead: 0, fileChecked: 0, truncated: false, inaccessible: [] } };
    const card = renderToStaticMarkup(createElement(SyncJobCard, { job, online: true, busy: false, canResume: false, onAction() {} }));
    expect(card).toMatch(/<button disabled="">继续<\/button>/);
    expect(card).toContain('<button>取消本次同步</button>');
  });
  it('sends only explicit access fields and preserves mutation headers for preparation', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ...access, decidedAt: '2026-10-11T00:00:00Z' }) });
    vi.stubGlobal('fetch', fetch);
    await api.setCodexAccess({ localRead: false, modelUse: false });
    expect(fetch).toHaveBeenCalledWith('/api/codex/access', { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-zz-board-mutation': '1' }, body: '{"localRead":false,"modelUse":false}' });
    await api.prepareCodex();
    expect(fetch).toHaveBeenLastCalledWith('/api/codex/prepare', { method: 'POST', headers: { 'content-type': 'application/json', 'x-zz-board-mutation': '1' }, body: '{}' });
  });
});
