import { useSyncExternalStore } from 'react';
import { getTrialDiagnosticsStatus, subscribeTrialDiagnostics } from './trialDiagnostics.js';

export function TrialDiagnosticsStatus() {
  const state = useSyncExternalStore(subscribeTrialDiagnostics, getTrialDiagnosticsStatus, () => 'inactive');
  if (state === 'inactive') return null;
  return <div>
    <p>试用诊断已开启。运行事件、状态码和计数保存在本机，可请部署用的 Agent 预览并导出。</p>
    {state === 'pending' && <p role="status">本地服务暂不可用，部分试用事件等待保存。关闭窗口前可先尝试恢复连接。</p>}
    {state === 'write_failed' && <p role="alert">部分诊断事件未能保存。排查时请同时告诉 Agent 你之前做了什么。</p>}
  </div>;
}
