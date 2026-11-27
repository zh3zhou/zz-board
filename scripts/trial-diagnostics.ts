import { execFileSync } from 'node:child_process';
import { constants, type Stats } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRIAL_LOG_BYTES, trialEventSchema, type TrialEvent } from '../src/shared/trialDiagnostics.js';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const layers = ['setup', 'desktop', 'server', 'web'] as const;
type Layer = (typeof layers)[number];
type RuntimeScope = { state: 'verified-trial'; dataDir: string }
  | { state: 'no-trial' | 'different-source' | 'source-changed' | 'unverified-installation' };
type FileState = 'ready' | 'missing' | 'invalid' | 'not-selected';
type LayerLog = { file: string; state: FileState; events: TrialEvent[] };

interface Deployment {
  paths: { executable: string; boundExecutable?: string | null; dataDir: string };
  result: { trial?: boolean; source?: { root: string } | null; sourceState: string };
  app?: { slot: string; exeHash: string; version: string; trial?: boolean } | null;
  receipt?: { slot: string; exeHash: string; version: string; trial?: boolean } | null;
}

class DiagnosticsError extends Error {}

function pathKey(file: string) {
  const value = path.resolve(file);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

export function selectTrialRuntime(root: string, deployment: Deployment): RuntimeScope {
  const { app, paths, receipt, result } = deployment;
  if (!app || result.trial !== true) return { state: 'no-trial' };
  if (app.trial !== true || receipt?.trial !== true || receipt.slot !== app.slot || receipt.exeHash !== app.exeHash || receipt.version !== app.version
    || !/^zzb-runtime-[a-f0-9]{64}$/.test(app.slot)) return { state: 'unverified-installation' };
  if (!result.source?.root || pathKey(result.source.root) !== pathKey(root)) return { state: 'different-source' };
  if (result.sourceState === 'changed') return { state: 'source-changed' };
  if (result.sourceState !== 'matches-build-inputs' || !path.isAbsolute(paths.executable) || !path.isAbsolute(paths.dataDir)
    || paths.boundExecutable && pathKey(paths.boundExecutable) !== pathKey(paths.executable)
    || pathKey(paths.dataDir) !== pathKey(path.join(path.dirname(paths.executable), '.local-data'))) {
    return { state: 'unverified-installation' };
  }
  return { state: 'verified-trial', dataDir: paths.dataDir };
}

async function findTrialRuntime(root: string, installDir: string | undefined): Promise<RuntimeScope> {
  try {
    const { readStatus, statusDirectory } = await import(new URL('./source-deployment.mjs', import.meta.url).href);
    return selectTrialRuntime(root, await readStatus(await statusDirectory(installDir)));
  } catch {
    return { state: 'unverified-installation' };
  }
}

async function localEntry(file: string): Promise<Stats | undefined> {
  const parent = path.dirname(file);
  if (parent !== file) await localEntry(parent);
  try {
    const entry = await lstat(file);
    if (entry.isSymbolicLink()) throw new DiagnosticsError('诊断路径包含链接。');
    return entry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function readLayer(layer: Layer, target?: string): Promise<LayerLog> {
  const file = layer + '.jsonl';
  if (!target) return { file, state: 'not-selected', events: [] };
  try {
    const entry = await localEntry(target);
    if (!entry) return { file, state: 'missing', events: [] };
    if (!entry.isFile() || entry.nlink !== 1 || entry.size > TRIAL_LOG_BYTES) throw new Error();
    const handle = await open(target, 'r');
    let payload: Buffer;
    try {
      const initial = await handle.stat();
      if (initial.dev !== entry.dev || initial.ino !== entry.ino || initial.nlink !== 1 || initial.size > TRIAL_LOG_BYTES) throw new Error();
      payload = Buffer.alloc(initial.size);
      let offset = 0;
      while (offset < payload.length) {
        const { bytesRead } = await handle.read(payload, offset, payload.length - offset, offset);
        if (bytesRead === 0) throw new Error();
        offset += bytesRead;
      }
    } finally {
      await handle.close();
    }
    if (payload.length === 0) return { file, state: 'ready', events: [] };
    const content = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    if (!content.endsWith('\n')) throw new Error();
    const events = content.slice(0, -1).split('\n').map(line => {
      if (line.length > 1024) throw new Error();
      const event = trialEventSchema.parse(JSON.parse(line));
      if (event.layer !== layer) throw new Error();
      return event;
    });
    return { file, state: 'ready', events };
  } catch {
    return { file, state: 'invalid', events: [] };
  }
}

function eventTime(event: TrialEvent) {
  return typeof event.at === 'number' ? event.at : Date.parse(event.at);
}

export async function readTrialReport(root: string, runtime: RuntimeScope) {
  const logs = await Promise.all(layers.map(layer => readLayer(layer,
    layer === 'setup' ? path.join(root, '.tmp', 'zz-board-trial', 'setup.jsonl')
      : runtime.state === 'verified-trial' ? path.join(runtime.dataDir, 'logs', 'trial', layer + '.jsonl')
      : undefined)));
  const all = logs.flatMap(log => log.events);
  const latestEvents = logs.flatMap(log => log.events.slice(-12))
    .sort((a, b) => eventTime(a) - eventTime(b)).slice(-12);
  const report = {
    schemaVersion: 1,
    scope: runtime.state === 'verified-trial' ? 'setup-and-runtime' : 'setup-only',
    runtime: runtime.state,
    exportable: all.length > 0 && logs.every(log => log.state !== 'invalid'),
    records: all.length,
    files: logs.map(({ file, state, events }) => ({
      file, state, count: events.length,
      blocked: events.filter(event => event.outcome === 'blocked').length,
      failed: events.filter(event => event.outcome === 'failed').length
    })),
    latestEvents
  };
  return { report, logs };
}

export async function exportTrialReport(target: string, snapshot: Awaited<ReturnType<typeof readTrialReport>>) {
  if (process.platform !== 'win32') throw new DiagnosticsError('试用 ZIP 导出需要 Windows。');
  if (!snapshot.report.exportable) throw new DiagnosticsError('没有可导出的完整诊断快照。请先运行 preview 查看各文件状态。');
  if (!path.isAbsolute(target) || path.extname(target).toLowerCase() !== '.zip') throw new DiagnosticsError('请给出绝对 .zip 输出路径。');
  const parent = path.dirname(target);
  if (!(await localEntry(parent))?.isDirectory() || await localEntry(target)) {
    throw new DiagnosticsError('请选择已存在的本机目录以及尚未使用的 ZIP 文件名。');
  }
  const stage = await mkdtemp(path.join(parent, '.zz-board-trial-export-'));
  const input = path.join(stage, 'input');
  const archive = path.join(stage, 'report.zip');
  const written: string[] = [];
  async function add(name: string, content: string) {
    const file = path.join(input, name);
    written.push(file);
    await writeFile(file, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }
  try {
    await mkdir(input);
    await add('report.json', JSON.stringify(snapshot.report, null, 2) + '\n');
    for (const log of snapshot.logs) {
      if (log.state === 'ready') await add(log.file, log.events.map(event => JSON.stringify(event) + '\n').join(''));
    }
    const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:ZZB_TRIAL_INPUT,$env:ZZB_TRIAL_ARCHIVE,[System.IO.Compression.CompressionLevel]::Optimal,$false)";
    execFileSync(path.join(process.env.SystemRoot || '', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        windowsHide: true,
        env: { ...process.env, ZZB_TRIAL_INPUT: input, ZZB_TRIAL_ARCHIVE: archive },
        stdio: 'pipe'
      });
    await localEntry(parent);
    await copyFile(archive, target, constants.COPYFILE_EXCL);
  } finally {
    await Promise.all([...written, archive].map(file => unlink(file).catch(() => {})));
    await rmdir(input).catch(() => {});
    await rmdir(stage).catch(() => {});
  }
}

async function main(args: string[]) {
  const [command, ...rest] = args[0] === '--' ? args.slice(1) : args;
  const usage = '用法：pnpm trial:diagnostics -- preview [--install-dir <绝对路径>] 或 pnpm trial:diagnostics -- export <绝对 .zip 路径> [--install-dir <绝对路径>]';
  if (command !== 'preview' && command !== 'export') throw new DiagnosticsError(usage);
  const target = command === 'export' ? rest.shift() : undefined;
  if (command === 'export' && (!target || !path.isAbsolute(target) || path.extname(target).toLowerCase() !== '.zip')) throw new DiagnosticsError(usage);
  let installDir: string | undefined;
  if (rest.length) {
    if (rest.length !== 2 || rest[0] !== '--install-dir' || !path.isAbsolute(rest[1] ?? '')) throw new DiagnosticsError(usage);
    installDir = rest[1];
  }
  const snapshot = await readTrialReport(sourceRoot, await findTrialRuntime(sourceRoot, installDir));
  if (target) await exportTrialReport(target, snapshot);
  console.log(JSON.stringify(snapshot.report, null, 2));
}

if (process.argv[1] && pathKey(process.argv[1]) === pathKey(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof DiagnosticsError ? error.message : '无法读取或导出试用诊断。请运行 preview 核对状态，或检查 ZIP 输出目录。');
    process.exitCode = 1;
  });
}
