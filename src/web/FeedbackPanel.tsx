import { useEffect, useRef, useState } from 'react';
import {
  FeedbackClientError, deleteFeedback, deletionCredential, downloadFeedbackText,
  feedbackPreview, githubIssueForms, prepareFeedback, publicFeedbackText, readFeedbackDiagnostics, submitFeedback
} from './feedbackClient.js';
import type { FeedbackSubmissionResult } from './feedbackClient.js';
import { canClearFeedbackReceipt, emptyFeedbackDraft, feedbackStore } from './feedbackStore.js';
import type { FeedbackDraft, FeedbackFields, LocalFeedbackReceipt } from './feedbackStore.js';
import { MenuHeader, type MenuNavigation } from './MenuHeader.js';
import { TrialDiagnosticsStatus } from './TrialDiagnosticsStatus.js';
import { recordTrialWeb } from './trialDiagnostics.js';
import './feedback.css';

export function FeedbackPanel({ onClose, onBack, backLabel }: MenuNavigation) {
  const [draft, setDraft] = useState<FeedbackDraft>(emptyFeedbackDraft);
  const draftRef = useRef(draft);
  const [receipts, setReceipts] = useState<LocalFeedbackReceipt[]>([]);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [diagnosing, setDiagnosing] = useState(false);
  const [privateAvailable, setPrivateAvailable] = useState(false), [privateMode, setPrivateMode] = useState(false);
  const [preview, setPreview] = useState(false), [notice, setNotice] = useState(''), [storageNotice, setStorageNotice] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null), [credentialId, setCredentialId] = useState<string | null>(null);
  const busyRef = useRef(false), alive = useRef(true), diagnosticSequence = useRef(0);
  const pendingSave = useRef(Promise.resolve());

  useEffect(() => {
    let active = true;
    alive.current = true;
    void fetch('/api/feedback/status', { cache: 'no-store', signal: AbortSignal.timeout(3000) })
      .then(async response => response.ok && (await response.json()).privateSubmissionConfigured === true)
      .then(enabled => { if (active) setPrivateAvailable(enabled); })
      .catch(() => { /* Offline drafts can still be copied or saved for GitHub. */ });
    void feedbackStore.load().then(state => {
      if (!active || !alive.current) return;
      const restored = state.draft ?? emptyFeedbackDraft(); draftRef.current = restored; setDraft(restored);
      setPreview(Boolean(restored.prepared)); setReceipts(state.receipts); setLoaded(true);
    }).catch(() => { if (active && alive.current) { setLoaded(true); setStorageNotice('本机草稿暂时无法保存，请复制或下载报告。'); } });
    return () => { active = false; alive.current = false; diagnosticSequence.current++; };
  }, []);

  function persist(next: FeedbackDraft) {
    draftRef.current = next; setDraft(next);
    pendingSave.current = pendingSave.current.catch(() => {}).then(() => feedbackStore.saveDraft(next));
    void pendingSave.current.then(() => { if (alive.current) setStorageNotice('草稿已保存在本机，不会自动上传。'); })
      .catch(() => { if (alive.current) setStorageNotice('草稿尚未保存到本机，请先复制报告；提交前会再次尝试保存。'); });
  }

  function edit<K extends keyof FeedbackFields>(key: K, value: FeedbackFields[K]) {
    setPreview(false); setNotice('');
    persist({ ...draftRef.current, fields: { ...draftRef.current.fields, [key]: value }, prepared: undefined });
  }

  async function chooseDiagnostics(enabled: boolean) {
    const sequence = ++diagnosticSequence.current;
    persist({ ...draftRef.current, includeDiagnostics: enabled, diagnostics: undefined, prepared: undefined });
    setPreview(false); setDiagnosing(enabled);
    if (!enabled) return;
    const result = await readFeedbackDiagnostics();
    if (!alive.current || sequence !== diagnosticSequence.current || !draftRef.current.includeDiagnostics) return;
    persist({ ...draftRef.current, diagnostics: result.diagnostics }); setDiagnosing(false);
    if (result.unavailable) setNotice('本地服务信息暂不可用；诊断预览仅包含界面版本及“服务不可用”，不会读取原始日志。');
  }

  async function makePreview() {
    if (busyRef.current || diagnosing) return;
    if (!privateMode) {
      const { goal, actual, expected } = draftRef.current.fields;
      if (![goal, actual, expected].some(value => value.trim())) {
        recordTrialWeb('feedback_preview', 'blocked');
        setNotice('请先写下问题或建议。'); return;
      }
      recordTrialWeb('feedback_preview', 'ok');
      setNotice(''); setPreview(true); return;
    }
    busyRef.current = true; setBusy(true); setNotice('');
    try {
      let current = draftRef.current;
      if (current.includeDiagnostics && !current.diagnostics && !current.prepared) {
        const result = await readFeedbackDiagnostics();
        current = { ...current, diagnostics: result.diagnostics };
        if (alive.current && result.unavailable) setNotice('本地服务信息暂不可用；诊断预览仅包含界面版本及“服务不可用”。');
      }
      const prepared = current.prepared ?? await prepareFeedback(current.fields, current.includeDiagnostics ? current.diagnostics : undefined);
      persist({ ...current, prepared });
      // Preview remains available if local storage is unavailable; send has its own mandatory durable transaction.
      await pendingSave.current.catch(() => {});
      if (alive.current) setPreview(true);
      recordTrialWeb('feedback_preview', 'ok');
    } catch (error) {
      recordTrialWeb('feedback_preview', 'failed');
      if (alive.current) setNotice(error instanceof FeedbackClientError ? error.message : '无法准备反馈，请复制已填写内容后重试。');
    }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }

  async function reloadLocal() {
    const state = await feedbackStore.load();
    if (!alive.current) return;
    const current = state.draft ?? emptyFeedbackDraft(); draftRef.current = current; setDraft(current);
    setPreview(Boolean(current.prepared)); setReceipts(state.receipts);
  }

  async function send() {
    if (busyRef.current || !privateMode || !privateAvailable || !preview || !draftRef.current.prepared) return;
    busyRef.current = true; setBusy(true); setNotice('');
    try {
      await pendingSave.current.catch(() => {});
      const current = draftRef.current;
      const result = await submitFeedback({ ...current, prepared: current.prepared! }, feedbackStore);
      if (alive.current) setNotice(submissionNotice(result));
    } catch (error) {
      if (alive.current) setNotice(error instanceof FeedbackClientError ? error.message : '本机草稿或凭证未能保存，本次未继续提交；请先复制报告并稍后重试。');
    } finally {
      await reloadLocal().catch(() => { if (alive.current) setStorageNotice('本机回执暂时无法读取；不要清空浏览器或应用数据。'); });
      busyRef.current = false; if (alive.current) setBusy(false);
    }
  }

  async function remove(record: LocalFeedbackReceipt) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setNotice('');
    try {
      await pendingSave.current.catch(() => {});
      await deleteFeedback(record, feedbackStore);
      if (alive.current) { setNotice('反馈服务已删除这份报告。平台日志和备份的清除时间尚未核实。'); setDeleteId(null); }
    } catch (error) {
      if (alive.current) setNotice(error instanceof FeedbackClientError ? error.message : '删除尚未完成，凭证仍保留。请稍后手动重试删除。');
    } finally { await reloadLocal().catch(() => {}); busyRef.current = false; if (alive.current) setBusy(false); }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      recordTrialWeb('feedback_copy', 'ok');
      if (alive.current) setNotice('已复制，请粘贴到你选择的位置。');
    } catch {
      recordTrialWeb('feedback_copy', 'failed');
      if (alive.current) setNotice('复制未成功，请选中预览中的文字手动复制。');
    }
  }

  async function clearDeletedReceipts() {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setNotice('');
    try {
      await pendingSave.current.catch(() => {});
      await feedbackStore.clearDeletedReceipts();
      await reloadLocal();
      if (alive.current) setNotice('已清理服务确认删除且已过重试期的本机回执。其他删除凭证继续保留。');
    } catch { if (alive.current) setNotice('本机回执尚未清理，请稍后重试。'); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }

  function download(text: string, filename: string) {
    try {
      downloadFeedbackText(text, filename);
      recordTrialWeb('feedback_save', 'start');
      setNotice('已发起下载；若未出现文件，请复制预览内容并自行保存。');
    } catch {
      recordTrialWeb('feedback_save', 'failed');
      setNotice('下载未能开始，请复制预览内容并自行保存。');
    }
  }

  async function leave(next: () => void) {
    if (busyRef.current) return;
    await pendingSave.current.catch(() => {}); next();
  }

  const content = draft.prepared?.submission;
  const privatePreview = privateMode && content ? feedbackPreview(content) : '';
  const currentReceipt = receipts.find(item => item.reportId === content?.reportId);
  return <aside className="feedback-panel panel-shell" aria-label="反馈与帮助" onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.keyCode !== 229 && !event.repeat && !busyRef.current) { event.preventDefault(); void leave(onBack ?? onClose); }
  }} onPointerDown={event => event.stopPropagation()}>
    <MenuHeader title="反馈与帮助" onClose={() => void leave(onClose)} onBack={onBack && (() => void leave(onBack))} backLabel={backLabel} disabled={busy} />
    <div className="panel-scroll feedback-body">
      <p>问题和建议可先在本机预览、复制或保存。GitHub 表单随源码公开，在 GitHub 确认发布后，其他人就能看到你的 Issue。</p>
      <TrialDiagnosticsStatus />
      {!loaded && <p role="status">正在读取本机草稿…</p>}
      {loaded && !preview && <fieldset disabled={busy} className="feedback-form">
        {privateAvailable && <label>反馈渠道<select value={privateMode ? 'private' : 'github'} onChange={event => { setPrivateMode(event.target.value === 'private'); setNotice(''); }}><option value="github">GitHub 公开 Issue</option><option value="private">已配置的私有收件服务</option></select></label>}
        <label>反馈类型<select value={draft.fields.kind} onChange={event => edit('kind', event.target.value as FeedbackFields['kind'])}><option value="problem">报告问题</option><option value="idea">想法或体验</option></select></label>
        <label>你当时想做什么？<textarea maxLength={4000} rows={3} value={draft.fields.goal} onChange={event => edit('goal', event.target.value)} /></label>
        <label>实际发生了什么，或你的想法是什么？<textarea maxLength={8000} rows={4} value={draft.fields.actual} onChange={event => edit('actual', event.target.value)} /></label>
        <label>你原本期待什么？<textarea maxLength={4000} rows={3} value={draft.fields.expected} onChange={event => edit('expected', event.target.value)} /></label>
        {(privateMode || draft.fields.kind === 'problem') && <label>数据是否受到影响？<select value={draft.fields.dataImpact} onChange={event => edit('dataImpact', event.target.value as FeedbackFields['dataImpact'])}><option value="unknown">不确定</option><option value="none">没有影响</option><option value="possible">内容可能缺失或错误</option></select></label>}
        {privateMode && <>
        <label>联系方式（可选）<input type="text" maxLength={300} value={draft.fields.contact ?? ''} onChange={event => edit('contact', event.target.value)} autoComplete="off" /></label>
        <label className="feedback-opt-in"><input type="checkbox" checked={draft.includeDiagnostics} onChange={event => void chooseDiagnostics(event.target.checked)} />附加可预览的诊断信息</label>
        <small>仅包含可获得的版本、运行环境与固定错误码；不附截图、笔记、任务历史、路径或完整日志。你填写的文字也可能包含隐私，请在提交前检查。</small>
        {diagnosing && <p role="status">正在读取本地版本信息…</p>}
        {draft.includeDiagnostics && draft.diagnostics && <details><summary>查看诊断 JSON</summary><pre tabIndex={0}>{JSON.stringify(draft.diagnostics, null, 2)}</pre></details>}
        </>}
        <div className="feedback-actions"><button className="primary" disabled={diagnosing} onClick={() => void makePreview()}>预览报告</button></div>
      </fieldset>}
      {loaded && preview && !privateMode && <PublicIssuePreview fields={draft.fields} onCopy={copy} onDownload={download} onEdit={() => { setPreview(false); setNotice(''); }} />}
      {loaded && preview && privateMode && <>
        <FeedbackPreview text={privatePreview} />
        <p className="feedback-privacy">点「确认提交」将发送上方完整报告，包括正文、你选择附上的联系方式和诊断信息、报告编号、请求时间，以及用于核对删除凭证的校验值。原始删除凭证只保存在本机。</p>
        <FeedbackRetentionNotice />
        {content && <small>报告编号：{content.reportId}<br />同一份请求可重试至 {new Date(content.retryUntil).toLocaleString('zh-CN')}。编辑内容会生成新的报告编号。</small>}
        <div className="feedback-actions"><button className="primary" disabled={busy} onClick={() => void send()}>{busy ? '正在处理…' : currentReceipt ? '用同一报告重试' : '确认提交'}</button>
          <button disabled={busy} onClick={() => { persist({ ...draftRef.current, prepared: undefined }); setPreview(false); setNotice(''); }}>返回编辑</button>
          <button disabled={busy} onClick={() => void copy(privatePreview)}>复制报告</button>
          {content?.diagnostics && <button disabled={busy} onClick={() => download(JSON.stringify(content.diagnostics, null, 2), 'zzb-diagnostics-v1.json')}>下载诊断 JSON</button>}
        </div>
      </>}
      {storageNotice && <p className="feedback-storage" role="status">{storageNotice}</p>}
      {notice && <p className="feedback-notice" role="status">{notice}</p>}
      {receipts.length > 0 && <section className="feedback-receipts"><h3>本机回执与删除凭证</h3><p>这里只显示本机记录，不查询处理进度。删除凭证可控制对应报告，请勿放入公开 Issue 或再次作为反馈提交。</p>
        {receipts.some(record => record.state === 'deleted') && <><button disabled={busy || !receipts.some(record => canClearFeedbackReceipt(record))} onClick={() => void clearDeletedReceipts()}>清理可移除的本机删除回执</button><small>仅清理服务已确认删除且报告的 24 小时重试期已过的记录；其余凭证会保留。</small></>}
        {[...receipts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(record => <article key={record.reportId}>
          <strong>{receiptLabel(record)}</strong><small>{record.reportId}</small>
          {record.receipt && <small>收到回执：{new Date(record.receipt.acceptedAt).toLocaleString('zh-CN')} · 报告到期：{new Date(record.receipt.retainedUntil).toLocaleString('zh-CN')}，定时清理可能滞后最多 24 小时。</small>}
          {record.state !== 'deleted' && <div className="feedback-actions"><button disabled={busy} onClick={() => setCredentialId(credentialId === record.reportId ? null : record.reportId)}>保存删除凭证</button><button disabled={busy} onClick={() => setDeleteId(record.reportId)}>{record.state === 'deleting' ? '重试删除' : '删除这份反馈'}</button></div>}
          {credentialId === record.reportId && record.state !== 'deleted' && <div className="feedback-credential"><p>请自行保存。清空应用数据且丢失凭证后，不能仅凭报告编号恢复删除权限。</p><textarea readOnly rows={5} aria-label="删除凭证 JSON" value={deletionCredential(record)} /><div className="feedback-actions"><button onClick={() => void copy(deletionCredential(record))}>复制删除凭证</button><button onClick={() => download(deletionCredential(record), `zzb-feedback-delete-${record.reportId}.json`)}>下载凭证 JSON</button></div></div>}
          {deleteId === record.reportId && record.state !== 'deleted' && <div className="feedback-delete-confirm"><p>要从反馈服务删除这份报告的正文、联系方式和诊断信息吗？平台日志和备份的清除时间尚未核实。本机将停止这份报告的提交重试。</p><button disabled={busy} onClick={() => void remove(record)}>确认删除</button><button disabled={busy} onClick={() => setDeleteId(null)}>取消</button></div>}
        </article>)}
      </section>}
    </div>
  </aside>;
}

export function PublicIssuePreview({ fields, onCopy, onDownload, onEdit }: {
  fields: FeedbackFields;
  onCopy: (text: string) => void;
  onDownload: (text: string, filename: string) => void;
  onEdit: () => void;
}) {
  const text = publicFeedbackText(fields);
  const url = githubIssueForms[fields.kind];
  const form = fields.kind === 'problem' ? '问题' : '建议';
  return <section className="feedback-preview">
    <h3>公开报告预览</h3><pre tabIndex={0} aria-label="公开报告预览">{text}</pre>
    <p>请删去个人路径、真实便签、对话和联系方式。复制这段文字后，可在 GitHub 的「公开报告」栏粘贴并编辑。</p>
    <div className="feedback-actions"><button className="primary" onClick={() => onCopy(text)}>复制公开报告</button>
      <button onClick={() => onDownload(text, 'zz-board-feedback.txt')}>保存为文本</button>
      <button onClick={onEdit}>返回编辑</button></div>
    <a href={url} target="_blank" rel="noopener noreferrer">打开 GitHub {form}表单</a>
    <details><summary>表单打不开</summary><p>可复制地址到系统浏览器。仓库尚未开放或暂时无法访问时，先保存报告。</p>
      <pre tabIndex={0}>{url}</pre><button onClick={() => onCopy(url)}>复制表单地址</button></details>
  </section>;
}

export function FeedbackPreview({ text }: { text: string }) {
  return <section className="feedback-preview"><h3>即将提交的内容</h3><pre tabIndex={0} aria-label="反馈报告预览">{text}</pre></section>;
}

export function FeedbackRetentionNotice() {
  return <p className="feedback-privacy">反馈服务中的报告在接收 90 天后到期，定时清理可能滞后最多 24 小时。你可以用本机凭证提前请求删除报告。删除回执只确认这份报告已删除。平台日志和备份另有保留期限，清除时间尚未核实。</p>;
}

export function receiptLabel(record: LocalFeedbackReceipt): string {
  return { prepared: '已保存在本机，尚无送达回执', uncertain: '送达结果未确认', received: '已送达，尚不代表已处理', deleting: '删除待确认，已停止提交重试', deleted: '已收到删除回执' }[record.state];
}

export function submissionNotice(result: FeedbackSubmissionResult): string {
  if (result.state === 'deleting') return '送达回执晚于删除请求到达；删除结果仍待确认，已停止这份报告的提交重试。';
  if (result.state === 'deleted') return '送达回执晚于删除请求到达；本机已收到删除回执，这份报告不会恢复为已送达。';
  return '反馈已送达。回执只表示接收成功，不代表已经查看或处理。请保存下方删除凭证。';
}
