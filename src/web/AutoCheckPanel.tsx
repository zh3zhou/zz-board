import { useEffect, useState } from 'react';
import type { AutoCheckState } from '../shared/milestones.js';
import { api } from './api.js';
import './timeline.css';

export function AutoCheckPanel({ online, canRun = true }: { online: boolean; canRun?: boolean }) {
  const [state, setState] = useState<AutoCheckState | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!online) return; let ended = false;
    const poll = () => void api.autoCheck().then(value => { if (!ended) { setState(value); setError(''); } }).catch(() => { if (!ended) setError('自动检查状态暂不可用。'); });
    poll(); const timer = setInterval(poll, 5000); return () => { ended = true; clearInterval(timer); };
  }, [online]);
  async function action(enabled?: boolean) {
    if (!canRun && enabled !== false) return;
    setBusy(true); try { setState(await (enabled === undefined ? api.runAutoCheck() : api.setAutoCheck(enabled))); setError(''); }
    catch { setError('设置没有保存成功，请稍后重试。'); } finally { setBusy(false); }
  }
  return <section className="auto-check"><h3>每日检查</h3><label><input type="checkbox" checked={state?.enabled ?? false} disabled={!online || busy || !state || !canRun && !state.enabled} onChange={event => void action(event.target.checked)} />看板运行时，每 24 小时检查本机项目</label>
    <p>{state?.message || '连接后可读取检查状态。'}</p>
    {state?.enabled && state.state !== 'paused' && state.nextCheckAt && <small>下次检查　{new Date(state.nextCheckAt).toLocaleString('zh-CN')}</small>}
    {state?.lastCompletedAt && <small>上次完成：{new Date(state.lastCompletedAt).toLocaleString('zh-CN')}</small>}
    <button disabled={!online || busy || !canRun || !state || Boolean(state.recoveryToken) || state.state === 'running'} onClick={() => void action()}>现在检查本机项目</button>
    <small>启动或唤醒后只补查一次。只整理有变化的内容，沿用当前总结模型；不包含远程与 ChatGPT。</small>
    {error && <p role="status">{error}</p>}
  </section>;
}
