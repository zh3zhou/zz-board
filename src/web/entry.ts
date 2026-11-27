import { installTrialErrorListeners, recordTrialWeb } from './trialDiagnostics.js';

installTrialErrorListeners();

// Keep the startup fallback independent of React and its dependency graph.
void import('./main.js').then(() => {
  document.getElementById('startup-shell')?.setAttribute('data-mounted', '');
  recordTrialWeb('window_loaded', 'ok');
  if (import.meta.env.PROD && !('__ZZ_BOARD_DESKTOP__' in window) && 'serviceWorker' in navigator) {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }
}).catch((error: unknown) => {
  recordTrialWeb('render_error', 'failed');
  const shell = document.getElementById('startup-shell');
  shell?.removeAttribute('data-mounted');
  shell?.setAttribute('data-failed', '');
  const message = document.getElementById('startup-message');
  if (message) message.textContent = '界面资源未能载入。';
  const detail = document.getElementById('startup-detail');
  if (detail) detail.textContent = error instanceof Error ? error.message : String(error);
});
