import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import { findDesktopCodexExecutable, resolveCodexExecutable } from '../../src/server/codex/summaryRuntime.js';
import { sourceReadFailure } from '../../src/server/projectRefresh.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  await mkdir('.tmp', { recursive: true });
  const root = await mkdtemp(path.resolve('.tmp', 'codex-lookup-')); roots.push(root);
  const binary = async (name: string, when: number) => {
    const dir = path.join(root, 'OpenAI', 'Codex', 'bin', name); await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'codex.exe'); await writeFile(file, 'synthetic-not-executable'); await utimes(file, when, when); return file;
  };
  return { root, binary };
}
describe('Desktop CLI lookup without shell-injected PATH', () => {
  it.skipIf(process.platform !== 'win32')('resolves with an Explorer-like PATH, but never overrides an explicit executable', async () => {
    const { root, binary } = await fixture();
    const installed = await binary('1234567812345678', 2000);
    vi.stubEnv('LOCALAPPDATA', root);
    vi.stubEnv('PATH', path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'));
    const registration = vi.fn<() => Promise<string | undefined>>().mockResolvedValue(undefined);
    expect(await resolveCodexExecutable('codex', registration)).toBe(installed);
    const currentDesktop = await binary('2345678923456789', 1000);
    registration.mockResolvedValue(currentDesktop);
    expect(await resolveCodexExecutable('codex', registration)).toBe(currentDesktop);
    const explicit = path.join(root, 'custom.exe');
    expect(await resolveCodexExecutable(explicit, registration)).toBe(explicit);
    await expect(resolveCodexExecutable('zz-nonexistent-custom-cli', registration)).rejects.toMatchObject({ code: 'executable_required' });
    expect(registration).toHaveBeenCalledTimes(2);
  });
  it('selects the newest installed binary, ignoring unrelated directories and removed binaries', async () => {
    const { root, binary } = await fixture();
    await binary('1111111111111111', 1000);
    const newest = await binary('2222222222222222', 2000);
    await binary('unrelated', 3000);
    await mkdir(path.join(root, 'OpenAI', 'Codex', 'bin', '3333333333333333'));
    expect(await findDesktopCodexExecutable(root)).toBe(newest);
  });
  it('fails closed for absent roots, relative roots or an oversized candidate directory', async () => {
    expect(await findDesktopCodexExecutable('relative')).toBeUndefined();
    const { root, binary } = await fixture();
    expect(await findDesktopCodexExecutable(root)).toBeUndefined();
    for (let i = 0; i < 65; i++) await binary(i.toString(16).padStart(16, '0'), 1000);
    expect(await findDesktopCodexExecutable(root)).toBeUndefined();
  });
  it('reports actionable classified failures without leaking upstream text', () => {
    expect(sourceReadFailure({ code: 'executable_required', message: 'private' })).toContain('找不到本机 Codex');
    expect(sourceReadFailure(new Error('thread/list timed out.'))).toContain('超时');
    expect(sourceReadFailure(new Error('private source body'))).not.toContain('private');
  });
});
