import { Component, type ErrorInfo, type ReactNode } from 'react';
import { TrialDiagnosticsStatus } from './TrialDiagnosticsStatus.js';
import { recordTrialWeb } from './trialDiagnostics.js';

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    recordTrialWeb('render_error', 'failed');
    console.error('ZZ Board render failed', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <main className="loading-screen" role="alert">
      <img src="/zz-mark.svg" alt="" />
      <h1>看板暂时无法显示</h1>
      <p>请重新加载看板。如果桌面版仍然无法打开，可在系统托盘的 ZZ Board 菜单选择「重启本地服务」。</p>
      {this.state.error.message && <details><summary>错误详情</summary><pre>{this.state.error.message}</pre></details>}
      <TrialDiagnosticsStatus />
      <button className="primary" onClick={() => window.location.reload()}>重新加载</button>
    </main>;
  }
}
