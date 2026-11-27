import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, copyFile, link, lstat, mkdir, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { checkPath, defaultInstallDirectory, deploymentEvidence, inspect, installPortable, registeredDirectory, rollbackPortable, targetState } from './install-portable.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const ownRoot = path.resolve(scriptDir, '..');
const boardUrl = 'http://127.0.0.1:4318';
const receiptName = 'zz-board-build.local.json';
const hash = value => createHash('sha256').update(value).digest('hex');
const key = file => path.resolve(file).replaceAll('\\', '/').toLowerCase();
const same = (a, b) => key(a) === key(b);
const atOrBelow = (parent, child) => key(child) === key(parent) || key(child).startsWith(key(parent).replace(/\/$/, '') + '/');

async function fileHash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

// Hash file bytes and empty directories. A link cannot redirect a private
// backup or a source fingerprint outside the selected tree.
async function inventory(directory, names) {
  const rows = [];
  async function visit(file, relative, optional) {
    let st;
    try { st = await lstat(file); } catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
    if (st.isSymbolicLink()) throw new Error('目录中含有链接，停止复制或校验：' + file);
    if (st.isFile()) { rows.push([relative, await fileHash(file)]); return; }
    if (!st.isDirectory()) throw new Error('目录中含有不支持的文件：' + file);
    rows.push([relative, null]);
    for (const name of (await readdir(file)).sort()) await visit(path.join(file, name), relative ? relative + '/' + name : name, false);
  }
  await checkPath(directory);
  if (names) {
    for (const relative of [...names].sort()) await visit(path.join(directory, ...relative.split('/')), relative, true);
  } else await visit(directory, '', false);
  return { rows, digest: hash(JSON.stringify(rows)) };
}

// Exclude generated outputs, private board data, credentials and dependencies.
const sourceInputs = [
  'src', 'public', 'scripts', 'index.html', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'tsconfig.json', 'tsconfig.server.json', 'vite.config.ts', 'docs/USER_AGENT_GUIDE.md', 'docs/AGENT_CUSTOMIZATION.md',
  'src-tauri/src', 'src-tauri/.cargo', 'src-tauri/icons', 'src-tauri/nsis', 'src-tauri/capabilities',
  'src-tauri/build.rs', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/windows-upgrade.nsh',
];
export async function sourceIdentity(root) {
  if (!(await checkPath(path.join(root, 'package.json')))?.isFile()) throw new Error('找不到源码目录：' + root);
  const { rows, digest } = await inventory(root, sourceInputs);
  const git = args => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  const top = git(['rev-parse', '--show-toplevel']);
  let head = null, dirty = null;
  if (top.status === 0 && same(root, top.stdout.trim())) {
    const sha = git(['rev-parse', 'HEAD']), changes = git(['status', '--porcelain', '--untracked-files=normal']);
    head = /^[a-f0-9]{40}$/.test(sha.stdout?.trim()) ? sha.stdout.trim() : null;
    dirty = changes.status === 0 ? Boolean(changes.stdout.trim()) : null;
  }
  return { root, buildInputsSha256: digest, inputFiles: rows.filter(row => row[1]).length, gitHead: head, gitDirty: dirty };
}

export async function writeBuildReceipt(root, directory, before, versionOf, expectedTrial) {
  const after = await sourceIdentity(root);
  if (after.buildInputsSha256 !== before.buildInputsSha256 || !same(root, before.root)) throw new Error('构建过程中源码发生了变化。请用独立目标重新构建。');
  const app = await inspect(directory, versionOf, true);
  if (expectedTrial !== undefined && app.trial !== expectedTrial) throw new Error('构建产物的诊断模式与本次构建不一致。');
  const result = { schemaVersion: 1, source: after, checkedAt: new Date().toISOString(), version: app.version, exeHash: app.exeHash, slot: app.slot, trial: app.trial };
  const target = path.join(directory, receiptName);
  await writeFile(target, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return target;
}

async function readCodexBinding(file) {
  const entry = await checkPath(file);
  if (!entry) return null;
  const invalid = () => new Error('本机 ZZ Board 绑定无效，请检查 ' + file);
  if (!entry.isFile()) throw invalid();
  let binding;
  try { binding = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw invalid(); }
  if (binding?.schemaVersion !== 1 || binding.boardUrl !== boardUrl ||
    ![binding.projectRoot, binding.dataDir, binding.desktopExecutable].every(p => typeof p === 'string' && path.isAbsolute(p))) {
    throw invalid();
  }
  return binding;
}

export async function deploymentPaths(directory, env = process.env) {
  const executable = path.join(directory, 'zz-board.exe');
  const file = env.USERPROFILE && path.join(env.USERPROFILE, '.codex', 'zz-board.json');
  const binding = file ? await readCodexBinding(file) : null;
  let inferred = directory;
  if (/^(release|debug)$/.test(path.basename(directory)) && path.basename(path.dirname(directory)) === 'target' && path.basename(path.resolve(directory, '../..')) === 'src-tauri') inferred = path.resolve(directory, '../../..');
  const projectRoot = path.resolve(binding?.projectRoot || env.ZZ_BOARD_PROJECT_ROOT || inferred);
  const dataDir = path.resolve(binding?.dataDir || env.ZZ_BOARD_DATA_DIR || path.join(projectRoot, '.local-data'));
  if (same(dataDir, path.parse(dataDir).root) || [env.USERPROFILE, env.LOCALAPPDATA, env.SystemRoot, executable, ownRoot].some(target => target && atOrBelow(dataDir, target))) throw new Error('数据目录范围过大或覆盖程序目录，请检查绑定。');
  return { executable, projectRoot, dataDir, dataStoreId: hash(key(dataDir)).slice(0, 16), webviewDir: path.join(dataDir, 'webview'), bindingFile: binding ? file : null, boundExecutable: binding?.desktopExecutable || null };
}

export async function healthProbe() {
  try {
    const response = await fetch(boardUrl + '/api/health', { signal: AbortSignal.timeout(1400), redirect: 'error' });
    if (!response.ok) return { state: 'unrecognized' };
    const data = await response.json();
    return { state: 'responding', ok: data.ok, appVersion: data.appVersion, dataStoreId: data.dataStoreId, runtime: data.runtime, packagedRuntime: data.packagedRuntime ?? null };
  } catch (error) { return { state: error.cause?.code === 'ECONNREFUSED' ? 'offline' : 'unrecognized' }; }
}

function deploymentBlocked(code, message) {
  return Object.assign(new Error(message), { code });
}

function portConflict() {
  return deploymentBlocked('port_conflict', '本机 4318 仍有服务，或无法确认端口已释放。保存工作，真正退出桌面及独立本地服务后重试。');
}

async function requireOffline(probe = healthProbe) {
  if ((await probe()).state !== 'offline') throw portConflict();
}

async function writeSetupEvent(root, event, outcome, started, code) {
  const file = path.join(root, '.tmp', 'zz-board-trial', 'setup.jsonl');
  try {
    await checkPath(file);
    await mkdir(path.dirname(file), { recursive: true });
    await checkPath(file);
    const entry = { schemaVersion: 1, at: new Date().toISOString(), layer: 'setup', event, outcome,
      ...(started !== undefined && { elapsedMs: Math.max(0, Date.now() - started) }), ...(code && { code }) };
    await appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    console.error('试用诊断未能记录本次部署操作，请检查源码目录下 .tmp/zz-board-trial 的写入权限。');
  }
}

async function logTrialStage(enabled, root, event, operation) {
  if (!enabled) return operation();
  const started = Date.now();
  await writeSetupEvent(root, event, 'start');
  try {
    const result = await operation();
    const failed = event === 'start' && !result.ready;
    await writeSetupEvent(root, event, failed ? 'failed' : 'ok', started, failed ? 'start_failed' : undefined);
    return result;
  } catch (error) {
    const blocked = ['port_conflict', 'existing_installation'].includes(error?.code);
    await writeSetupEvent(root, event, blocked ? 'blocked' : 'failed', started, blocked ? error.code : event + '_failed');
    throw error;
  }
}

// Data copies live on the same drive, outside the live tree. Never replace or
// remove the user's data. Restoring a modified tree is a deliberate offline step.
export async function prepareRecovery(old, directory, env, probe) {
  await requireOffline(probe);
  const { dataDir } = await deploymentPaths(directory, env);
  await checkPath(dataDir);
  const checkpoint = { dataDir, dataExisted: Boolean(await checkPath(dataDir)), backupDir: null, dataSha256: null, oldSlot: old.slot, oldRuntimeSha256: old.schema === 1 ? (await inventory(old.directory)).digest : null };
  if (checkpoint.dataExisted) {
    const original = await inventory(dataDir);
    const backup = path.join(path.dirname(dataDir), '.zz-board-before-update-' + randomUUID());
    await mkdir(backup);
    for (const [name, digest] of original.rows) {
      if (!name) continue;
      const target = path.join(backup, ...name.split('/'));
      if (digest === null) await mkdir(target);
      else await copyFile(path.join(dataDir, ...name.split('/')), target);
    }
    if ((await inventory(backup)).digest !== original.digest || (await inventory(dataDir)).digest !== original.digest) throw new Error('备份期间数据发生变化，程序尚未替换。请保留并检查此次复制：' + backup);
    Object.assign(checkpoint, { backupDir: backup, dataSha256: original.digest });
  }
  await requireOffline(probe);
  return checkpoint;
}

export async function checkRecovery(previous, checkpoint, directory, env, probe) {
  await requireOffline(probe);
  const { dataDir } = await deploymentPaths(directory, env);
  if (!same(dataDir, checkpoint.dataDir) || previous.slot !== checkpoint.oldSlot || (previous.schema === 1 && (await inventory(previous.directory)).digest !== checkpoint.oldRuntimeSha256)) throw new Error('实际绑定、数据位置或上一版资源与升级前记录不符。');
  const st = await checkPath(dataDir);
  if (checkpoint.dataExisted) {
    if (!checkpoint.backupDir || !(await checkPath(checkpoint.backupDir))?.isDirectory() || (await inventory(checkpoint.backupDir)).digest !== checkpoint.dataSha256) throw new Error('升级前备份缺失或内容有变化，停止回退。');
    if (!st?.isDirectory() || (await inventory(dataDir)).digest !== checkpoint.dataSha256) throw new Error('程序尚未回退。真正退出后，将当前完整数据目录另存保留，再把备份目录的完整副本放回原路径。原路径：' + dataDir + '，备份：' + checkpoint.backupDir + '。然后重新运行 -Rollback。');
  } else if (st) throw new Error('程序尚未回退。升级前没有这个数据目录，请先退出并将当前完整数据目录另存到其他位置后重试：' + dataDir);
  await requireOffline(probe);
}

function session(action, executable) {
  const host = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const output = execFileSync(host, ['-NoProfile', '-NonInteractive', '-File', path.join(scriptDir, 'desktop-session.ps1'), '-Action', action, '-Executable', executable], { encoding: 'utf8', windowsHide: true });
  return action === 'Observe' ? JSON.parse(output) : undefined;
}

function matchesHealth(app, paths, health) {
  return Boolean(app && health.state === 'responding' && health.ok === true && health.appVersion === app.version &&
    health.dataStoreId === paths.dataStoreId && health.runtime === 'desktop-sidecar' && health.packagedRuntime === app.slot);
}

export function liveState(app, paths, processes, health) {
  const pids = processes.filter(p => p.matches).map(p => p.pid);
  const matchingHealth = matchesHealth(app, paths, health);
  const visibleWindow = processes.some(p => p.matches && p.visible);
  return { processRunning: pids.length > 0, processIds: pids, visibleWindow, otherDesktopProcesses: processes.filter(p => !p.matches), matchingHealth, health, ready: pids.length > 0 && visibleWindow && matchingHealth };
}

export async function readStatus(directory, env = process.env, versionOf) {
  const paths = await deploymentPaths(directory, env);
  const app = (await checkPath(paths.executable))?.isFile() ? await inspect(directory, versionOf) : null;
  const evidence = app ? await deploymentEvidence(directory, app.exeHash) : {};
  let sourceState = 'unknown';
  if (evidence.source) {
    try {
      const now = await sourceIdentity(evidence.source.source.root);
      sourceState = now.buildInputsSha256 === evidence.source.source.buildInputsSha256 ? 'matches-build-inputs' : 'changed';
    } catch { sourceState = 'unavailable'; }
  }
  return {
    app, paths, receipt: evidence.source,
    result: { ...paths, installed: Boolean(app), trial: app?.trial ?? false, version: app?.version ?? null, executableSha256: app?.exeHash ?? null, runtimeSlot: app?.slot ?? null, source: evidence.source?.source ?? null, sourceState, recovery: evidence.recovery ?? null },
  };
}

// Publish the complete JSON at once while giving any concurrent writer priority.
export async function writeNewCodexBinding(file, binding) {
  if (await checkPath(file)) return false;
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  await checkPath(directory);
  const temporary = path.join(directory, '.zz-board-binding-' + randomUUID() + '.tmp');
  const entry = await open(temporary, 'wx');
  try {
    try {
      await entry.writeFile(JSON.stringify(binding, null, 2) + '\n', 'utf8');
      await entry.sync();
    } finally { await entry.close(); }
    try { await link(temporary, file); }
    catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
    return true;
  } finally { await unlink(temporary); }
}

export async function bindCodex(root, { app, paths, receipt, result }, live, env = process.env) {
  if (!env.USERPROFILE || !path.isAbsolute(env.USERPROFILE)) throw new Error('找不到当前 Windows 用户的配置目录。');
  const bindingFile = path.join(env.USERPROFILE, '.codex', 'zz-board.json');
  const binding = { schemaVersion: 1, projectRoot: root, dataDir: paths.dataDir, desktopExecutable: paths.executable, boardUrl };
  const matches = value => value && same(value.projectRoot, root) && same(value.dataDir, binding.dataDir) && same(value.desktopExecutable, binding.desktopExecutable);
  const conflict = () => new Error('已有 Codex 绑定与选定的源码、程序或数据不一致，请先核对：' + bindingFile);
  const existing = await readCodexBinding(bindingFile);
  if (existing ? !matches(existing) : paths.bindingFile) throw conflict();
  if (!app || receipt?.schemaVersion !== 1 || receipt.exeHash !== app.exeHash || receipt.version !== app.version ||
    receipt.slot !== app.slot || result.sourceState !== 'matches-build-inputs' || !result.source?.root || !same(result.source.root, root)) {
    throw new Error('请从当前已部署构建对应的源码目录运行 -BindCodex。可用 -Status 查看来源。');
  }
  if (!live.processRunning || !live.matchingHealth || live.otherDesktopProcesses.length) {
    throw new Error('请先启动该安装并确认健康检查匹配，再建立 Codex 绑定。');
  }
  if (existing) return { bindingFile, bindingCreated: false, ...binding };
  const bindingCreated = await writeNewCodexBinding(bindingFile, binding);
  if (!bindingCreated && !matches(await readCodexBinding(bindingFile))) throw conflict();
  return { bindingFile, bindingCreated, ...binding };
}

// Trial installs may create a separate portable registration in a fresh Windows profile.
// A previously installed trial may be resumed from its original source and data location.
export async function trialInstallTarget(root, installDir, env = process.env, versionOf) {
  const conflict = detail => deploymentBlocked('existing_installation', detail + ' 请在独立 Windows 用户中试用。');
  if (![env.USERPROFILE, env.LOCALAPPDATA].every(value => typeof value === 'string' && path.isAbsolute(value))) {
    throw conflict('找不到当前 Windows 用户的配置目录。');
  }
  const registered = await registeredDirectory(env);
  const regular = path.join(env.LOCALAPPDATA, 'Programs', 'ZZ Board');
  const directory = installDir || registered || path.join(env.LOCALAPPDATA, 'Programs', 'ZZ Board Trial');
  if (!path.isAbsolute(directory) || same(directory, regular) ||
    (registered && !same(directory, registered)) ||
    await checkPath(path.join(regular, 'zz-board.exe')) ||
    await checkPath(path.join(env.LOCALAPPDATA, 'ZZ Board', 'uninstall.exe')) ||
    await checkPath(path.join(env.LOCALAPPDATA, 'ZZ Board','zz-board.exe'))) {
    throw conflict('检测到已有正式安装或其他已登记的位置。');
  }
  const paths = await deploymentPaths(directory, env);
  if (!same(paths.dataDir, path.join(directory, '.local-data')) ||
    (paths.boundExecutable && (!same(paths.boundExecutable, paths.executable) || !same(paths.projectRoot, root))) ||
    (!paths.boundExecutable && !same(paths.projectRoot, directory))) {
    throw conflict('已有绑定或环境变量指向不同的程序、源码或数据。');
  }
  let app;
  try { app = await targetState(directory, versionOf); }
  catch { throw conflict('选定目录不是空目录或可核对的试用安装。'); }
  if (!app) {
    if (registered || paths.bindingFile || await checkPath(paths.dataDir)) throw conflict('已有安装登记、绑定或数据，无法确认是可复用的试用安装。');
    return { directory, paths, app: null, receipt: null };
  }
  const receipt = (await deploymentEvidence(directory, app.exeHash)).source;
  if (!app.trial || receipt?.trial !== true || receipt.exeHash !== app.exeHash ||
    receipt.slot !== app.slot || receipt.version !== app.version ||
    typeof receipt.source?.root !== 'string' || !same(receipt.source.root, root)) {
    throw conflict('该安装无法与当前目录生成的试用版匹配。');
  }
  return { directory, paths, app, receipt };
}

export async function deployBuild(directory, root, installDir, env = process.env, options = {}) {
  const file = path.join(directory, receiptName);
  if (!(await checkPath(file))?.isFile()) throw new Error('构建目录缺少 ' + receiptName + '，请先执行 -Build。');
  const receipt = JSON.parse(await readFile(file));
  if (receipt.schemaVersion !== 1 || !receipt.source?.root || !same(root, receipt.source.root)) throw new Error('请从生成此构建凭据的源码目录部署。');
  if ('trial' in receipt && typeof receipt.trial !== 'boolean') throw new Error('构建凭据中的诊断模式无效。');
  return logTrialStage(receipt.trial === true, root, 'install', async () => {
    if ((await sourceIdentity(root)).buildInputsSha256 !== receipt.source.buildInputsSha256) throw new Error('源码与构建时不同，请重新构建以部署当前修改。');
    const trial = receipt.trial ? await trialInstallTarget(root, installDir, env, options.versionOf) : null;
    const target = trial?.directory || installDir || await defaultInstallDirectory(env, options.versionOf);
    const paths = trial?.paths || await deploymentPaths(target, env);
    if (paths.boundExecutable && !same(paths.boundExecutable, paths.executable)) throw new Error('Codex 绑定的原程序与选定目标不同。请先核对旧入口、完整备份与实际数据位置，再决定迁移。');
    if (trial) {
      const health = await (options.probe || healthProbe)();
      if (health.state !== 'offline') {
        const registered = await registeredDirectory(env);
        if (trial.app?.exeHash === receipt.exeHash && trial.app.slot === receipt.slot && registered && same(registered, target) && matchesHealth(trial.app, paths, health)) {
          return { mode: 'already-installed', executable: paths.executable, version: trial.app.version, runtimeDir: trial.app.directory, changed: false, trial: true };
        }
        throw portConflict();
      }
    }
    // Existing data require the former executable and recovery pair.
    if (!(await checkPath(paths.executable)) && (await checkPath(paths.dataDir))) throw new Error('新程序位置对应已存在的数据目录。请先把原程序目录或现有绑定作为独立迁移处理，并保存旧程序与完整数据副本。');
    return { ...await installPortable({
      sourceDir: directory, installDir: target, apply: true, env, ...options, buildReceipt: receipt,
      prepareRecovery: (old, dest) => prepareRecovery(old, dest, env, options.probe),
      validateRecovery: (old, checkpoint, dest) => checkRecovery(old, checkpoint, dest, env, options.probe),
    }), trial: receipt.trial === true };
  });
}

export async function statusDirectory(installDir, env = process.env) {
  if (installDir) {
    if (!path.isAbsolute(installDir)) throw new Error('请指定绝对安装路径。');
    return path.resolve(installDir);
  }
  const registered = await registeredDirectory(env);
  if (registered) return registered;
  const file = env.USERPROFILE && path.join(env.USERPROFILE, '.codex', 'zz-board.json');
  if (file && (await checkPath(file))?.isFile()) {
    const { desktopExecutable } = JSON.parse(await readFile(file));
    if (typeof desktopExecutable !== 'string' || !path.isAbsolute(desktopExecutable) || path.basename(desktopExecutable).toLowerCase() !== 'zz-board.exe') throw new Error('本机 ZZ Board 绑定的桌面程序路径无效。');
    return path.dirname(desktopExecutable);
  }
  return defaultInstallDirectory(env);
}

async function main([action, ...args]) {
  const root = ownRoot;
  if (action === 'setup') {
    if (process.platform !== 'win32') throw new Error('ZZ Board desktop setup requires Windows x64.');
    const host = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const forwarded = args[0] === '--' ? args.slice(1) : args;
    const child = spawnSync(host, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptDir, 'setup-windows.ps1'), ...forwarded], { stdio: 'inherit', windowsHide: true });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
    return;
  }
  if (action === 'fingerprint') { console.log(JSON.stringify(await sourceIdentity(root))); return; }
  if (action === 'receipt') {
    if (args[2] !== undefined && !['trial', 'standard'].includes(args[2])) throw new Error('未知的构建诊断模式。');
    const expectedTrial = args[2] === undefined ? undefined : args[2] === 'trial';
    console.log(await writeBuildReceipt(root, args[0], { root, buildInputsSha256: args[1] }, undefined, expectedTrial));
    return;
  }
  if (action === 'trial-plan') {
    const { directory, paths, app } = await trialInstallTarget(root, args[0]);
    console.log(JSON.stringify({ directory, dataDir: paths.dataDir, executable: paths.executable, installed: Boolean(app) }));
    return;
  }
  if (action === 'deploy') { console.log(JSON.stringify(await deployBuild(path.resolve(args[0]), root, args[1]), null, 2)); return; }
  if (!['status', 'start', 'rollback', 'bind-codex'].includes(action)) throw new Error('未知部署操作。');
  const directory = await statusDirectory(args[0]);
  if (action === 'rollback') {
    console.log(JSON.stringify(await rollbackPortable({ directory, checkRecovery: (previous, checkpoint, dest) => checkRecovery(previous, checkpoint, dest, process.env) }), null, 2));
    return;
  }
  const status = await readStatus(directory);
  const { app, paths, result } = status;
  const observe = async () => liveState(app, paths, session('Observe', paths.executable), await healthProbe());
  const trialHere = result.trial && result.source?.root && same(root, result.source.root);
  if (action === 'bind-codex') {
    const binding = await logTrialStage(trialHere, root, 'bind', async () => bindCodex(root, status, await observe()));
    console.log(JSON.stringify(binding, null, 2));
    return;
  }
  const live = action === 'start' ? await logTrialStage(trialHere, root, 'start', async () => {
    let state = await observe();
    if (!app) throw new Error('尚未发现可启动的 ZZ Board。');
    if (paths.boundExecutable && !same(paths.boundExecutable, paths.executable)) throw deploymentBlocked('existing_installation', 'Codex 绑定指向其他桌面程序。请核对 -Status 中的路径并协调原有安装。');
    if (state.otherDesktopProcesses.length || (!state.matchingHealth && state.health.state !== 'offline')) throw portConflict();
    if (!state.ready) {
      session('Open', paths.executable);
      const deadline = Date.now() + 30_000;
      do { await sleep(350); state = await observe(); } while (!state.ready && Date.now() < deadline);
    }
    if (!state.ready) process.exitCode = 1;
    return state;
  }) : await observe();
  console.log(JSON.stringify({ ...result, ...live }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });

