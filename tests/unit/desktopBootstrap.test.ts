import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const script = readFileSync(new URL('../../src-tauri/src/desktop-bootstrap.js', import.meta.url), 'utf8');
const origin = 'http://127.0.0.1:4318';
async function boot(controlled: boolean, workerPath = '/sw.js') {
  const unregister = vi.fn(async () => true);
  const replace = vi.fn();
  const worker = { scriptURL: origin + workerPath };
  const window: Record<string, unknown> = {}; window.top = window;
  runInNewContext(script, { window, URL, console, location: { origin, href: origin + '/', replace }, navigator: {
    serviceWorker: { controller: controlled ? worker : null, getRegistrations: async () => [{ active: worker, unregister }] }
  } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { window, unregister, replace };
}

describe('desktop startup cache isolation', () => {
  it('detaches the old board worker before replacing its controlled document', async () => {
    const result = await boot(true);
    expect(result.window.__ZZ_BOARD_DESKTOP__).toBe(true);
    expect(result.unregister).toHaveBeenCalledOnce();
    expect(result.replace).toHaveBeenCalledExactlyOnceWith('/?desktop-recovery=1');
  });
  it('does not reload the new uncontrolled document', async () => {
    const result = await boot(false);
    expect(result.replace).not.toHaveBeenCalled();
  });
  it('does not unregister an unrelated worker or touch recovery storage', async () => {
    const result = await boot(true, '/other-worker.js');
    expect(result.unregister).not.toHaveBeenCalled();
    expect(result.replace).not.toHaveBeenCalled();
    expect(script).not.toMatch(/indexedDB\.|caches\.delete|localStorage\.clear/);
  });
});
