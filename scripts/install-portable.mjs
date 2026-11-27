import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { verifyRuntime } from './desktop-runtime.ts';

const EXE = 'zz-board.exe';
const PREVIOUS = 'zz-board.previous.exe';
const DB = '.zz-board-install.sqlite';
const APP_ID = 0x5a5a4249;
const slotPattern = /^zzb-runtime-[a-f0-9]{64}$/;
const excludedInstallPath = /(?:^|[\\/])(?:\.local-data|\.git|node_modules|src-tauri[\\/]target)(?:[\\/]|$)/i;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};

async function statIfPresent(file) {
  try { return await lstat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function checkPath(file) {
  const full = path.resolve(file);
  const parent = path.dirname(full);
  if (parent !== full) await checkPath(parent);
  const st = await statIfPresent(full);
  if (st?.isSymbolicLink()) throw new Error('安装路径包含链接或重解析点：' + full);
  return st;
}

function powershell(script, value) {
  const host = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return execFileSync(host, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; " + script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, ZZB_INSPECT_PATH: value },
  }).trim();
}

function windowsVersion(executable) {
  const info = JSON.parse(powershell(
    '(Get-Item -LiteralPath $env:ZZB_INSPECT_PATH).VersionInfo | Select-Object ProductName,CompanyName,ProductVersion,FileDescription | ConvertTo-Json -Compress', executable));
  if (info.ProductName !== 'ZZ Board' || info.CompanyName !== 'zzboard' || info.FileDescription !== 'ZZ Board' || !info.ProductVersion) {
    throw new Error('目标程序缺少 ZZ Board 的 Windows 产品标识：' + executable);
  }
  return info.ProductVersion;
}

function checkStopped(directory) {
  const count = powershell([
    "$root=$env:ZZB_INSPECT_PATH.TrimEnd('\\')",
    "$program=Join-Path $root 'zz-board.exe'",
    "$previous=Join-Path $root 'zz-board.previous.exe'",
    "$resources=(Join-Path $root 'resources')+'\\'",
    '$session=[Diagnostics.Process]::GetCurrentProcess().SessionId',
    '@(Get-CimInstance Win32_Process -Filter "Name=\'zz-board.exe\' OR Name=\'zz-board.previous.exe\' OR Name=\'node.exe\'" | Where-Object { if (!$_.ExecutablePath) { return $false }; if ($_.ExecutablePath -eq $program -or $_.ExecutablePath -eq $previous -or $_.ExecutablePath.StartsWith($resources,[StringComparison]::OrdinalIgnoreCase)) { return $true }; if ($_.SessionId -eq $session -and $_.Name -ne "node.exe") { $v=[Diagnostics.FileVersionInfo]::GetVersionInfo($_.ExecutablePath); return $v.ProductName -eq "ZZ Board" -and $v.CompanyName -eq "zzboard" }; return $false }).Count',
  ].join('; '), directory);
  if (count !== '0') throw new Error('检测到正在运行的 ZZ Board。请保存便签，从托盘「真正退出」所有版本，再运行更新。');
}

export function embeddedSlot(bytes) {
  const matches = new Set(bytes.toString('latin1').match(/zzb-runtime-[a-f0-9]{64}/g));
  if (matches.size > 1) throw new Error('程序包含多个不同的资源标识。');
  return matches.values().next().value;
}

async function readManifest(runtime) {
  const file = path.join(runtime, 'manifest.json');
  const stat = await checkPath(file);
  if (!stat?.isFile() || stat.size > 2_000_000) throw new Error('运行时清单无效：' + file);
  const raw = await readFile(file);
  const manifest = JSON.parse(raw);
  if (![1, 2].includes(manifest.schemaVersion) || manifest.platform !== 'win32' || manifest.arch !== 'x64' || typeof manifest.appVersion !== 'string') {
    throw new Error('运行时清单与 Windows x64 便携版不兼容。');
  }
  const diagnosticMarker = manifest.trialDiagnostics;
  if (diagnosticMarker !== undefined && (manifest.schemaVersion !== 2 ||
    !diagnosticMarker || typeof diagnosticMarker !== 'object' ||
    Object.keys(diagnosticMarker).length !== 1 || diagnosticMarker.schemaVersion !== 1)) {
    throw new Error('试用诊断标记无效。');
  }
  return { slot: 'zzb-runtime-' + sha(raw), version: manifest.appVersion, schema: manifest.schemaVersion, trial: diagnosticMarker !== undefined };
}

// Mirrors the two supported release layouts in src-tauri/src/runtime.rs.
export async function runtimeForExecutable(executable, bytes) {
  if (!(await checkPath(executable))?.isFile()) throw new Error('找不到 ZZ Board 程序：' + executable);
  const slot = embeddedSlot(bytes || await readFile(executable));
  const resources = path.join(path.dirname(executable), 'resources');
  for (const name of slot ? [slot, 'runtime'] : ['runtime']) {
    const directory = path.join(resources, name);
    if (!(await checkPath(path.join(directory, 'manifest.json')))?.isFile()) continue;
    const manifest = await readManifest(directory);
    if ((!slot || manifest.slot === slot) && (await checkPath(path.join(directory, 'server.cjs')))?.isFile()) return { ...manifest, name, directory };
  }
  throw new Error('找不到与该程序匹配的完整运行时：' + executable);
}

export async function inspect(directory, versionOf = windowsVersion, requireSlot = false, name = EXE) {
  const executable = path.join(directory, name);
  if (!(await checkPath(executable))?.isFile()) throw new Error('没有找到 zz-board.exe：' + directory);
  const bytes = await readFile(executable);
  const runtime = await runtimeForExecutable(executable, bytes);
  if (requireSlot && embeddedSlot(bytes) !== runtime.slot) throw new Error('来源应用不支持固定路径更新，请取用新版完整 ZIP。');
  if (await versionOf(executable) !== runtime.version) throw new Error('应用与运行时的产品版本不一致。');
  const required = ['node.exe', 'server.cjs', 'dist/web/index.html'];
  const files = runtime.schema === 2 ? await verifyRuntime(runtime.directory, runtime.version) : [];
  if (runtime.schema === 1) {
    if (requireSlot || runtime.name !== 'runtime') throw new Error('新版包需要逐文件校验清单。');
    // Older ZIPs have no file hashes. Accept their identified Windows app in
    // place and leave the entire classic runtime as a rollback resource.
    for (const name of required) if (!(await checkPath(path.join(runtime.directory, name)))?.isFile()) throw new Error('旧版运行时不完整。');
  } else if (!required.every(file => files.some(entry => entry.path === file))) throw new Error('缺少完整的桌面运行时。');
  if ((await readManifest(runtime.directory)).slot !== runtime.slot) throw new Error('校验期间来源清单发生了变化。');
  return { ...runtime, executable, exeHash: sha(bytes), files };
}

function registrationFile(env) {
  if (!env.LOCALAPPDATA || !path.isAbsolute(env.LOCALAPPDATA)) throw new Error('找不到当前 Windows 用户的本地应用目录。');
  return path.join(env.LOCALAPPDATA, 'ZZ Board Portable', 'location.json');
}

export async function registeredDirectory(env) {
  const file = registrationFile(env);
  if (!(await checkPath(file))) return;
  const record = JSON.parse(await readFile(file, 'utf8'));
  if (record.schemaVersion !== 1 || typeof record.installDir !== 'string' || !path.isAbsolute(record.installDir)) throw new Error('已保存的安装位置无效。');
  return record.installDir;
}

export async function defaultInstallDirectory(env = process.env, versionOf = windowsVersion) {
  let legacy;
  if (env.USERPROFILE) {
    const binding = path.join(env.USERPROFILE, '.codex', 'zz-board.json');
    if ((await checkPath(binding))?.isFile()) {
      const { desktopExecutable } = JSON.parse(await readFile(binding, 'utf8'));
      if (typeof desktopExecutable === 'string' && path.isAbsolute(desktopExecutable) && path.basename(desktopExecutable).toLowerCase() === EXE) {
        const directory = path.dirname(desktopExecutable);
        if (!excludedInstallPath.test(directory) && directory !== path.parse(directory).root && (await checkPath(desktopExecutable))?.isFile()
          && !(await statIfPresent(path.join(directory, 'uninstall.exe')))) {
          if (await managedDirectory(directory)) return directory;
          legacy = directory;
        }
      }
    }
  }
  const registered = await registeredDirectory(env);
  if (registered) {
    if (!(await checkPath(path.join(registered, EXE)))?.isFile()) throw new Error('上次安装的位置暂不可用，请连接对应磁盘或指定原安装目录：' + registered);
    return registered;
  }
  // The first fixed-path upgrade can take over a genuine older ZIP. A later,
  // explicit registered choice wins even when its old Codex binding remains.
  if (legacy) { await inspect(legacy, versionOf, false); return legacy; }
  return path.join(env.LOCALAPPDATA, 'Programs', 'ZZ Board');
}

async function register(directory, env, trial = false) {
  const file = registrationFile(env);
  if (trial) {
    const preserve = async () => {
      const existing = await registeredDirectory(env);
      if (existing && path.relative(existing, directory) === '') return true;
      if (existing) throw new Error('现有安装登记指向其他位置。请在独立 Windows 用户中试用。');
      return false;
    };
    if (await preserve()) return;
    await mkdir(path.dirname(file), { recursive: true });
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temp, JSON.stringify({ schemaVersion: 1, installDir: directory }, null, 2) + '\n', { flag: 'wx' });
      try { await link(temp, file); }
      catch (error) { if (error.code !== 'EEXIST' || !await preserve()) throw error; }
    } finally { await rm(temp, { force: true }); }
    return;
  }
  try {
    if (await registeredDirectory(env) === directory) return;
  } catch (error) {
    if (!((await checkPath(file))?.isFile()) || (error.code && error.code !== 'ENOENT')) throw error;
    await copyFile(file, file + '.invalid-' + randomUUID() + '.json', constants.COPYFILE_EXCL);
  }
  await checkPath(file);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, JSON.stringify({ schemaVersion: 1, installDir: directory }, null, 2) + '\n', { flag: 'wx' });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}

async function managedDirectory(directory) {
  const file = path.join(directory, DB);
  if (!(await checkPath(file))?.isFile()) return false;
  const fh = await open(file, 'r');
  try {
    const header = Buffer.alloc(100);
    const { bytesRead } = await fh.read(header, 0, header.length, 0);
    return bytesRead === header.length && header.toString('ascii', 0, 16) === 'SQLite format 3\0' && header.readUInt32BE(68) === APP_ID;
  } finally { await fh.close(); }
}

export async function targetState(directory, versionOf, held = false) {
  const stat = await checkPath(directory);
  if (!stat) return;
  if (!stat.isDirectory()) throw new Error('目标不是文件夹。');
  if (await statIfPresent(path.join(directory, 'uninstall.exe'))) throw new Error('这是安装包管理的目录，请用新版 setup 安装包更新。');
  if (await checkPath(path.join(directory, EXE))) return inspect(directory, versionOf, false);
  const entries = await readdir(directory);
  if (!entries.length) return;
  if ((held || await managedDirectory(directory)) && entries.every(name =>
    [DB, DB + '-journal', 'resources'].includes(name) || /^\.zzb-update-[a-f\d-]{36}$/.test(name))) return;
  throw new Error('目标目录含有其他文件，且没有完整的 ZZ Board；请选择原便携目录或空目录。');
}

async function installLock(directory) {
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.join(directory, DB);
  const exists = await checkPath(file);
  if (exists && !exists.isFile()) throw new Error('便携安装记录不是普通文件。');
  const db = new DatabaseSync(file);
  try {
    // EXCLUSIVE locking mode holds the OS lock across commits until close.
    // Commit ownership before filesystem changes so a power-loss retry can
    // reconcile both the still-running EXE and an already-switched EXE.
    db.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
    const { application_id } = db.prepare('PRAGMA application_id').get();
    if (application_id !== APP_ID && (application_id !== 0 || exists?.size)) throw new Error('目标包含其他应用的安装记录。');
    db.exec('PRAGMA application_id=' + APP_ID + '; CREATE TABLE IF NOT EXISTS slots(name TEXT PRIMARY KEY, digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS backup(hash TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS stages(name TEXT PRIMARY KEY); COMMIT');
    db.exec('CREATE TABLE IF NOT EXISTS build_sources(hash TEXT PRIMARY KEY, receipt TEXT NOT NULL); CREATE TABLE IF NOT EXISTS recovery_pairs(previous_hash TEXT NOT NULL, next_hash TEXT NOT NULL, checkpoint TEXT NOT NULL, PRIMARY KEY(previous_hash,next_hash))');
    return db;
  } catch (error) {
    db.close();
    if (error.errcode === 5) throw new Error('另一个更新正在进行，请等它完成。');
    throw error;
  }
}

async function copyRuntime(source, stage, target) {
  const destination = path.join(target, source.slot);
  if (await checkPath(destination)) {
    if ((await readManifest(destination)).slot !== source.slot) throw new Error('已存在同名资源目录，内容与新包不同。');
  } else {
    const temporary = path.join(stage, 'runtime');
    for (const file of [...source.files.map(file => file.path), 'manifest.json']) {
      const output = path.join(temporary, ...file.split('/'));
      await mkdir(path.dirname(output), { recursive: true });
      await copyFile(path.join(source.directory, ...file.split('/')), output, constants.COPYFILE_EXCL);
    }
    await verifyRuntime(temporary, source.version);
    if ((await readManifest(temporary)).slot !== source.slot) throw new Error('复制期间清单发生变化。');
    await mkdir(target, { recursive: true });
    await rename(temporary, destination);
  }
  await verifyRuntime(destination, source.version);
}

async function prune(db, resources, keep) {
  const retained = [];
  for (const { name, digest } of db.prepare('SELECT name, digest FROM slots').all()) {
    if (keep.has(name) || (name !== 'runtime' && !slotPattern.test(name))) continue;
    const directory = path.join(resources, name);
    try {
      if (await checkPath(directory)) {
        if (!inside(await realpath(resources), await realpath(directory))) throw new Error('资源目录超出安装位置');
        const names = await readdir(directory);
        const placeholder = path.join(directory, '.gitkeep');
        if (names.includes('.gitkeep')) {
          const stat = await checkPath(placeholder);
          if (!stat.isFile() || stat.size > 2 || !['', '\n', '\r\n'].includes(await readFile(placeholder, 'utf8'))) throw new Error('占位文件包含用户内容');
        }
        // Some earlier cleanups left only the build's empty/LF .gitkeep.
        // The ownership ledger still identifies that otherwise empty slot.
        let files = [];
        if (names.some(file => file !== '.gitkeep')) {
          const manifest = await readManifest(directory);
          if (manifest.slot !== digest) throw new Error('清单已被替换');
          files = (await verifyRuntime(directory, manifest.version)).map(item => item.path);
          files.push('manifest.json');
        }
        // Remove only inventoried files. Unknown files or directories added by
        // the user remain in place even if they appear during cleanup.
        const parents = new Set();
        if (names.includes('.gitkeep')) files.push('.gitkeep');
        for (const file of files) {
          const target = path.join(directory, ...file.split('/'));
          await rm(target);
          let current = path.dirname(target);
          while (inside(directory, current)) { parents.add(current); current = path.dirname(current); }
        }
        for (const parent of [...parents].sort((a, b) => b.length - a.length)) await rmdir(parent);
        await rmdir(directory);
      }
      db.prepare('DELETE FROM slots WHERE name=?').run(name);
    } catch { retained.push(directory); }
  }
  return retained;
}

async function clearStages(directory, db) {
  for (const { name } of db.prepare('SELECT name FROM stages').all()) {
    if (!/^\.zzb-update-[a-f\d-]{36}$/.test(name)) throw new Error('安装暂存目录登记无效。');
    const stage = path.join(directory, name);
    if (await checkPath(stage)) {
      if (path.dirname(await realpath(stage)) !== await realpath(directory)) throw new Error('暂存目录超出安装位置。');
      await rm(stage, { recursive: true });
    }
    db.prepare('DELETE FROM stages WHERE name=?').run(name);
  }
}

export async function installPortable({ sourceDir, installDir, apply = false, env = process.env, versionOf = windowsVersion, ensureStopped = checkStopped, buildReceipt, prepareRecovery, validateRecovery }) {
  const sourceRoot = path.resolve(sourceDir);
  const requested = installDir || await defaultInstallDirectory(env, versionOf);
  if (!path.isAbsolute(requested)) throw new Error('请使用绝对安装路径。');
  const directory = path.resolve(requested);
  if (directory === path.parse(directory).root || path.relative(directory, sourceRoot) === '' || inside(directory, sourceRoot) || inside(sourceRoot, directory)
    || excludedInstallPath.test(directory)) throw new Error('请选择独立于下载包、开发目录和数据目录的安装文件夹。');
  const source = await inspect(sourceRoot, versionOf, true);
  if ((source.trial && !buildReceipt) || (buildReceipt && (source.exeHash !== buildReceipt.exeHash || source.slot !== buildReceipt.slot ||
    source.version !== buildReceipt.version || source.trial !== (buildReceipt.trial === true)))) {
    throw new Error('构建凭据与实际程序、资源或诊断模式不一致。');
  }
  const original = await targetState(directory, versionOf);
  if (original && original.trial !== source.trial) throw new Error('试用版和正式版使用各自的安装。请选择独立 Windows 用户。');
  const executable = path.join(directory, EXE);
  const resources = path.join(directory, 'resources');
  const result = { mode: apply ? 'apply' : 'preview', executable, version: source.version, runtimeDir: path.join(resources, source.slot), changed: original?.exeHash !== source.exeHash || original?.name !== source.slot, retained: [] };
  if (!apply) return result;
  await checkPath(registrationFile(env));
  await mkdir(directory, { recursive: true });
  const db = await installLock(directory);
  try {
    const old = await targetState(directory, versionOf, true);
    if (old?.exeHash !== original?.exeHash) throw new Error('另一项操作已更新程序，请重试。');
    if (source.trial) {
      const registered = await registeredDirectory(env);
      if (registered && path.relative(registered, directory) !== '') throw new Error('现有安装登记指向其他位置。请在独立 Windows 用户中试用。');
    }
    await clearStages(directory, db);
    if (buildReceipt) db.prepare('INSERT OR REPLACE INTO build_sources(hash,receipt) VALUES(?,?)').run(source.exeHash, JSON.stringify(buildReceipt));
    if (result.changed) {
      await ensureStopped(directory);
      const previous = path.join(directory, PREVIOUS);
      const previousStat = await checkPath(previous);
      if (previousStat) {
        if (!previousStat.isFile()) throw new Error('回退程序路径已被其他文件占用。');
        const hash = sha(await readFile(previous));
        if (old?.exeHash !== hash && !db.prepare('SELECT 1 FROM backup WHERE hash=?').get(hash)) throw new Error('现有回退文件不属于此安装记录。');
      }
      const stageName = '.zzb-update-' + randomUUID();
      const stage = path.join(directory, stageName);
      const remember = db.prepare('INSERT OR REPLACE INTO slots(name,digest) VALUES(?,?)');
      const checkpoint = prepareRecovery && old ? await prepareRecovery(old, directory) : null;
      if (checkpoint) await ensureStopped(directory);
      db.exec('BEGIN');
      if (checkpoint) {
        db.prepare('INSERT OR REPLACE INTO recovery_pairs(previous_hash,next_hash,checkpoint) VALUES(?,?,?)').run(old.exeHash, source.exeHash, JSON.stringify(checkpoint));
        result.recovery = checkpoint;
      } else if (old) db.prepare('DELETE FROM recovery_pairs WHERE previous_hash=? AND next_hash=?').run(old.exeHash, source.exeHash);
      db.prepare('INSERT INTO stages(name) VALUES(?)').run(stageName);
      remember.run(source.slot, source.slot);
      if (old) {
        if (old.schema === 2) remember.run(old.name, old.slot);
        db.prepare('INSERT OR IGNORE INTO backup(hash) VALUES(?)').run(old.exeHash);
      }
      db.exec('COMMIT');
      await mkdir(stage);
      const candidate = path.join(stage, EXE);
      await copyFile(source.executable, candidate, constants.COPYFILE_EXCL);
      if (sha(await readFile(candidate)) !== source.exeHash) throw new Error('复制期间应用文件发生变化。');
      await checkPath(resources);
      await copyRuntime(source, stage, resources);
      if (checkpoint) {
        await validateRecovery(old, checkpoint, directory);
        await ensureStopped(directory);
      }
      if (old) {
        const stagedPrevious = path.join(stage, PREVIOUS);
        await copyFile(executable, stagedPrevious, constants.COPYFILE_EXCL);
        if (sha(await readFile(stagedPrevious)) !== old.exeHash) throw new Error('更新期间原程序发生变化。');
        await rename(stagedPrevious, previous);
      }
      // One same-volume rename switches the pinned path after its matching
      // resources exist. A locked Windows executable cannot be replaced.
      try { await rename(candidate, executable); }
      catch (error) { throw new Error('Windows 未能替换程序，请保存并从托盘「真正退出」后重试。', { cause: error }); }
    }
    const keep = new Set([source.slot]);
    const backupFile = path.join(directory, PREVIOUS);
    if ((await checkPath(backupFile))?.isFile()) {
      const backupBytes = await readFile(backupFile);
      const backupHash = sha(backupBytes);
      if (!db.prepare('SELECT 1 FROM backup WHERE hash=?').get(backupHash)) throw new Error('现有回退文件不属于此安装记录。');
      keep.add((await runtimeForExecutable(backupFile, backupBytes)).name);
      db.prepare('DELETE FROM backup WHERE hash<>?').run(backupHash);
    }
    result.retained = await prune(db, resources, keep);
    try { await register(directory, env, source.trial); }
    catch (error) { throw new Error('应用已经就绪，但未能记住下次更新位置。请保留此路径：' + executable + '。' + error.message, { cause: error }); }
    return result;
  } finally {
    try { await clearStages(directory, db); } finally { db.close(); }
  }
}

function findRecoveryPair(db, previous, current) {
  if (previous === current) return db.prepare('SELECT * FROM recovery_pairs WHERE previous_hash=? ORDER BY rowid DESC LIMIT 1').get(previous);
  return db.prepare('SELECT * FROM recovery_pairs WHERE previous_hash=? AND next_hash=?').get(previous, current);
}

export async function deploymentEvidence(directory, exeHash) {
  if (!await managedDirectory(directory)) return {};
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(directory, DB), { readOnly: true });
  try {
    const has = table => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    const receipt = has('build_sources') && db.prepare('SELECT receipt FROM build_sources WHERE hash=?').get(exeHash);
    const previous = path.join(directory, PREVIOUS);
    const pair = has('recovery_pairs') && (await checkPath(previous))?.isFile() && findRecoveryPair(db, sha(await readFile(previous)), exeHash);
    return { source: receipt ? JSON.parse(receipt.receipt) : null, recovery: pair ? JSON.parse(pair.checkpoint) : null };
  } finally { db.close(); }
}

// Keep the previous EXE intact. Retrying after a crash at the atomic rename
// therefore always has either the verified prior EXE or the verified new EXE.
export async function rollbackPortable({ directory, env = process.env, versionOf = windowsVersion, ensureStopped = checkStopped, checkRecovery }) {
  if (!await managedDirectory(directory)) throw new Error('该位置没有受管的程序与数据回退记录。');
  const db = await installLock(directory);
  try {
    const current = await inspect(directory, versionOf);
    const previous = await inspect(directory, versionOf, false, PREVIOUS);
    const pair = findRecoveryPair(db, previous.exeHash, current.exeHash);
    if (!pair || pair.previous_hash !== previous.exeHash || ![pair.next_hash, previous.exeHash].includes(current.exeHash) || !db.prepare('SELECT 1 FROM backup WHERE hash=?').get(previous.exeHash)) throw new Error('没有与当前程序配对的升级前完整数据备份。请使用原版本与自行保存的完整数据副本恢复。');
    if (current.exeHash === previous.exeHash) return { mode: 'already-rolled-back', executable: current.executable, version: current.version };
    await ensureStopped(directory);
    const checkpoint = JSON.parse(pair.checkpoint);
    await checkRecovery(previous, checkpoint, directory);
    const name = '.zzb-update-' + randomUUID();
    await clearStages(directory, db);
    db.prepare('INSERT INTO stages(name) VALUES(?)').run(name);
    const stage = path.join(directory, name);
    await mkdir(stage);
    const candidate = path.join(stage, EXE);
    await copyFile(previous.executable, candidate, constants.COPYFILE_EXCL);
    if (sha(await readFile(candidate)) !== previous.exeHash) throw new Error('回退程序复制校验失败。');
    await ensureStopped(directory);
    await rename(candidate, current.executable);
    await register(directory, env);
    return { mode: 'rolled-back', executable: current.executable, version: previous.version, recovery: checkpoint };
  } finally {
    try { await clearStages(directory, db); } finally { db.close(); }
  }
}

async function main(args) {
  if (args[0] === '--runtime-for' && args.length === 2) { console.log((await runtimeForExecutable(path.resolve(args[1]))).directory); return; }
  let sourceDir, installDir, choose = false, apply = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply') apply = true;
    else if (arg === '--choose') choose = true;
    else if (['--source', '--install-dir'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) {
      if (arg === '--source') sourceDir = args[++i]; else installDir = args[++i];
    } else throw new Error('未知或缺少参数：' + arg);
  }
  if (!sourceDir) throw new Error('需要 --source 指定已解压的完整新版目录。');
  if (choose) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      let suggested = installDir;
      if (!suggested) {
        try { suggested = await defaultInstallDirectory(); }
        catch (error) { console.log('未能确认原位置。' + error.message + '\n请重新连接原磁盘后重试，或手动指定旧程序所在的文件夹。'); }
      }
      console.log('以前直接运行过 ZIP？输入旧版 zz-board.exe 所在的文件夹，可保留原任务栏图标和该目录旁的本地看板。');
      if (suggested) console.log('首次安装或已用本入口更新，可直接按回车。推荐位置：' + suggested);
      const answer = (await prompt.question('安装或更新到：')).trim().replace(/^"(.*)"$/, '$1');
      installDir = answer ? (path.basename(answer).toLowerCase() === EXE ? path.dirname(answer) : answer) : suggested;
      if (!installDir) throw new Error('没有选定安装目录，已取消。');
    } finally { prompt.close(); }
  }
  const result = await installPortable({ sourceDir, installDir, apply });
  if (!choose) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log('已就绪。打开或右击此文件固定到任务栏：' + result.executable);
  if (result.retained.length) console.log('以下旧资源未能完整校验或清理，已保留：\n' + result.retained.join('\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
