import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportTrialReport, readTrialReport, selectTrialRuntime } from '../../scripts/trial-diagnostics.js';
import { isPackagedTrial, normalizeTrialRoute } from '../../src/server/trialDiagnostics.js';
import { TRIAL_LOG_BYTES } from '../../src/shared/trialDiagnostics.js';
import { APP_VERSION } from '../../src/shared/version.js';

let testRoot: string;
beforeEach(() => {
  fs.mkdirSync('.tmp', { recursive: true });
  testRoot = fs.mkdtempSync(path.resolve('.tmp/trial-diagnostics-test-'));
});
afterEach(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

const setupLine = { schemaVersion: 1, at: '2026-11-28T08:15:22.0070000Z', layer: 'setup',
  event: 'preflight', outcome: 'blocked', code: 'prerequisite_missing' };
const serverLine = { schemaVersion: 1, at: '2026-11-28T08:25:12.001Z', layer: 'server',
  event: 'api', route: 'notes', outcome: 'ok', method: 'POST', elapsedMs: 5, status: 201 };
function write(relative: string, text: string) {
  const target = path.join(testRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
  return target;
}
const setup = '.tmp/zz-board-trial/setup.jsonl', server = 'installed/.local-data/logs/trial/server.jsonl';
const jsonl = (value: unknown) => JSON.stringify(value) + '\n';
const syntheticSecret = 'private-canary:E:\\not-a-real-user\\task.json?token=never-in-report';
const runtimeScope = () => ({ state: 'verified-trial' as const, dataDir: path.join(testRoot, 'installed', '.local-data') });

describe('trial marker identity and safe route metadata', () => {
  it('requires the exact marker, runtime entry and verified manifest hash', () => {
    const runtime = path.join(testRoot, 'server.cjs');
    const valid = { schemaVersion: 2, appVersion: APP_VERSION, trialDiagnostics: { schemaVersion: 1 } };
    function install(manifest: unknown) {
      const raw = JSON.stringify(manifest);
      write('manifest.json', raw);
      return { ZZ_BOARD_RUNTIME: 'desktop-sidecar', ZZ_BOARD_PACKAGED_RUNTIME: 'zzb-runtime-' + createHash('sha256').update(raw).digest('hex') };
    }
    const env = install(valid);
    expect(isPackagedTrial(env, runtime)).toBe(true);
    expect(isPackagedTrial({ ZZ_BOARD_BUILD_TRIAL: '1' }, runtime)).toBe(false);
    expect(isPackagedTrial(env, path.join(testRoot, 'index.js'))).toBe(false);
    expect(isPackagedTrial({ ...env, ZZ_BOARD_RUNTIME: 'web-fallback' }, runtime)).toBe(false);
    expect(isPackagedTrial(install({ ...valid, trialDiagnostics: { schemaVersion: 1, private: syntheticSecret } }), runtime)).toBe(false);
    expect(isPackagedTrial(install({ ...valid, trialDiagnostics: undefined }), runtime)).toBe(false);
    expect(isPackagedTrial(env, runtime)).toBe(false);
  });

  it('returns fixed route categories that discard route parameters', () => {
    expect(normalizeTrialRoute('/api/projects/:projectKey/source-excerpt')).toBe('project_excerpts');
    expect(normalizeTrialRoute('/api/projects/:projectKey/conversations/refresh')).toBe('project_history');
    expect(normalizeTrialRoute('/api/nodes/:id')).toBe('notes');
    expect(normalizeTrialRoute('/api/new-endpoint')).toBe('other_api');
    expect(normalizeTrialRoute('/api/trial/diagnostics/events')).toBeUndefined();
    expect(normalizeTrialRoute('/assets/other.js')).toBeUndefined();
  });
});

describe('diagnostics report collection', () => {
  it('requires matching trial receipt, source and data location before considering runtime logs', () => {
    const app = { slot: 'zzb-runtime-' + 'a'.repeat(64), exeHash: 'b'.repeat(64), version: APP_VERSION, trial: true };
    const paths = { executable: path.join(testRoot, 'installed', 'zz-board.exe'), dataDir: runtimeScope().dataDir };
    const result = { trial: true, source: { root: testRoot }, sourceState: 'matches-build-inputs' };
    const deployment = { app, paths, receipt: app, result };
    expect(selectTrialRuntime(testRoot, deployment)).toEqual(runtimeScope());
    expect(selectTrialRuntime(testRoot, { ...deployment, receipt: { ...app, exeHash: 'different' } }).state).toBe('unverified-installation');
    expect(selectTrialRuntime(testRoot, { ...deployment, result: { ...result, trial: false } }).state).toBe('no-trial');
    expect(selectTrialRuntime(testRoot, { ...deployment, result: { ...result, source: { root: path.join(testRoot, 'different') } } }).state).toBe('different-source');
    expect(selectTrialRuntime(testRoot, { ...deployment, result: { ...result, sourceState: 'changed' } }).state).toBe('source-changed');
    expect(selectTrialRuntime(testRoot, { ...deployment, paths: { ...paths, dataDir: path.join(testRoot, 'other') } }).state).toBe('unverified-installation');
    expect(selectTrialRuntime(testRoot, { ...deployment, paths: { ...paths, boundExecutable: path.join(testRoot, 'other.exe') } }).state)
      .toBe('unverified-installation');
  });

  it('can preview a blocked setup without reading other installations or raw logs', async () => {
    write(setup, jsonl(setupLine));
    write(server, syntheticSecret);
    write('installed/.local-data/logs/desktop.log', syntheticSecret);
    const snapshot = await readTrialReport(testRoot, { state: 'different-source' });
    expect(snapshot.report).toMatchObject({ scope: 'setup-only', records: 1, exportable: true, latestEvents: [setupLine] });
    expect(snapshot.report.files).toContainEqual({ file: 'server.jsonl', state: 'not-selected', count: 0, blocked: 0, failed: 0 });
    expect(JSON.stringify(snapshot)).not.toContain(syntheticSecret);
  });

  it.each([
    ['untrusted text', syntheticSecret],
    ['unexpected object properties', jsonl({ ...serverLine, token: syntheticSecret })],
    ['wrong layer', jsonl(setupLine)],
    ['truncated final event', JSON.stringify(serverLine)]
  ])('rejects %s without including raw data in the snapshot', async (_case, text) => {
    write(setup, jsonl(setupLine));
    write(server, text);
    const snapshot = await readTrialReport(testRoot, runtimeScope());
    expect(snapshot.report).toMatchObject({ scope: 'setup-and-runtime', records: 1, exportable: false });
    expect(snapshot.report.files).toContainEqual({ file: 'server.jsonl', state: 'invalid', count: 0, blocked: 0, failed: 0 });
    expect(JSON.stringify(snapshot)).not.toContain(syntheticSecret);
  });

  it('rejects linked and oversized files without reading their bytes', async () => {
    const outside = write('synthetic-private.log', syntheticSecret);
    const target = path.join(testRoot, server);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.linkSync(outside, target);
    expect((await readTrialReport(testRoot, runtimeScope())).report.files[2]?.state).toBe('invalid');
    fs.unlinkSync(target);
    fs.writeFileSync(target, '');
    fs.truncateSync(target, TRIAL_LOG_BYTES + 1);
    expect((await readTrialReport(testRoot, runtimeScope())).report.files[2]?.state).toBe('invalid');
  });

  it.skipIf(process.platform !== 'win32')('exports exactly the validated JSONL and summary to a new ZIP', async () => {
    write(setup, jsonl(setupLine));
    write(server, jsonl(serverLine));
    write('installed/.local-data/logs/raw.log', syntheticSecret);
    const snapshot = await readTrialReport(testRoot, runtimeScope());
    const zip = path.join(testRoot, '诊断.zip');
    await exportTrialReport(zip, snapshot);
    const script = [
      "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8",
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      '$zip=[System.IO.Compression.ZipFile]::OpenRead($env:ZZB_SYNTHETIC_ZIP)',
      'try { @($zip.Entries | ForEach-Object { $reader=[IO.StreamReader]::new($_.Open()); try { @{ name=$_.Name; contents=$reader.ReadToEnd() } } finally { $reader.Dispose() } }) | ConvertTo-Json -Compress } finally { $zip.Dispose() }'
    ].join('; ');
    const entries: { name: string; contents: string }[] = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, encoding: 'utf8', env: { ...process.env, ZZB_SYNTHETIC_ZIP: zip }
    }));
    expect(entries.map(entry => entry.name).sort()).toEqual(['report.json', 'server.jsonl', 'setup.jsonl']);
    expect(JSON.parse(entries.find(entry => entry.name === 'server.jsonl')!.contents)).toEqual(serverLine);
    expect(JSON.stringify(entries)).not.toContain(syntheticSecret);
    const priorZip = fs.readFileSync(zip);
    await expect(exportTrialReport(zip, snapshot)).rejects.toThrow('尚未使用');
    expect(fs.readFileSync(zip)).toEqual(priorZip);
  });
});
