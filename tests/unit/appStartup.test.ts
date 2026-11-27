import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import App from '../../src/web/App.js';

afterEach(() => { vi.unstubAllGlobals(); vi.doUnmock('../../src/web/main.js'); });

describe('application startup', () => {
  it('keeps the same quiet static surface while React waits for the board', () => {
    vi.stubGlobal('window', { innerWidth: 1366, innerHeight: 768 });
    const html = renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(App)));
    expect(html).toBe('');
    const staticPage = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    expect(staticPage).toMatch(/id="root"><\/div>\s*<main id="startup-shell"/);
    expect(staticPage).toContain('#root:not(:empty) + #startup-shell { display: none; }');
    expect(staticPage).toContain('visibility: hidden; animation: startup-visible 0s 2s forwards');
    // This fallback must work even when the module entry itself cannot be fetched under script-src self.
    expect(staticPage).toMatch(/#startup-recovery\s*\{\s*animation-delay: 20s/);
    expect(staticPage).toContain('<a href="/">重新加载</a>');
  });
  it('reveals recovery immediately on a rejected interface import and treats error text as plain text', async () => {
    vi.resetModules();
    vi.doMock('../../src/web/main.js', () => { throw new Error('synthetic <local>'); });
    const shell = { setAttribute: vi.fn(), removeAttribute: vi.fn() };
    const message = { textContent: '' }, detail = { textContent: '' };
    const elements: Record<string, unknown> = { 'startup-shell': shell, 'startup-message': message, 'startup-detail': detail };
    vi.stubGlobal('document', { getElementById: (id: string) => elements[id] });
    await import('../../src/web/entry.js');
    await vi.waitFor(() => expect(shell.setAttribute).toHaveBeenCalledWith('data-failed', ''));
    expect(message.textContent).toBe('界面资源未能载入。');
    expect(detail.textContent).not.toBe('');
  });
});
