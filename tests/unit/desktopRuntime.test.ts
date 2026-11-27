import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanSourceRuntime, cleanTargetRuntime, copyDesktopDependency, verifyRuntime, writeRuntimeManifest } from '../../scripts/desktop-runtime.js';

interface ManifestFile { path: string; bytes: number; sha256: string }
interface Manifest { schemaVersion: number; appVersion: string; nodeVersion: string; platform: string; arch: string; files: ManifestFile[] }
const metadata = { appVersion: '0.0.0-synthetic', nodeVersion: 'synthetic-node', platform: process.platform, arch: process.arch };
const contents = new Map([
  ['node.exe', Buffer.from([0, 1, 2, 255])],
  ['server.cjs', Buffer.from('Synthetic runtime; never executed.\n')],
  ['dist/web/index.html', Buffer.from('<p>Synthetic runtime page.</p>\n')],
]);
let temporary: string; let temporaryParent: string; let project: string; let target: string; let runtime: string;
const junctions = new Set<string>();

async function put(file: string, value: string | Buffer) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); }
async function manifest(): Promise<Manifest> { return JSON.parse(await readFile(path.join(runtime, 'manifest.json'), 'utf8')) as Manifest; }
async function changeManifest(change: (value: Manifest) => void) { const value = await manifest(); change(value); await writeFile(path.join(runtime, 'manifest.json'), JSON.stringify(value)); }
async function junction(link: string, destination: string) {
  await mkdir(path.dirname(link), { recursive: true }); await symlink(destination, link, process.platform === 'win32' ? 'junction' : 'dir'); junctions.add(link);
}
function insideTemporary(file: string) {
  const relative = path.relative(temporary, path.resolve(file));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

beforeEach(async () => {
  temporaryParent = await realpath(os.tmpdir());
  temporary = await realpath(await mkdtemp(path.join(temporaryParent, 'zz-runtime-test-')));
  project = path.join(temporary, 'project'); target = path.join(project, 'src-tauri', 'target');
  runtime = path.join(target, 'release', 'resources', 'runtime');
  for (const [relative, value] of contents) await put(path.join(runtime, relative), value);
  await writeRuntimeManifest(runtime, metadata);
});
afterEach(async () => {
  // Detach only links created by this fixture before recursively removing its
  // exact mkdtemp directory. No real target, checkout, or board data is used.
  for (const link of junctions) {
    if (!insideTemporary(link)) throw new Error('Unsafe fixture junction cleanup.');
    try { await unlink(link); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  junctions.clear();
  if (path.dirname(temporary) !== temporaryParent || !path.basename(temporary).startsWith('zz-runtime-test-')
    || (await lstat(temporary)).isSymbolicLink() || await realpath(temporary) !== temporary) throw new Error('Unsafe fixture cleanup boundary.');
  await rm(temporary, { recursive: true });
});

describe('desktop dependency copy', () => {
  it('excludes generated command shims and preserves packaged commands, libraries and notices', async () => {
    const pkg = path.join(temporary, 'input');
    const copied = path.join(temporary, 'copied');
    for (const file of ['bin/tool.js', 'lib/runtime.js', 'LICENSE', 'node_modules/child/lib.js']) {
      await put(path.join(pkg, file), file);
    }
    for (const shim of ['tool', 'tool.cmd', 'tool.ps1']) {
      await put(path.join(pkg, 'node_modules/.bin', shim), 'Q:/fixture/build');
    }
    await copyDesktopDependency(pkg, copied);
    await expect(lstat(path.join(copied, 'node_modules/.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    for (const file of ['bin/tool.js', 'lib/runtime.js', 'LICENSE', 'node_modules/child/lib.js']) {
      expect(await readFile(path.join(copied, file), 'utf8')).toBe(file);
    }
  });
});

describe('desktop runtime manifest integrity', () => {
  it('writes and verifies the complete sorted file inventory, byte sizes, SHA256, and metadata', async () => {
    const expected = [...contents].map(([relative, value]) => ({ path: relative, bytes: value.length, sha256: createHash('sha256').update(value).digest('hex') }))
      .sort((a, b) => a.path.localeCompare(b.path));
    expect(await manifest()).toEqual({ schemaVersion: 2, ...metadata, files: expected });
    expect(await verifyRuntime(runtime, metadata.appVersion)).toEqual(expected);
    expect(await writeRuntimeManifest(runtime, metadata)).toEqual(expected); // manifest never inventories itself.
  });
  it('rejects a different app version and incompatible or empty manifests', async () => {
    await expect(verifyRuntime(runtime, 'other-synthetic-version')).rejects.toThrow(/version|incompatible/i);
    await changeManifest(value => { value.schemaVersion = 1; });
    await expect(verifyRuntime(runtime, metadata.appVersion)).rejects.toThrow(/incompatible/i);
    await changeManifest(value => { value.schemaVersion = 2; value.files = []; });
    await expect(verifyRuntime(runtime, metadata.appVersion)).rejects.toThrow(/inventory/i);
  });
  it('rejects an extra runtime file not present in the manifest', async () => {
    await put(path.join(runtime, 'unexpected.dll'), 'Synthetic extra file.');
    await expect(verifyRuntime(runtime, metadata.appVersion)).rejects.toThrow('Unexpected runtime file: unexpected.dll');
  });
  it('does not package the version-controlled source placeholder as a runtime payload', async () => {
    await put(path.join(runtime, '.gitkeep'), '\n');
    expect((await writeRuntimeManifest(runtime, metadata)).map(entry => entry.path)).not.toContain('.gitkeep');
    expect(await verifyRuntime(runtime, metadata.appVersion)).toHaveLength(contents.size);
  });
  it('rejects a missing runtime file', async () => {
    const file = path.join(runtime, 'server.cjs'); expect(insideTemporary(file)).toBe(true); await unlink(file);
    await expect(verifyRuntime(runtime, metadata.appVersion)).rejects.toThrow('Missing runtime file: server.cjs');
  });
  it.each([false, true])('rejects changed content even when its byte size is unchanged (%s)', async sameSize => {
    const original = contents.get('server.cjs')!;
    await writeFile(path.join(runtime, 'server.cjs'), sameSize ? Buffer.alloc(original.length, 120) : Buffer.from('Changed.'));
    await expect(verifyRuntime(runtime, metadata.appVersion)).rejects.toThrow('Changed runtime file: server.cjs');
  });
  it.each(['', '..', '../escape', '/absolute', 'nested//file', './server.cjs', 'nested/./file', 'nested/../file', 'nested\\file', 'C:/escape', 'manifest.json', 'bad?name', 'bad\u0000name'])('rejects unsafe inventory path %j before trusting its contents', async unsafePath => {
    await changeManifest(value => { value.files[0]!.path = unsafePath; });
    await expect(verifyRuntime(runtime, metadata.appVersion)).rejects.toThrow('Invalid runtime inventory entry.');
  });
  it.each([false, true])('rejects duplicate inventory paths including case-only collisions (%s)', async differentCase => {
    await changeManifest(value => { const first = value.files[0]!; value.files.push({ ...first, path: differentCase ? first.path.toUpperCase() : first.path }); });
    await expect(verifyRuntime(runtime, metadata.appVersion)).rejects.toThrow('Duplicate runtime inventory path.');
  });
  it.each(['negative-size', 'fractional-size', 'invalid-hash', 'short-hash'] as const)('rejects invalid file metadata (%s)', async invalid => {
    await changeManifest(value => {
      const first = value.files[0]!;
      if (invalid === 'negative-size') first.bytes = -1;
      else if (invalid === 'fractional-size') first.bytes = 1.5;
      else if (invalid === 'invalid-hash') first.sha256 = 'g'.repeat(64);
      else first.sha256 = 'a'.repeat(63);
    });
    await expect(verifyRuntime(runtime, metadata.appVersion)).rejects.toThrow('Invalid runtime inventory entry.');
  });
  it('rejects junctions inside a runtime without reading or overwriting their destination', async () => {
    const destination = path.join(temporary, 'outside-runtime'); const sentinel = path.join(destination, 'keep.txt');
    await put(sentinel, 'Preserve redirected destination.'); await junction(path.join(runtime, 'redirect'), destination);
    await expect(verifyRuntime(runtime, metadata.appVersion)).rejects.toThrow(/links/i);
    await expect(writeRuntimeManifest(runtime, metadata)).rejects.toThrow(/links/i);
    expect(await readFile(sentinel, 'utf8')).toBe('Preserve redirected destination.');
  });
});

describe('desktop target runtime cleanup boundaries', () => {
  it('removes only the selected release runtime and preserves its resource, executable, profile, and version siblings', async () => {
    const siblings = [
      path.join(target, 'release', 'resources', 'keep.txt'), path.join(target, 'release', 'zz-board.exe'),
      path.join(target, 'release', 'other', 'runtime', 'keep.txt'), path.join(target, 'debug', 'resources', 'runtime', 'keep.txt'),
      path.join(target, 'previous', 'release', 'resources', 'runtime', 'keep.txt'),
    ];
    for (const file of siblings) await put(file, 'Preserve sibling.');
    expect(insideTemporary(runtime)).toBe(true);
    expect(await cleanTargetRuntime(project, target, 'release')).toEqual({ removed: contents.size });
    await expect(lstat(runtime)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const file of siblings) expect(await readFile(file, 'utf8')).toBe('Preserve sibling.');
    expect(await cleanTargetRuntime(project, target, 'release')).toEqual({ removed: 0 });
  });
  it('can clean an explicitly selected nested target without touching the default release runtime', async () => {
    const selected = path.join(target, 'synthetic-version'); const selectedRuntime = path.join(selected, 'release', 'resources', 'runtime');
    await put(path.join(selectedRuntime, 'nested.txt'), 'Remove selected runtime.');
    expect(await cleanTargetRuntime(project, selected, 'release')).toEqual({ removed: 1 });
    await expect(lstat(selectedRuntime)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await verifyRuntime(runtime, metadata.appVersion)).toHaveLength(contents.size);
  });
  it.skipIf(process.platform !== 'win32')('accepts target and TARGET as the same Windows directory without deleting profile siblings', async () => {
    const sibling = path.join(target, 'debug', 'resources', 'runtime', 'keep.txt'); await put(sibling, 'Preserve debug profile.');
    const equivalentTarget = path.join(path.dirname(target), 'TARGET');
    expect(await realpath(equivalentTarget)).toBe(await realpath(target));
    expect(await cleanTargetRuntime(project, equivalentTarget, 'release')).toEqual({ removed: contents.size });
    await expect(lstat(runtime)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(sibling, 'utf8')).toBe('Preserve debug profile.');
  });
  it.each(['outside-project', 'target-sibling', 'parent-target', 'invalid-profile'] as const)('rejects an unauthorized target or profile (%s) without removing the original runtime', async unsafe => {
    const selected = unsafe === 'outside-project' ? path.join(temporary, 'outside-project')
      : unsafe === 'target-sibling' ? path.join(project, 'src-tauri', 'target-other')
      : unsafe === 'parent-target' ? path.dirname(target) : target;
    const profile = unsafe === 'invalid-profile' ? '../release' : 'release';
    await expect(cleanTargetRuntime(project, selected, profile)).rejects.toThrow(/out-of-project/i);
    expect(await verifyRuntime(runtime, metadata.appVersion)).toHaveLength(contents.size);
  });
  it('rejects a target ancestor junction and preserves its redirected runtime', async () => {
    const destination = path.join(temporary, 'redirected-target'); const sentinel = path.join(destination, 'release', 'resources', 'runtime', 'keep.txt');
    await put(sentinel, 'Preserve redirected target.'); const selected = path.join(target, 'linked'); await junction(selected, destination);
    await expect(cleanTargetRuntime(project, selected, 'release')).rejects.toThrow(/redirected/i);
    expect(await readFile(sentinel, 'utf8')).toBe('Preserve redirected target.');
    expect(await verifyRuntime(runtime, metadata.appVersion)).toHaveLength(contents.size);
  });
  it('rejects a runtime junction before deleting the link or its destination', async () => {
    const selected = path.join(target, 'linked-runtime'); const selectedRuntime = path.join(selected, 'release', 'resources', 'runtime');
    const destination = path.join(temporary, 'outside-runtime'); const sentinel = path.join(destination, 'keep.txt');
    await put(sentinel, 'Preserve redirected runtime.'); await junction(selectedRuntime, destination);
    await expect(cleanTargetRuntime(project, selected, 'release')).rejects.toThrow(/redirected/i);
    expect((await lstat(selectedRuntime)).isSymbolicLink()).toBe(true);
    expect(await readFile(sentinel, 'utf8')).toBe('Preserve redirected runtime.');
  });
  it('rejects a nested junction before removing any file from the selected runtime', async () => {
    const destination = path.join(temporary, 'outside-runtime'); const sentinel = path.join(destination, 'keep.txt');
    await put(sentinel, 'Preserve nested destination.'); await junction(path.join(runtime, 'nested-link'), destination);
    await expect(cleanTargetRuntime(project, target, 'release')).rejects.toThrow(/links/i);
    expect(await readFile(path.join(runtime, 'server.cjs'))).toEqual(contents.get('server.cjs'));
    expect(await readFile(sentinel, 'utf8')).toBe('Preserve nested destination.');
  });
});

describe('desktop generated source runtime cleanup', () => {
  it('cleans only the fixed source runtime while preserving source-resource and target-runtime siblings', async () => {
    const sourceRuntime = path.join(project, 'src-tauri', 'resources', 'runtime');
    const sibling = path.join(project, 'src-tauri', 'resources', 'keep.txt');
    await put(path.join(sourceRuntime, 'source.cjs'), 'Synthetic source runtime.'); await put(sibling, 'Preserve source resources.');
    const placeholder = Buffer.from('\n'); await put(path.join(sourceRuntime, '.gitkeep'), placeholder);
    expect(await cleanSourceRuntime(project)).toEqual({ removed: 1 });
    await expect(lstat(path.join(sourceRuntime, 'source.cjs'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(sourceRuntime, '.gitkeep'))).toEqual(placeholder);
    expect(await readFile(sibling, 'utf8')).toBe('Preserve source resources.');
    expect(await verifyRuntime(runtime, metadata.appVersion)).toHaveLength(contents.size);
    expect(await cleanSourceRuntime(project)).toEqual({ removed: 0 });
  });
  it.each(['src-tauri', 'resources'] as const)('rejects a source runtime ancestor junction at %s and preserves the external sentinel', async ancestor => {
    const sourceProject = path.join(temporary, 'source-project'); const destination = path.join(temporary, 'outside-source');
    const link = ancestor === 'src-tauri' ? path.join(sourceProject, 'src-tauri') : path.join(sourceProject, 'src-tauri', 'resources');
    const sentinel = ancestor === 'src-tauri' ? path.join(destination, 'resources', 'runtime', 'keep.txt') : path.join(destination, 'runtime', 'keep.txt');
    await put(sentinel, 'Preserve external source destination.'); await junction(link, destination);
    await expect(cleanSourceRuntime(sourceProject)).rejects.toThrow(/redirected/i);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(sentinel, 'utf8')).toBe('Preserve external source destination.');
    expect(await verifyRuntime(runtime, metadata.appVersion)).toHaveLength(contents.size);
  });
  it('rejects a nested source junction before deleting source payloads or the external sentinel', async () => {
    const sourceRuntime = path.join(project, 'src-tauri', 'resources', 'runtime'); const sourceFile = path.join(sourceRuntime, 'source.cjs');
    const destination = path.join(temporary, 'outside-source'); const sentinel = path.join(destination, 'keep.txt');
    await put(sourceFile, 'Preserve source payload.'); await put(sentinel, 'Preserve external sentinel.');
    await junction(path.join(sourceRuntime, 'nested-link'), destination);
    await expect(cleanSourceRuntime(project)).rejects.toThrow(/links/i);
    expect(await readFile(sourceFile, 'utf8')).toBe('Preserve source payload.');
    expect(await readFile(sentinel, 'utf8')).toBe('Preserve external sentinel.');
  });
});
