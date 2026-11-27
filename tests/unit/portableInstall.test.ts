import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeRuntimeManifest } from '../../scripts/desktop-runtime';

const { defaultInstallDirectory, installPortable, runtimeForExecutable, rollbackPortable } = await import(new URL('../../scripts/install-portable.mjs', import.meta.url).href);
const { sourceIdentity, writeBuildReceipt, deployBuild, readStatus, checkRecovery, statusDirectory, deploymentPaths, liveState, bindCodex, trialInstallTarget } = await import(new URL('../../scripts/source-deployment.mjs', import.meta.url).href);
let root: string, destination: string;
let env: { LOCALAPPDATA: string; USERPROFILE: string };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const version = '0.11.0';
const exe = 'zz-board.exe';
const previous = 'zz-board.previous.exe';
const installDatabase = '.zz-board-install.sqlite';
const base = await realpath(os.tmpdir());
const checkVersion = async (file: string) => (await readFile(file, 'utf8')).startsWith('synthetic-zzb ') ? version : 'unrelated';
const options = (sourceDir: string) => ({ sourceDir, installDir: destination, env, apply: true, versionOf: checkVersion, ensureStopped: () => {} });

async function fixture(name: string, schema = 2, embedded = true, trial = false) {
  const directory = path.join(root, name);
  const runtime = path.join(directory, 'resources', 'runtime');
  for (const file of ['node.exe', 'server.cjs', 'dist/web/index.html']) {
    const output = path.join(runtime, file);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, 'Synthetic file ' + name + file);
  }
  const metadata = { appVersion: version, nodeVersion: process.version, platform: 'win32', arch: 'x64' };
  if (schema === 2) await writeRuntimeManifest(runtime, {
    ...metadata, ...(trial && { trialDiagnostics: { schemaVersion: 1 as const } }),
  });
  else await writeFile(path.join(runtime, 'manifest.json'), JSON.stringify({ schemaVersion: 1, ...metadata }));
  const slot = 'zzb-runtime-' + sha(await readFile(path.join(runtime, 'manifest.json')));
  const bytes = Buffer.from('synthetic-zzb ' + name + (embedded ? ' ' + slot : ''));
  await writeFile(path.join(directory, exe), bytes);
  return { directory, runtime, bytes, slot };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(base, 'zzb-portable-upgrade-'));
  destination = path.join(root, '自选应用位置', 'ZZ Board');
  env = { LOCALAPPDATA: path.join(root, 'profile', 'local'), USERPROFILE: path.join(root, 'profile') };
});

afterEach(async () => {
  if (path.dirname(root) !== base || !path.basename(root).startsWith('zzb-portable-upgrade-') || (await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw new Error('Unsafe synthetic fixture cleanup.');
  await rm(root, { recursive: true });
});

describe('offline fixed-path portable installation', () => {
  it('previews without writing, remembers a custom directory and keeps exactly two generations across same-version updates', async () => {
    const a = await fixture('package-A'), b = await fixture('package-B'), c = await fixture('package-C');
    const first = await installPortable({ ...options(a.directory), apply: false });
    expect(first.changed).toBe(true);
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(env.USERPROFILE)).rejects.toMatchObject({ code: 'ENOENT' });
    await installPortable(options(a.directory));
    expect(await defaultInstallDirectory(env)).toBe(destination);
    await mkdir(path.join(destination, '.local-data'));
    await writeFile(path.join(destination, '.local-data', 'keep.txt'), 'user data');
    await writeFile(path.join(destination, 'other.txt'), 'unrelated');
    await installPortable({ ...options(b.directory), installDir: undefined });
    expect(await readFile(path.join(destination, previous))).toEqual(a.bytes);
    await installPortable(options(c.directory));
    const stable = path.join(destination, exe);
    expect(await readFile(stable)).toEqual(c.bytes);
    expect((await runtimeForExecutable(stable)).name).toBe(c.slot);
    expect(await readFile(path.join(destination, previous))).toEqual(b.bytes);
    expect(await readdir(path.join(destination, 'resources'))).toEqual([b.slot, c.slot].sort());
    const before = await lstat(stable);
    expect((await installPortable(options(c.directory))).changed).toBe(false);
    expect((await lstat(stable)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(path.join(destination, '.local-data', 'keep.txt'), 'utf8')).toBe('user data');
    expect(await readFile(path.join(destination, 'other.txt'), 'utf8')).toBe('unrelated');
  });

  it.each([1, 2])('takes over an original schema-%s ZIP beside its local board', async (schema) => {
    const legacy = await fixture('old', schema, false), fresh = await fixture('new'), latest = await fixture('latest');
    await writeFile(path.join(legacy.runtime, '.gitkeep'), '\n');
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(legacy.directory, destination, { recursive: true });
    await mkdir(path.join(destination, '.local-data'));
    await writeFile(path.join(destination, '.local-data', 'keep.db'), 'synthetic content');
    await installPortable(options(fresh.directory));
    expect((await runtimeForExecutable(path.join(destination, previous))).name).toBe('runtime');
    await installPortable(options(latest.directory));
    expect(await readFile(path.join(destination, '.local-data', 'keep.db'), 'utf8')).toBe('synthetic content');
    const canonical = path.join(destination, 'resources', 'runtime');
    if (schema === 1) expect((await lstat(canonical)).isDirectory()).toBe(true);
    else await expect(lstat(canonical)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('finishes a recorded cleanup containing only a packaging placeholder and preserves a customized one', async () => {
    const a = await fixture('A'), b = await fixture('B');
    await installPortable(options(a.directory));
    const leftover = path.join(destination, 'resources', b.slot);
    await mkdir(leftover);
    const lock = new DatabaseSync(path.join(destination, installDatabase));
    try { lock.prepare('INSERT INTO slots(name,digest) VALUES(?,?)').run(b.slot, b.slot); } finally { lock.close(); }
    await writeFile(path.join(leftover, '.gitkeep'), 'user content');
    expect((await installPortable(options(a.directory))).retained).toContain(leftover);
    expect(await readFile(path.join(leftover, '.gitkeep'), 'utf8')).toBe('user content');
    await writeFile(path.join(leftover, '.gitkeep'), '\r\n');
    expect((await installPortable(options(a.directory))).retained).toEqual([]);
    await expect(lstat(leftover)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a mismatched pair, tampering, a running target and an unrelated EXE without switching the old program', async () => {
    const a = await fixture('A'), b = await fixture('B');
    await installPortable(options(a.directory));
    await expect(installPortable({ ...options(b.directory), ensureStopped: () => { throw new Error('running'); } })).rejects.toThrow('running');
    await copyFile(path.join(a.directory, exe), path.join(b.directory, exe));
    await expect(installPortable(options(b.directory))).rejects.toThrow(/匹配/);
    await writeFile(path.join(b.directory, exe), b.bytes);
    await writeFile(path.join(b.runtime, 'server.cjs'), 'changed');
    await expect(installPortable(options(b.directory))).rejects.toThrow(/Changed runtime/);
    expect(await readFile(path.join(destination, exe))).toEqual(a.bytes);
    await writeFile(path.join(destination, exe), Buffer.from('unrelated program ' + a.slot));
    await expect(installPortable(options(a.directory))).rejects.toThrow(/产品版本/);
    expect(await readFile(path.join(destination, exe), 'utf8')).toContain('unrelated program');
  });

  it('suggests the previously bound classic portable folder on its first upgrade and then honors an explicit new choice', async () => {
    const legacy = await fixture('previously pinned', 1, false), fresh = await fixture('fresh');
    const bindingDir = path.join(env.USERPROFILE, '.codex');
    await mkdir(bindingDir, { recursive: true });
    await writeFile(path.join(bindingDir, 'zz-board.json'), JSON.stringify({ desktopExecutable: path.join(legacy.directory, exe) }));
    expect(await defaultInstallDirectory(env, checkVersion)).toBe(legacy.directory);
    await installPortable(options(fresh.directory));
    expect(await defaultInstallDirectory(env, checkVersion)).toBe(destination);
  });

  it('holds the install lock across recorded commits and preserves a modified older resource directory', async () => {
    const a = await fixture('A'), b = await fixture('B'), c = await fixture('C');
    await installPortable(options(a.directory));
    const locker = new DatabaseSync(path.join(destination, installDatabase));
    try {
      locker.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT');
      await expect(installPortable(options(b.directory))).rejects.toThrow(/另一个更新/);
    } finally { locker.close(); }
    await installPortable(options(b.directory));
    const custom = path.join(destination, 'resources', a.slot, 'user-file.txt');
    await writeFile(custom, 'unrelated');
    const result = await installPortable(options(c.directory));
    expect(result.retained).toContain(path.dirname(custom));
    expect(await readFile(custom, 'utf8')).toBe('unrelated');
  });

  it('recovers a prepared update before or after the atomic EXE switch', async () => {
    const a = await fixture('A'), b = await fixture('B'), c = await fixture('C');
    await installPortable(options(a.directory));
    // Model an abrupt exit after durable ownership, resource publication and
    // rollback backup, before the final EXE rename.
    const lock = new DatabaseSync(path.join(destination, installDatabase));
    try {
      lock.prepare('INSERT INTO slots(name,digest) VALUES(?,?)').run(b.slot, b.slot);
      lock.prepare('INSERT INTO backup(hash) VALUES(?)').run(sha(a.bytes));
    } finally { lock.close(); }
    await cp(b.runtime, path.join(destination, 'resources', b.slot), { recursive: true });
    await copyFile(path.join(destination, exe), path.join(destination, previous));
    await installPortable(options(b.directory));
    expect(await readFile(path.join(destination, exe))).toEqual(b.bytes);
    // The same durable ownership still permits retry after the switch.
    expect((await installPortable(options(b.directory))).changed).toBe(false);
    await installPortable(options(c.directory));
    expect(await readdir(path.join(destination, 'resources'))).toEqual([b.slot, c.slot].sort());
  });

  it('declines a missing registered drive, unrelated directories, nested installs and mixed NSIS targets', async () => {
    const a = await fixture('A');
    await installPortable(options(a.directory));
    await rename(destination, destination + '-disconnected');
    await expect(defaultInstallDirectory(env)).rejects.toThrow(/暂不可用/);
    await mkdir(destination);
    await writeFile(path.join(destination, 'notes.txt'), 'original');
    await expect(installPortable(options(a.directory))).rejects.toThrow(/其他文件/);
    await expect(installPortable({ ...options(a.directory), installDir: path.join(a.directory, 'install') })).rejects.toThrow(/独立于下载包/);
    await writeFile(path.join(destination, 'uninstall.exe'), 'synthetic NSIS');
    await expect(installPortable(options(a.directory))).rejects.toThrow(/setup/);
  });
});

describe('source build deployment and offline recovery', () => {
  const offline = async () => ({ state: 'offline' });
  const writeReceipt = async (source: string, build: string) => writeBuildReceipt(source, build, await sourceIdentity(source), checkVersion);
  const install = (source: string, build: string, probe = offline) => deployBuild(build, source, destination, env, { versionOf: checkVersion, ensureStopped() {}, probe });
  const rollback = () => rollbackPortable({ directory: destination, env, versionOf: checkVersion, ensureStopped() {}, checkRecovery: (old: unknown, checkpoint: unknown, dir: string) => checkRecovery(old, checkpoint, dir, env, offline) });
  async function sourceFixture() {
    const source = path.join(root, '源码');
    await mkdir(path.join(source, 'src'), { recursive: true });
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'zz-board', version }));
    await writeFile(path.join(source, 'src', 'app.ts'), 'synthetic first version');
    return source;
  }
  it('selects an isolated trial from its build receipt and reuses only its matching live service', async () => {
    const source = await sourceFixture(), build = await fixture('trial-build', 2, true, true);
    await writeBuildReceipt(source, build.directory, await sourceIdentity(source), checkVersion, true);
    const target = path.join(env.LOCALAPPDATA, 'Programs', 'ZZ Board Trial');
    const plans = { versionOf: checkVersion, ensureStopped() {}, probe: offline };
    expect((await trialInstallTarget(source, undefined, env)).directory).toBe(target);
    await expect(lstat(env.USERPROFILE)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await deployBuild(build.directory, source, undefined, env, plans)).toMatchObject({ trial: true, changed: true });
    const { paths, result } = await readStatus(target, env, checkVersion);
    expect(result).toMatchObject({ trial: true, dataDir: path.join(target, '.local-data'), sourceState: 'matches-build-inputs' });
    expect(await statusDirectory(undefined, env)).toBe(target);
    const health = { state: 'responding', ok: true, appVersion: version, dataStoreId: paths.dataStoreId, runtime: 'desktop-sidecar', packagedRuntime: build.slot };
    expect(await deployBuild(build.directory, source, undefined, env, { ...plans, probe: async () => health })).toMatchObject({ mode: 'already-installed', trial: true, changed: false });
    await expect(deployBuild(build.directory, source, undefined, env, { ...plans, probe: async () => ({ ...health, dataStoreId: 'another-store' }) })).rejects.toMatchObject({ code: 'port_conflict' });
    const log = await readFile(path.join(source, '.tmp', 'zz-board-trial', 'setup.jsonl'), 'utf8');
    const events = log.trim().split('\n').map(line => JSON.parse(line));
    expect(events.map(event => event.outcome)).toEqual(['start', 'ok', 'start', 'ok', 'start', 'blocked']);
    expect(events.every(event => event.event === 'install' && event.layer === 'setup' && event.schemaVersion === 1)).toBe(true);
    expect(events.at(-1)).toMatchObject({ code: 'port_conflict' });
    expect(log).not.toContain('another-store');
    expect(log).not.toContain('ZZ Board Trial');
  });

  it('prevents a trial from taking over a regular installation, a local data directory, or an unrelated listener', async () => {
    const source = await sourceFixture(), trial = await fixture('trial-build', 2, true, true), ordinary = await fixture('regular-build');
    await writeReceipt(source, trial.directory);
    const target = path.join(env.LOCALAPPDATA, 'Programs', 'ZZ Board Trial');
    const plans = { versionOf: checkVersion, ensureStopped() {}, probe: offline };
    await expect(deployBuild(trial.directory, source, undefined, env, { ...plans, probe: async () => ({ state: 'unrecognized' }) })).rejects.toMatchObject({ code: 'port_conflict' });
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(deployBuild(trial.directory, source, undefined, { ...env, ZZ_BOARD_DATA_DIR: path.join(root, 'existing-data') }, plans)).rejects.toMatchObject({ code: 'existing_installation' });
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'keep.txt'), 'another application');
    await expect(trialInstallTarget(source, undefined, env)).rejects.toMatchObject({ code: 'existing_installation' });
    await installPortable(options(ordinary.directory));
    const original = await readFile(path.join(destination, exe));
    await expect(deployBuild(trial.directory, source, undefined, env, plans)).rejects.toMatchObject({ code: 'existing_installation' });
    expect(await readFile(path.join(destination, exe))).toEqual(original);
    expect(await readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('another application');
  });

  it('requires agreement between the requested receipt mode and the matching resource marker', async () => {
    const source = await sourceFixture(), trial = await fixture('trial-build', 2, true, true);
    await expect(writeBuildReceipt(source, trial.directory, await sourceIdentity(source), checkVersion, false)).rejects.toThrow(/诊断模式/);
    await expect(installPortable(options(trial.directory))).rejects.toThrow(/诊断模式/);
    const receiptFile = await writeReceipt(source, trial.directory);
    const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
    await writeFile(receiptFile, JSON.stringify({ ...receipt, trial: false }));
    await expect(install(source, trial.directory)).rejects.toThrow(/诊断模式/);
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ties the installed EXE to actual source bytes and detects drift, including bundled guides', async () => {
    const source = await sourceFixture(), a = await fixture('checked-build');
    await expect(install(source, a.directory)).rejects.toThrow(/缺少/);
    await writeReceipt(source, a.directory);
    await writeFile(path.join(a.directory, exe), Buffer.concat([a.bytes, Buffer.from('changed')]));
    await expect(install(source, a.directory)).rejects.toThrow(/不一致/);
    await writeFile(path.join(a.directory, exe), a.bytes);
    await install(source, a.directory);
    expect((await readStatus(destination, env, checkVersion)).result).toMatchObject({ sourceState: 'matches-build-inputs', executableSha256: sha(a.bytes), source: { root: source }, installed: true });
    await mkdir(path.join(source, 'docs'));
    await writeFile(path.join(source, 'docs', 'USER_AGENT_GUIDE.md'), 'updated embedded guide');
    await expect(install(source, a.directory)).rejects.toThrow(/源码/);
    expect((await readStatus(destination, env, checkVersion)).result.sourceState).toBe('changed');
    await rename(source, source + '-moved');
    expect((await readStatus(destination, env, checkVersion)).result.sourceState).toBe('unavailable');
  });
  it('binds the active managed build from its own checkout, including a tray-only instance, and keeps an existing binding byte-for-byte', async () => {
    const source = await sourceFixture(), a = await fixture('bind-build');
    await writeReceipt(source, a.directory);
    await install(source, a.directory);
    expect(await statusDirectory(undefined, env)).toBe(destination);
    const status = await readStatus(destination, env, checkVersion);
    const { paths } = status;
    const process = { matches: true, visible: false, pid: 73 };
    const health = { state: 'responding', ok: true, appVersion: version, dataStoreId: paths.dataStoreId, runtime: 'desktop-sidecar', packagedRuntime: a.slot };
    const live = liveState(status.app, paths, [process], health);
    expect(live.ready).toBe(false);
    const results = await Promise.all([1, 2].map(() => bindCodex(source, status, live, env)));
    expect(results.map(result => result.bindingCreated).sort()).toEqual([false, true]);
    const bindingFile = path.join(env.USERPROFILE, '.codex', 'zz-board.json');
    const expected = { schemaVersion: 1, projectRoot: source, dataDir: paths.dataDir, desktopExecutable: path.join(destination, exe), boardUrl: 'http://127.0.0.1:4318' };
    expect(JSON.parse(await readFile(bindingFile, 'utf8'))).toEqual(expected);
    expect(await readdir(path.dirname(bindingFile))).toEqual(['zz-board.json']);
    const styled = JSON.stringify({ ...expected, keep: 'local metadata' });
    await writeFile(bindingFile, styled);
    const current = await readStatus(destination, env, checkVersion);
    expect((await bindCodex(source, current, live, env)).bindingCreated).toBe(false);
    expect(await readFile(bindingFile, 'utf8')).toBe(styled);
  });
  it('refuses mismatched source, processes and health and preserves malformed or conflicting bindings', async () => {
    const source = await sourceFixture(), a = await fixture('bind-guard-build');
    await writeReceipt(source, a.directory);
    await install(source, a.directory);
    const status = await readStatus(destination, env, checkVersion);
    const { app, paths } = status;
    const process = { matches: true, visible: true, pid: 73 };
    const health = { state: 'responding', ok: true, appVersion: version, dataStoreId: paths.dataStoreId, runtime: 'desktop-sidecar', packagedRuntime: a.slot };
    const live = liveState(app, paths, [process], health);
    const bindingFile = path.join(env.USERPROFILE, '.codex', 'zz-board.json');
    await expect(bindCodex(path.join(root, 'another-checkout'), status, live, env)).rejects.toThrow(/源码/);
    await expect(bindCodex(source, { ...status, receipt: { ...status.receipt, slot: 'other' } }, live, env)).rejects.toThrow(/源码/);
    await expect(bindCodex(source, status, liveState(app, paths, [], health), env)).rejects.toThrow(/启动/);
    await expect(bindCodex(source, status, liveState(app, paths, [process, { ...process, matches: false }], health), env)).rejects.toThrow(/启动/);
    await expect(bindCodex(source, status, liveState(app, paths, [process], { ...health, dataStoreId: 'other' }), env)).rejects.toThrow(/健康/);
    await expect(bindCodex(source, status, liveState(app, paths, [process], { ...health, packagedRuntime: 'other' }), env)).rejects.toThrow(/健康/);
    await writeFile(path.join(source, 'src', 'app.ts'), 'updated source');
    await expect(bindCodex(source, await readStatus(destination, env, checkVersion), live, env)).rejects.toThrow(/源码/);
    await expect(lstat(bindingFile)).rejects.toMatchObject({ code: 'ENOENT' });

    await mkdir(path.dirname(bindingFile), { recursive: true });
    await writeFile(bindingFile, 'broken JSON');
    await expect(bindCodex(source, status, live, env)).rejects.toThrow(/绑定无效/);
    expect(await readFile(bindingFile, 'utf8')).toBe('broken JSON');
    const conflict = JSON.stringify({ schemaVersion: 1, projectRoot: source, dataDir: paths.dataDir, desktopExecutable: path.join(root, exe), boardUrl: 'http://127.0.0.1:4318' });
    await writeFile(bindingFile, conflict);
    await expect(bindCodex(source, status, live, env)).rejects.toThrow(/绑定与选定/);
    expect(await readFile(bindingFile, 'utf8')).toBe(conflict);
    const misplaced = path.join(root, 'directory-binding-profile');
    const misplacedFile = path.join(misplaced, '.codex', 'zz-board.json');
    await mkdir(misplacedFile, { recursive: true });
    await writeFile(path.join(misplacedFile, 'keep'), 'untouched');
    await expect(bindCodex(source, status, live, { ...env, USERPROFILE: misplaced })).rejects.toThrow(/绑定无效/);
    expect(await readFile(path.join(misplacedFile, 'keep'), 'utf8')).toBe('untouched');
  });
  it.skipIf(process.platform !== 'win32')('keeps the development fallback for an unregistered Skill sync and defers to the verified binding command when registered', async () => {
    const bindingFile = path.join(env.USERPROFILE, '.codex', 'zz-board.json');
    const run = (profile = env) => execFileSync(process.execPath, ['scripts/sync-skill.mjs', '--apply'], { env: { ...process.env, ...profile }, encoding: 'utf8' });
    expect(run()).toContain('local development binding');
    const development = await readFile(bindingFile, 'utf8');
    expect(JSON.parse(development).desktopExecutable).toBe(path.resolve('src-tauri/target/release', exe));
    const a = await fixture('stable-install');
    await installPortable(options(a.directory));
    expect(run()).toContain('existing local binding');
    expect(await readFile(bindingFile, 'utf8')).toBe(development);

    const cleanProfile = { ...env, USERPROFILE: path.join(root, 'other-profile') };
    expect(run(cleanProfile)).toContain('pnpm setup:windows -- -BindCodex');
    await expect(lstat(path.join(cleanProfile.USERPROFILE, '.codex', 'zz-board.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([1, 2])('upgrades a schema-%i legacy app, pairs complete backup including drafts, refuses migrated data, and restores only after a byte match', async schema => {
    const source = await sourceFixture(), a = await fixture('original', schema, false), b = await fixture('replacement');
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(a.directory, destination, { recursive: true });
    const dataDir = path.join(root, 'bound-data'), binding = path.join(env.USERPROFILE, '.codex');
    await mkdir(binding, { recursive: true });
    await writeFile(path.join(binding, 'zz-board.json'), JSON.stringify({ schemaVersion: 1, desktopExecutable: path.join(destination, exe), dataDir, projectRoot: source, boardUrl: 'http://127.0.0.1:4318' }));
    expect(await statusDirectory(undefined, env)).toBe(destination);
    await mkdir(path.join(dataDir, 'media'), { recursive: true });
    await mkdir(path.join(dataDir, 'webview'));
    await writeFile(path.join(dataDir, 'webview', 'draft'), '旧草稿');
    await writeFile(path.join(dataDir, 'zz-board.sqlite'), 'synthetic old database');
    await writeReceipt(source, b.directory);
    await expect(install(source, b.directory, async () => ({ state: 'responding' }))).rejects.toThrow(/4318/);
    expect(await readFile(path.join(destination, exe))).toEqual(a.bytes);
    const result = await install(source, b.directory);
    const backup = result.recovery.backupDir;
    expect(await readFile(path.join(backup, 'webview', 'draft'), 'utf8')).toBe('旧草稿');
    expect((await lstat(path.join(backup, 'media'))).isDirectory()).toBe(true);
    await writeFile(path.join(dataDir, 'zz-board.sqlite'), 'synthetic migrated database');
    await expect(rollback()).rejects.toThrow(/尚未回退/);
    expect(await readFile(path.join(destination, exe))).toEqual(b.bytes);
    await rename(dataDir, dataDir + '-newer');
    await cp(backup, dataDir, { recursive: true });
    await writeFile(path.join(backup, 'webview', 'draft'), 'changed backup');
    await expect(rollback()).rejects.toThrow(/备份缺失或内容有变化/);
    await writeFile(path.join(backup, 'webview', 'draft'), '旧草稿');
    expect((await rollback()).mode).toBe('rolled-back');
    expect(await readFile(path.join(destination, exe))).toEqual(a.bytes);
    expect((await rollback()).mode).toBe('already-rolled-back');
    expect((await readStatus(destination, env, checkVersion)).result.sourceState).toBe('unknown');
    expect(await readFile(path.join(dataDir + '-newer', 'zz-board.sqlite'), 'utf8')).toBe('synthetic migrated database');
  });
  it('distinguishes other desktops, tray-only, version/store/slot mismatches and complete readiness', async () => {
    const paths = await deploymentPaths(destination, env);
    const app = { version, slot: 'zzb-runtime-' + 'f'.repeat(64) };
    const health = { state: 'responding', ok: true, appVersion: version, dataStoreId: paths.dataStoreId, runtime: 'desktop-sidecar', packagedRuntime: app.slot };
    const p = { matches: true, visible: true, pid: 42 };
    expect(liveState(app, paths, [], health)).toMatchObject({ processRunning: false, matchingHealth: true, ready: false });
    expect(liveState(app, paths, [{ ...p, matches: false }], health)).toMatchObject({ visibleWindow: false, ready: false });
    expect(liveState(app, paths, [{ ...p, visible: false }], health)).toMatchObject({ processRunning: true, visibleWindow: false, ready: false });
    for (const change of [{ state: 'offline' }, { ok: false }, { appVersion: '0.0.1' }, { dataStoreId: 'other' }, { runtime: 'web-fallback' }, { packagedRuntime: 'different-same-version-build' }]) {
      expect(liveState(app, paths, [p], { ...health, ...change })).toMatchObject({ processRunning: true, visibleWindow: true, ready: false });
    }
    expect(liveState(app, paths, [p], health).ready).toBe(true);
  });
});
