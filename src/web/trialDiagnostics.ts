import type { TrialWebEvent } from '../shared/trialDiagnostics.js';

type TrialStatus = 'inactive' | 'active' | 'pending' | 'write_failed';
const MAX_QUEUED_EVENTS = 256;
const statusEvent = 'zz-board:trial-web-status';
const pending: TrialWebEvent[] = [];
let sending = false;
let writeFailed = false;
let waitingForService = false;

function nativeStatus() {
  if (typeof window === 'undefined') return;
  return (window as Window & { __ZZ_BOARD_TRIAL_DIAGNOSTICS__?: 'active' | 'write_failed' }).__ZZ_BOARD_TRIAL_DIAGNOSTICS__;
}

export function getTrialDiagnosticsStatus(): TrialStatus {
  const native = nativeStatus();
  if (!native) return 'inactive';
  if (native === 'write_failed' || writeFailed) return 'write_failed';
  return waitingForService ? 'pending' : 'active';
}

export function subscribeTrialDiagnostics(listener: () => void) {
  window.addEventListener(statusEvent, listener);
  window.addEventListener('zz-board:trial-native-failed', listener);
  return () => {
    window.removeEventListener(statusEvent, listener);
    window.removeEventListener('zz-board:trial-native-failed', listener);
  };
}

function publishStatus() { window.dispatchEvent(new Event(statusEvent)); }

async function flush() {
  if (sending || !pending.length) return;
  sending = true;
  try {
    while (pending.length) {
      const result = await fetch('/api/trial/diagnostics/events', {
        method: 'POST',
        cache: 'no-store',
        keepalive: true,
        signal: AbortSignal.timeout(3000),
        headers: { 'content-type': 'application/json', 'x-zz-board-mutation': '1' },
        body: JSON.stringify(pending[0])
      });
      if (result.status !== 204) {
        if (result.status === 503) writeFailed = true;
        waitingForService = true;
        break;
      }
      pending.shift();
      waitingForService = false;
    }
  } catch {
    waitingForService = true;
  } finally {
    sending = false;
    publishStatus();
  }
}

export function recordTrialWeb(event: TrialWebEvent['event'], outcome: TrialWebEvent['outcome']) {
  if (!nativeStatus()) return;
  if (pending.length === MAX_QUEUED_EVENTS) {
    writeFailed = true;
    publishStatus();
    return;
  }
  pending.push({ event, outcome });
  void flush();
}

export function observeTrialHealth(status: unknown) {
  if (!nativeStatus()) return;
  if (status === 'write_failed') {
    writeFailed = true;
    publishStatus();
  }
  if (status === 'active') void flush();
}

export function installTrialErrorListeners() {
  if (!nativeStatus()) return;
  window.addEventListener('error', () => recordTrialWeb('render_error', 'failed'));
  window.addEventListener('unhandledrejection', () => recordTrialWeb('render_error', 'failed'));
}
