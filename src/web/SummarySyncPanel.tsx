import { useEffect, useState } from 'react';
import type { SummaryModel, SummarySettings, SyncJob } from '../shared/summarySync.js';
import './summarySync.css';
import { processedCount, summaryProblem } from './summaryFeedback.js';
import { AutoCheckPanel } from './AutoCheckPanel.js';
import type { CodexAccess } from '../shared/codexAccess.js';
import { api } from './api.js';

const mutationHeaders = { 'content-type': 'application/json', 'x-zz-board-mutation': '1' };
const stateLabels: Record<SyncJob['state'], string> = { queued: '等待整理', running: '正在整理', paused: '暂未完成', complete: '整理完成', cancelled: '已停止' };

export function ProjectModelChoices({ catalog, onSelect }: { catalog: SummaryModel[]; onSelect(settings: SummarySettings): void }) {
  const choices = ['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6.1-terra'].filter(id =>
    catalog.some(model => model.id === id && model.efforts.includes('medium')));
  if (!choices.length) return null;
  return <div><small>对话状态整理 · 本机可选（medium）</small><div>{choices.map(model =>
    <button key={model} type="button" onClick={() => onSelect({ model, effort: 'medium' })}>{model}</button>)}</div>
    <p className="settings-help">点选后可调整推理强度，保存后用于后续摘要。</p></div>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `服务返回 ${response.status}`);
  return data as T;
}

export function UsageSummary({ job }: { job: Pick<SyncJob, 'usage'> }) {
  if (!job.usage) return <p>总结用量：未知（运行时未提供计量）</p>;
  const value = (n: number) => Number.isFinite(n) ? n.toLocaleString('zh-CN') : '未知';
  return <details className="summary-usage"><summary>总结用量：{value(job.usage.totalTokens)} token</summary><dl><dt>输入</dt><dd>{value(job.usage.inputTokens)}</dd><dt>其中缓存输入</dt><dd>{value(job.usage.cachedInputTokens)}</dd><dt>输出</dt><dd>{value(job.usage.outputTokens)}</dd><dt>其中推理输出</dt><dd>{value(job.usage.reasoningOutputTokens)}</dd></dl><small>缓存与推理为明细，不再次相加；不包含 Codex 采集任务自身的用量。</small></details>;
}

export function SyncJobCard({ job, online, busy, canResume = true, onAction }: { job: SyncJob; online: boolean; busy: boolean; canResume?: boolean; onAction(action: 'pause' | 'resume' | 'cancel'): void }) {
  return <article className="sync-job"><h4>{job.state === 'paused' && job.completed ? '已更新部分内容' : stateLabels[job.state]}</h4><small>{new Date(job.createdAt).toLocaleString('zh-CN')}</small><progress aria-label="对话总结进度" value={processedCount(job)} max={Math.max(1, job.total)} /><p>已整理 {job.completed} {job.kind === 'history' ? '段项目记录' : '条对话'}{job.failures?.length ? `，${job.failures.length} 条暂未更新` : ''}</p>
    {job.state === 'paused' && <p role="status">{summaryProblem(job)}</p>}
    {job.needsResubmit && <p>再次检查项目即可重试，已整理的内容会保留。</p>}
    <details><summary>本次更新详情</summary><small>{job.model} · {job.effort}</small><p>{job.skipped} 条无需本次整理（已保存、正在处理或有更新记录）。</p>
    <p>采集发现 {job.coverage.projectsFound} 个项目、{job.coverage.threadsFound} 条对话；深读 {job.coverage.deepRead} 条。</p>
    {(job.coverage.truncated || job.coverage.inaccessible.length > 0) && <details><summary>覆盖不完整</summary>{job.coverage.truncated && <p>源列表或历史读取达到上限，不能代表全部来源。</p>}{job.coverage.inaccessible.map((item, index) => <p key={index}>{item}</p>)}</details>}
    <UsageSummary job={job} />{job.error && <p>{job.error}</p>}{job.failures?.map((item, index) => <p key={index}>未更新原因：{item.code}</p>)}{Boolean(job.warnings?.length) && <p>未能确认的产物链接已省略，未影响通过核对的文字总结。</p>}<p>远程或 ChatGPT 对话请重新运行下方同步指令。</p></details>
    <div className="sync-actions">{['queued', 'running'].includes(job.state) && <button disabled={!online || busy} onClick={() => onAction('pause')}>暂停</button>}{job.state === 'paused' && !job.needsResubmit && <button disabled={!online || busy || !canResume} onClick={() => onAction('resume')}>继续</button>}{['queued', 'running', 'paused'].includes(job.state) && <button disabled={!online || busy} onClick={() => onAction('cancel')}>取消本次同步</button>}</div>
  </article>;
}

export function SummarySyncPanel({ online, codexAccess, onOpenOnboarding }: { online: boolean; codexAccess?: CodexAccess | null; onOpenOnboarding?(): void }) {
  const [catalog, setCatalog] = useState<{ models: SummaryModel[]; available: boolean; reason?: string } | null>(null);
  const [settings, setSettings] = useState<SummarySettings | null>(null);
  const [jobs, setJobs] = useState<SyncJob[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [modelError, setModelError] = useState('');
  const [jobsError, setJobsError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [instructions, setInstructions] = useState('');
  const mayRead = Boolean(codexAccess?.decidedAt && codexAccess.localRead);
  const mayGenerate = Boolean(mayRead && codexAccess?.modelUse);
  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    void request<SummarySettings>('/api/summary/settings', { signal: controller.signal })
      .then(saved => { if (!controller.signal.aborted) { setSettings(saved); setModelError(''); } }).catch(error => { if (!controller.signal.aborted) setModelError(`读取模型设置失败：${error instanceof Error ? error.message : '连接异常'}`); });
    return () => controller.abort();
  }, [online]);
  useEffect(() => { if (!mayRead) setCatalog(null); }, [mayRead]);
  useEffect(() => {
    if (!online || !historyOpen) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let delay = 10000;
      try { const data = await request<{ jobs: SyncJob[] }>('/api/sync/jobs', { signal: controller.signal });
        if (!controller.signal.aborted) { setJobs(data.jobs); setJobsError(''); if (data.jobs.some(job => job.state === 'running' || job.state === 'queued')) delay = 1500; } }
      catch { if (!controller.signal.aborted) setJobsError('暂时无法获取同步进度，已保留上次结果。'); }
      finally { if (!controller.signal.aborted) timer = setTimeout(() => void poll(), delay); }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [online, historyOpen]);
  const selectedModel = catalog?.models.find(model => model.id === settings?.model);
  const supported = Boolean(mayGenerate && catalog?.available && settings && selectedModel?.efforts.includes(settings.effort));
  async function prepare() {
    if (!mayRead || !online || busy) return;
    setBusy(true); setModelError(''); setMessage('');
    try { const value = await api.prepareCodex(); setCatalog(value); setMessage(value.available ? 'Codex 准备检查完成，没有生成总结。' : 'Codex 准备尚未完成，没有生成总结；原因见下方。'); }
    catch (error) { setModelError(`准备 Codex 失败：${error instanceof Error ? error.message : '连接异常'}`); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!settings || !supported || !online) return;
    setBusy(true); setMessage('');
    try { setSettings(await request('/api/summary/settings', { method: 'PATCH', headers: mutationHeaders, body: JSON.stringify(settings) })); setMessage('总结模型已保存，仅影响后续总结，不重算既有历史。'); }
    catch (error) { setMessage(`保存失败：${error instanceof Error ? error.message : '连接异常'}`); }
    finally { setBusy(false); }
  }
  async function copyInstructions(force = false) {
    setBusy(true); setMessage('');
    try { const data = await request<{ prompt: string }>(`/api/sync/instructions${force ? '?force=true' : ''}`); setInstructions(data.prompt); await navigator.clipboard.writeText(data.prompt); setMessage(`${force ? '重新总结' : '全源同步'}指令已复制，请在 Codex 中发送；此按钮本身不会采集。`); }
    catch { setMessage('指令获取或复制失败。若下方已显示指令，可手动复制。'); }
    finally { setBusy(false); }
  }
  async function action(job: SyncJob, value: 'pause' | 'resume' | 'cancel') {
    if (value === 'resume' && !mayGenerate) return;
    setBusy(true); setMessage('');
    try { const updated = await request<SyncJob>(`/api/sync/jobs/${encodeURIComponent(job.id)}/${value}`, { method: 'POST', headers: mutationHeaders, body: '{}' }); setJobs(current => current?.map(item => item.id === updated.id ? updated : item) ?? null); }
    catch (error) { setMessage(`操作失败：${error instanceof Error ? error.message : '连接异常'}`); }
    finally { setBusy(false); }
  }
  return <section className="summary-sync-panel">
    <AutoCheckPanel online={online} canRun={mayGenerate} />
    {onOpenOnboarding && <button onClick={onOpenOnboarding}>来源授权</button>}
    <details className="sync-option"><summary>从 Codex 同步更多来源</summary><p className="settings-help">在 Codex 中发送同步指令，可整理远程项目和 ChatGPT 对话。采集和总结各自消耗额度。</p>
    <button disabled={!online || busy} onClick={() => void copyInstructions()}>复制全源同步指令</button>{instructions && <details><summary>查看／手动复制指令</summary><textarea aria-label="全源同步指令" readOnly value={instructions} rows={5} /></details>}
    <details><summary>重新总结已有内容</summary><p className="settings-help">将在 Codex 中以当前模型重新整理这次提交的内容，会额外使用额度。</p><button disabled={!online || busy} onClick={() => void copyInstructions(true)}>复制重新总结指令</button></details></details>
    <details className="sync-option"><summary>总结模型</summary>
    {!catalog && <p>模型目录尚未检查。准备会检查登录与模型目录；首次可能扫描本机会话元数据建立索引，耗时数分钟，不发送正文做模型生成。</p>}
    <button disabled={!online || busy || !mayRead} onClick={() => void prepare()}>{busy ? '处理中…' : '准备 Codex 并读取模型目录'}</button>
    <fieldset disabled={!online || busy || !settings || !catalog || !mayGenerate}><legend>总结模型</legend>
      {modelError && <p role="alert">{modelError}</p>}{catalog && !catalog.available && <p role="status">模型总结不可用：{catalog.reason || '运行时未建立安全边界'}</p>}
      {mayGenerate && catalog?.available && <ProjectModelChoices catalog={catalog.models} onSelect={choice => {
        setSettings(choice); setMessage(`已选择 ${choice.model} / ${choice.effort}，尚未保存。`);
      }} />}
      <label>模型<select aria-label="总结模型" value={settings?.model || ''} onChange={event => setSettings(current => current ? { ...current, model: event.target.value } : current)}><option value="" disabled>请显式准备 Codex</option>{settings && !selectedModel && <option value={settings.model}>{settings.model}（{catalog ? '当前不可用' : '尚未核验'}）</option>}{catalog?.models.map(model => <option key={model.id} value={model.id}>{model.id}</option>)}</select></label>
      <label>推理强度<select aria-label="总结推理强度" value={settings?.effort || ''} onChange={event => setSettings(current => current ? { ...current, effort: event.target.value } : current)}><option value="" disabled>选择强度</option>{settings && !selectedModel?.efforts.includes(settings.effort) && <option value={settings.effort}>{settings.effort}（{catalog ? '此模型不支持' : '尚未核验'}）</option>}{selectedModel?.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label>
      <p className="settings-help">使用本机 Codex 登录额度。不自动更换模型、提高强度或切换 API 计费；更换模型不自动重算历史。</p><button disabled={!supported || busy} onClick={() => void save()}>保存总结设置</button>
    </fieldset></details>
    <details className="sync-option" onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>更新记录与用量</summary>
      {jobsError && <p role="alert">{jobsError}</p>}{jobs === null ? online && !jobsError && <p>正在读取更新记录…</p> : jobs.length ? jobs.map(job => <SyncJobCard key={job.id} job={job} busy={busy} online={online} canResume={mayGenerate} onAction={value => void action(job, value)} />) : <p>暂无更新记录。</p>}
    </details>
    {!online && <p role="status">离线中，暂时不能更新。</p>}{message && <p role="status">{message}</p>}
  </section>;
}
