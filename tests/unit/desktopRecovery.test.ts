import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const script = readFileSync(new URL('../../src-tauri/src/desktop-recovery.js', import.meta.url), 'utf8');
function recover(ready: boolean) {
  const dispatchEvent = vi.fn(); const replace = vi.fn();
  const draft = { body: '未完成的便签\n保留空格 ' };
  const window = { __ZZ_BOARD_READY__: ready, dispatchEvent, draft };
  runInNewContext(script.replace('__STATUS_URL__', JSON.stringify('data:text/html,recovery')), { window, location: { replace }, Event });
  return { dispatchEvent, replace, window, draft };
}
describe('desktop recovery keeps a live canvas mounted', () => {
  it('does not reload ready or loading documents, but retries a browser error page', () => {
    const openScript = readFileSync(new URL('../../src-tauri/src/desktop-open.js', import.meta.url), 'utf8');
    for (const [ready, hasRoot, calls] of [[true, true, 0], [false, true, 0], [false, false, 1]] as const) {
      const replace = vi.fn();
      runInNewContext(openScript, { window: { __ZZ_BOARD_READY__: ready }, document: { getElementById: () => hasRoot ? {} : null }, location: { replace } });
      expect(replace).toHaveBeenCalledTimes(calls);
    }
  });
  it('signals recovery without navigation or losing drafts', () => {
    const result = recover(true);
    expect(result.replace).not.toHaveBeenCalled();
    expect(result.dispatchEvent).toHaveBeenCalledOnce();
    expect(result.dispatchEvent.mock.calls[0][0].type).toBe('zz-board-service-recovering');
    expect(result.window.draft).toBe(result.draft);
  });
  it('still opens a recovery page when no usable board has loaded', () => {
    const result = recover(false);
    expect(result.replace).toHaveBeenCalledExactlyOnceWith('data:text/html,recovery');
    expect(result.dispatchEvent).not.toHaveBeenCalled();
  });
});
