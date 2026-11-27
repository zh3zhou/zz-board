import { mkdir, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import { expandPastedRequests } from '../../src/server/codex/pastedText.js';
import { extractRefreshEvidence } from '../../src/server/projectRefresh.js';

const stamp = '2026-09-21T08:00:00.000Z';
afterEach(() => vi.restoreAllMocks());
const item = (file: string) => ({ id: 'user', type: 'userMessage', content: [{ type: 'text', text: `# Files pasted by the user:\n\n## "合成复盘请求": ${file}\n\nPasted text contains the user's request.\n\n## My request:\n` }] });
async function fixture(work: (root: string, outer: string) => Promise<void>) {
  const parent = path.resolve('.tmp'); await mkdir(parent, { recursive: true });
  const outer = await mkdtemp(path.join(parent, 'pasted-unit-')); const root = path.join(outer, 'attachments'); await mkdir(root);
  try { await work(root, outer); }
  finally { if (path.dirname(outer) !== parent) throw Error('cleanup boundary'); await rm(outer, { recursive: true, force: true }); }
}
describe('bounded pasted-request evidence', () => {
  it('stops before opening an attachment when consent is revoked during directory resolution', async () => fixture(async root => {
    const file = path.join(root, 'request.txt'); await writeFile(file, 'synthetic request');
    const turns = [{ items: [item(file)] }]; let permitted = true; let release!: (value: string) => void;
    vi.spyOn(fs, 'realpath').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const opened = vi.spyOn(fs, 'open');
    const operation = { check: () => { if (!permitted) throw Object.assign(new Error('Synthetic access revoked.'), { code: 'CODEX_ACCESS_REQUIRED' }); } };
    const pending = expandPastedRequests(turns, root, operation).catch(error => error);
    permitted = false; release(root); expect(await pending).toMatchObject({ code: 'CODEX_ACCESS_REQUIRED' });
    expect(opened).not.toHaveBeenCalled(); expect(turns[0]!.items[0]!.content).toHaveLength(1);
  }));
  it('recovers a pasted review request with original user provenance before an empty interrupted tail', async () => fixture(async root => {
    const file = path.join(root, 'request.txt'); await writeFile(file, '请对项目做长期复盘，区分已交付与待验证。');
    const turns = [{ id: 'first', status: 'interrupted', startedAt: stamp, items: [item(file)] }, { id: 'empty', status: 'interrupted', items: [] }];
    expect(await expandPastedRequests(turns, root)).toEqual([]);
    const project = { projectKey: 'project', cwd: 'synthetic', name: '合成项目', observedAt: stamp };
    const result = extractRefreshEvidence({ thread: { id: 'thread', cwd: project.cwd, updatedAt: stamp, turns } },
      { threadKey: 'thread', threadId: 'thread', title: '合成复盘', hostId: 'local' }, project, stamp);
    expect(result.source?.evidence).toHaveLength(1);
    expect(result.source?.evidence[0]).toMatchObject({ role: 'user', occurredAt: stamp, turnId: 'first' });
    expect(result.source?.evidence[0].text).toContain('长期复盘');
    expect(result.source?.evidence[0].text).not.toContain(root);
    expect(result.source?.readReason).toContain('不能据此判断');
  }));
  it('rejects external paths, links outside the root and ordinary mentioned files', async () => fixture(async (root, outer) => {
    const outside = path.join(outer, 'outside.txt'); await writeFile(outside, 'DO_NOT_READ');
    const turns = [{ items: [item(outside)] }];
    expect((await expandPastedRequests(turns, root)).join('')).toContain('不在允许');
    expect(JSON.stringify(turns)).not.toContain('DO_NOT_READ');
    const alias = path.join(root, 'alias'); await symlink(outer, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = [{ items: [item(path.join(alias, 'outside.txt'))] }];
    expect((await expandPastedRequests(linked, root)).join('')).toContain('不在允许');
    expect(JSON.stringify(linked)).not.toContain('DO_NOT_READ');
    const ordinary = [{ items: [{ ...item(outside), content: [{ type: 'text', text: `请查看 ${outside}` }] }] }];
    const before = JSON.stringify(ordinary); expect(await expandPastedRequests(ordinary, root)).toEqual([]); expect(JSON.stringify(ordinary)).toBe(before);
  }));
  it('bounds file count and size and reports missing attachments without claiming empty requests', async () => fixture(async root => {
    const file = path.join(root, 'large.txt'); await writeFile(file, 'a'.repeat(70_000));
    const turns = [{ items: Array.from({ length: 7 }, () => item(file)) }];
    const gaps = await expandPastedRequests(turns, root);
    expect(gaps.join('')).toContain('64 KiB'); expect(gaps.join('')).toContain('六个文件');
    expect(turns[0].items[0].content[1].text.length).toBeLessThan(66_000);
    expect(turns[0].items[6].content).toHaveLength(1);
    expect((await expandPastedRequests([{ items: [item(path.join(root, 'missing.txt'))] }], root)).join('')).toContain('不可访问');
    const empty = path.join(root, 'empty.txt'); await writeFile(empty, '');
    const emptyTurns = [{ items: [item(empty)] }];
    expect((await expandPastedRequests(emptyTurns, root)).join('')).toContain('附件为空');
    expect(emptyTurns[0].items[0].content).toHaveLength(1);
  }));
});
