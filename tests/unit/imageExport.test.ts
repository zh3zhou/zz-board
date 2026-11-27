import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { saveAndCopyPng } from '../../src/web/imageExport.js';
import { ExportReceipt } from '../../src/web/ImageExportFeedback.js';

const { save, copy } = vi.hoisted(() => ({ save: vi.fn(), copy: vi.fn() }));
vi.mock('../../src/web/api.js', () => ({ api: { savePng: save } }));
vi.mock('../../src/web/rasterExport.js', () => ({ copyPng: copy }));
const saved = { path: 'output/test.png', width: 48, height: 32, bytes: 100 };
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); save.mockResolvedValue(saved); copy.mockResolvedValue(undefined); });
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });
describe('save and clipboard outcomes', () => {
  it('starts copying synchronously in the gesture and saves the exact same blob once', async () => {
    let ready!: (blob: Blob) => void; const generated = new Promise<Blob>(resolve => { ready = resolve; });
    const result = saveAndCopyPng(generated, 'note');
    expect(copy).toHaveBeenCalledOnce(); expect(save).not.toHaveBeenCalled();
    const blob = new Blob(['png'], { type: 'image/png' }); ready(blob);
    expect(await result).toEqual({ saved, copied: true }); expect(save).toHaveBeenCalledWith(blob, 'note');
    expect(copy).toHaveBeenCalledWith(generated);
  });
  it.each(['save', 'copy', 'both'] as const)('reports %s failure without losing the other successful outcome', async failing => {
    if (failing !== 'copy') save.mockRejectedValueOnce(new Error('磁盘不可写'));
    if (failing !== 'save') copy.mockRejectedValueOnce(new Error('剪贴板拒绝'));
    const result = await saveAndCopyPng(new Blob(['png']), 'region');
    expect(result.copied).toBe(failing === 'save'); expect(Boolean(result.saved)).toBe(failing === 'copy');
    expect(result.saveError).toBe(failing !== 'copy' ? '磁盘不可写' : undefined);
    expect(result.copyError).toBe(failing !== 'save' ? '剪贴板拒绝' : undefined);
    const html = renderToStaticMarkup(createElement(ExportReceipt, { result }));
    expect(html).toContain(failing === 'save' ? '文件未保存' : failing === 'copy' ? '剪贴板复制未成功' : '图片未保存，也未复制');
  });
  it('prevents duplicate concurrent writes and can retry afterward', async () => {
    let done!: () => void; save.mockImplementationOnce(async () => { await new Promise<void>(resolve => { done = resolve; }); return saved; });
    const first = saveAndCopyPng(new Blob(['png']), 'region'); await Promise.resolve();
    await expect(saveAndCopyPng(new Blob(['png']), 'region')).rejects.toThrow('稍后');
    const render = vi.fn(async () => new Blob(['png']));
    await expect(saveAndCopyPng(render, 'note')).rejects.toThrow('稍后'); expect(render).not.toHaveBeenCalled();
    done(); await first;
    expect(save).toHaveBeenCalledOnce(); await saveAndCopyPng(new Blob(['png']), 'region'); expect(save).toHaveBeenCalledTimes(2);
  });
  it('provides a wrapped click-to-copy path, not an unverified download or shell link', () => {
    const html = renderToStaticMarkup(createElement(ExportReceipt, { result: { saved, copied: true } }));
    expect(html).toContain('已保存并复制'); expect(html).toContain('复制已保存图片路径'); expect(html).toContain(saved.path);
    expect(html).not.toContain('href=');
  });
  it('does not save or announce clipboard success when rendering fails', async () => {
    copy.mockImplementationOnce(async blob => { await blob; });
    const result = await saveAndCopyPng(Promise.reject(new Error('原图暂不可用')), 'note');
    expect(save).not.toHaveBeenCalled(); expect(result).toEqual({ copied: false, saveError: '原图暂不可用', copyError: '原图暂不可用' });
  });
});
