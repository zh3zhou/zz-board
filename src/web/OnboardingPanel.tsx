import { useEffect, useRef, useState } from 'react';
import type { CodexAccess } from '../shared/codexAccess.js';
import { DEFAULT_SUMMARY_SETTINGS } from '../shared/summarySync.js';
import userAgentGuide from '../../docs/USER_AGENT_GUIDE.md?raw';
import agentCustomizationGuide from '../../docs/AGENT_CUSTOMIZATION.md?raw';
import { api } from './api.js';
import { MenuHeader, type MenuNavigation } from './MenuHeader.js';
import { agentGuidePrompt, onboardingFeatures, onboardingWalkthroughs, skinGuidePrompt, skillGuidePrompt, sourceGuidePrompt, type OnboardingTab } from './onboarding.js';
import './onboarding.css';

interface OnboardingPanelProps extends MenuNavigation {
  initialTab?: OnboardingTab;
  canUseBoard?: boolean;
  online: boolean;
  access: CodexAccess | null;
  onCreateNote(): void;
  onTryInk(): void;
  onFitView(): void;
  onOpenSettings(): void;
  hasSavedProjects?: boolean;
  onOpenProjects?(): void;
  onStartBlankPage?(): Promise<boolean>;
  onOpenSkins(): void;
  onOpenFeedback(): void;
}

export function CodexUsageGuide() {
  return <section className="onboarding-card" aria-label="用量说明"><h3>先知道会用多少</h3>
    <p>便签、图片、画笔、静态帮助和 更换皮肤均为本地操作，用量为 0 模型 token。读取授权、准备 Codex 与生成总结是不同操作。</p>
    <p>首次同步还未选择证据范围，输入估算暂为未知。项目历史补全预览只估算该次有界输入；输出、推理与采集 Agent 的上下文另计。建议先选一个项目、少量对话，查看实际总结用量，再扩大范围。</p>
    <p>把指令交给 Codex Agent 执行时，采集对话本身也消耗额度；ZZB 独立总结单独显示输入、缓存、输出和推理 token。</p>
    <p>默认的总结模型和推理强度为 <code>{DEFAULT_SUMMARY_SETTINGS.model} / {DEFAULT_SUMMARY_SETTINGS.effort}</code>。实际调用使用「项目 → 项目更新」中保存的配置。</p>
    <p>token 无法固定换算成 Plus 的 X%。请在 Codex 使用 <code>/status</code> 或官方用量页查看实际窗口和重置时间。ChatGPT 登录用订阅额度；API Key 是独立按量计费路径，ZZB 不会替你切换。</p>
  </section>;
}

export function OnboardingPanel(props: OnboardingPanelProps) {
  const { access, online, onClose, canUseBoard = true } = props;
  const permissionsOnly = Boolean(props.onBack && props.initialTab === 'codex');
  const [tab, setTab] = useState<OnboardingTab>(props.initialTab ?? 'quick');
  const [localRead, setLocalRead] = useState(access?.localRead ?? false);
  const [modelUse, setModelUse] = useState(access?.modelUse ?? false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [prepared, setPrepared] = useState<{ available: boolean; reason: string; models: Array<{ id: string }> } | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState('');
  const [copiedLabel, setCopiedLabel] = useState('给 Agent 的指令');
  const panel = useRef<HTMLElement>(null);
  const dismiss = props.onBack ?? onClose;
  useEffect(() => { setLocalRead(access?.localRead ?? false); setModelUse(access?.modelUse ?? false); setPrepared(null); }, [access]);
  const embedded = Boolean(props.onBack);
  useEffect(() => {
    if (embedded) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [embedded]);

  async function saveAccess() {
    if (!online || !access || busy) return;
    setBusy(true); setNotice('');
    try {
      const saved = await api.setCodexAccess({ localRead, modelUse: localRead && modelUse });
      setNotice(saved.localRead ? `授权已保存在本机。${saved.modelUse ? '模型整理已允许。如已开启每日检查，先在一个项目的概览点「检查更新」。' : '模型调用仍关闭。'}` : '已选择只使用本地画布；Codex 读取和模型调用已关闭。');
    } catch (error) { setNotice(error instanceof Error ? error.message : '授权未保存，请重试。'); }
    finally { setBusy(false); }
  }

  async function prepare() {
    if (!online || !access?.localRead || busy) return;
    setBusy(true); setNotice('');
    try { const value = await api.prepareCodex(); setPrepared(value); setNotice(value.available ? 'Codex 准备检查完成；没有生成总结。' : `Codex 尚不可用：${value.reason}`); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Codex 准备检查失败。'); }
    finally { setBusy(false); }
  }

  async function copy(prompt: string, label = '给 Agent 的指令') {
    setCopiedPrompt(prompt); setCopiedLabel(label);
    try { await navigator.clipboard.writeText(prompt); setNotice('内容已复制。发送给 Agent 后才执行，请补充你的目标。'); }
    catch { setNotice('无法自动复制，可从下方手动复制。'); }
  }

  function action(run: () => void) { onClose(); run(); }

  async function startBlankPage() {
    if (!canUseBoard || busy || !props.onStartBlankPage) return;
    setBusy(true);
    try {
      if (await props.onStartBlankPage()) onClose();
      else setNotice('空白页还未打开。请检查连接，或先完成当前编辑再试。');
    } catch { setNotice('暂时无法打开空白页，请重试。'); }
    finally { setBusy(false); }
  }

  return <>{!props.onBack && <div className="onboarding-backdrop" aria-hidden="true" />}<aside ref={panel} className="onboarding-panel" role={props.onBack ? 'region' : 'dialog'} aria-modal={props.onBack ? undefined : true} aria-labelledby="onboarding-title" tabIndex={-1}
    onKeyDown={event => {
      if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.keyCode !== 229 && !event.repeat) { event.preventDefault(); event.stopPropagation(); if (!busy) dismiss(); }
      if (props.onBack || event.key !== 'Tab') return;
      const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href]') || []);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first?.focus(); }
    }}>
    <MenuHeader id="onboarding-title" title={permissionsOnly ? '来源授权' : '使用指南'} onClose={onClose} onBack={props.onBack} backLabel={props.backLabel} disabled={busy}>
      {!permissionsOnly && <nav className="panel-tabs" aria-label="使用指南分类">{([['quick', '从画布开始'], ['features', '按需使用功能'], ['codex', '项目与授权'], ['agent', '维护源码']] as const).map(([key, label]) => <button key={key} disabled={busy} aria-current={tab === key} onClick={() => setTab(key)}>{label}</button>)}</nav>}
    </MenuHeader>
    <div className="panel-scroll">
      {tab === 'quick' && <div className="onboarding-start">
        <div><button className="primary" onClick={() => props.hasSavedProjects && props.onOpenProjects ? props.onOpenProjects() : setTab('codex')}>查看我的 Codex 项目</button>
          <p>{props.hasSavedProjects ? '从已保存在看板的项目找到对话和待办。' : '先选择读取范围，再把自己的项目和对话带到画布。'}</p></div>
        <div><button disabled={!canUseBoard || busy || !props.onStartBlankPage} onClick={() => void startBlankPage()}>从空白页开始</button>
          <p>直接写便签、贴图或画图。当前页已有内容时会另建一页。</p></div>
      </div>}
      {access?.decidedAt === null && (tab === 'quick' || tab === 'codex') && <p className="onboarding-notice">Codex 的读取与模型调用需分别确认。原有偏好保留，确认前相关自动操作暂停。{tab === 'quick' && <button onClick={() => setTab('codex')}>查看授权</button>}</p>}
      {tab === 'quick' && <p>这份指南只在你主动打开时出现；不会读取 Codex 历史、调用模型或自动带你走流程。</p>}
      {tab === 'features' && <>
        <div className="onboarding-actions"><button disabled={!canUseBoard} onClick={() => action(props.onCreateNote)}>创建练习便签</button><button disabled={!canUseBoard} onClick={() => action(props.onTryInk)}>试试画笔</button><button disabled={!canUseBoard} onClick={() => action(props.onFitView)}>看全画布</button><button disabled={!canUseBoard} onClick={props.onOpenSkins}>打开皮肤库</button></div>
        {onboardingWalkthroughs.map(item => <details className="onboarding-feature" key={item.title}><summary>{item.title}</summary><ol>{item.steps.map(step => <li key={step}>{step}</li>)}</ol><p>完成结果：{item.result}</p><p>恢复与撤销：{item.recovery}</p></details>)}
        {onboardingFeatures.map(item => <details className="onboarding-feature" key={item.title}><summary>{item.title}</summary><p>{item.body}</p></details>)}
        <div className="onboarding-actions"><button disabled={!canUseBoard} onClick={props.onOpenSettings}>打开项目更新</button><button onClick={props.onOpenFeedback}>反馈与帮助</button></div></>}
      {tab === 'codex' && <><section className="onboarding-card"><p>选择 ZZ Board 可以从 Codex 读取哪些内容，以及是否允许模型整理。你可以随时关闭，已保存的看板记录会保留。</p>
        <fieldset disabled={!online || !access || busy}><legend>本机权限</legend><label><input type="checkbox" checked={localRead} onChange={event => { setLocalRead(event.target.checked); if (!event.target.checked) setModelUse(false); }} />允许读取本机 Codex 项目与对话证据</label><small>包括项目和对话列表、所选对话的部分正文。预览项目历史时也会读取项目的进展和版本记录。</small>
          <label><input type="checkbox" checked={modelUse} disabled={!localRead} onChange={event => setModelUse(event.target.checked)} />允许将选定证据交给模型总结／看板顾问</label><small>整理时会发送所选内容，并使用当前 Codex 登录额度。已经发出的请求无法撤回。如果之前已开启每日检查，允许后先到一个项目的概览点「检查更新」。核对成功后，每日检查从下一周期继续。</small>
          <button disabled={!canUseBoard} onClick={props.onOpenSettings}>查看每日检查</button>
          <button className="primary" onClick={() => void saveAccess()}>{busy ? '处理中…' : '保存我的选择'}</button></fieldset>
        {!online && <p>当前本地服务离线，可先读指南和使用本地画布；授权暂不能保存。</p>}{online && !access && <p>授权状态暂不可用，读取与模型操作保持关闭。请重新连接本地服务。</p>}
      </section><details className="menu-fold"><summary>连接 Codex 与用量说明</summary><section className="onboarding-card"><h3>检查本机连接</h3><p>先安装并登录 Codex。准备检查会启动临时 Codex 进程，检查登录、配置与模型目录。首次可能扫描本机会话元数据并建立索引，需先允许本地读取，可能耗时数分钟；不会发送正文做模型生成，也不会替你登录或安装 Skill。</p><button disabled={!online || !access?.localRead || busy} onClick={() => void prepare()}>准备并检查 Codex</button>{prepared && <p>本机登录身份与模型目录：{prepared.available ? '已读取' : '未完成'}；模型目录 {prepared.models.length} 项。{prepared.reason}</p>}<p>准备结果不验证实际模型请求或剩余额度，也不代表总结运行时已通过安全检查。首次总结前还会单独探测空工具配置与兼容性，未通过时不生成总结。</p>
        <p>之后在「项目 → 项目更新」复制全源同步指令，先告诉 Agent 要查看哪些项目。远程和 ChatGPT 需要 Agent 的可访问权限；复制指令本身不采集。</p><button disabled={!canUseBoard} onClick={props.onOpenSettings}>打开项目更新</button></section><CodexUsageGuide /></details></>}
      {tab === 'agent' && <><p>长期维护回到匹配版本的源码项目：Agent 在那里定位、验证并构建完整桌面交付物；之后仍由该版本 README 和手册记录下一次改动。不要修补 EXE。</p><details className="menu-fold"><summary>完整 Agent 指南</summary><p>需要完整操作和定制上下文时按需复制；日常优先使用下方的短提示。</p><button onClick={() => void copy(`# ZZ Board 用户操作与 Agent 改造指南\n\n${userAgentGuide}\n\n---\n\n${agentCustomizationGuide}`, '完整 Agent 指南')}>复制完整 Agent 指南</button></details><section className="onboarding-card"><h3>改形状和背景</h3><p>声明式 Skin 支持圆、椭圆、圆角矩形、软边形状、本地 PNG/WebP 纹理及颜色、材质。任意几何路径或新交互需要改源码。</p><button onClick={() => void copy(skinGuidePrompt, 'Skin 短提示')}>复制 Skin 短提示</button><button disabled={!canUseBoard} onClick={props.onOpenSkins}>打开皮肤库</button></section>
        <section className="onboarding-card"><h3>改功能或交接维护</h3><p>让 Agent 先给最小方案、数据影响和验证命令；用合成数据验证。桌面候选由源码构建，不能替代发布或原生验收。</p><button onClick={() => void copy(sourceGuidePrompt, '源码维护短提示')}>复制源码维护短提示</button><p><code>README.md</code> · <code>docs/USER_AGENT_GUIDE.md</code> · <code>docs/AGENT_CUSTOMIZATION.md</code></p></section>
        <section className="onboarding-card"><h3>问操作或 Skill</h3><p>引导不自动讲解。需要时复制一条短提示给 Agent；安装用户级 Skill 副本是持久改动，须明确选择。</p><button onClick={() => void copy(agentGuidePrompt, '操作问答短提示')}>复制操作问答短提示</button><button onClick={() => void copy(skillGuidePrompt, 'Skill 短提示')}>复制 Skill 短提示</button></section>
        {copiedPrompt && <label className="onboarding-copy">{copiedLabel}<textarea readOnly rows={6} value={copiedPrompt} aria-label={copiedLabel} /></label>}</>}
      <p role="status" aria-live="polite">{notice}</p>
    </div>
  </aside></>;
}
