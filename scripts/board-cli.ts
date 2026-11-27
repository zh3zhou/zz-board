import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z, ZodError } from 'zod';
import { dataStoreId } from '../src/server/config.js';
import { parseSnapshotText } from '../src/shared/snapshot.js';
import { APP_VERSION } from '../src/shared/version.js';
import { evidenceBundleSchema, MAX_EVIDENCE_BYTES } from '../src/shared/summarySync.js';

const args = process.argv.slice(2).filter((argument) => argument !== '--');
let baseUrl = new URL('http://127.0.0.1:4318');
const bindingSchema = z.object({
  schemaVersion: z.literal(1),
  projectRoot: z.string().trim().min(1),
  dataDir: z.string().trim().min(1),
  desktopExecutable: z.string().trim().min(1),
  boardUrl: z.string().trim().min(1)
}).strict();
type BoardBinding = z.infer<typeof bindingSchema>;

try {
  const explicitUrl = optionValue(args, '--url');
  baseUrl = loopbackUrl(explicitUrl || baseUrl.href);
  const valueOptions = new Set(['--url', '--binding', '--desktop-exe', '--data-dir']);
  const positional = args.filter((argument, index) =>
    argument !== '--apply' && argument !== '--ensure-running' && argument !== '--force' &&
    !valueOptions.has(argument) && !valueOptions.has(args[index - 1] || ''));
  const [command, subcommand, fileArgument] = positional;
  if (args.includes('--force') && !(command === 'evidence' && subcommand === 'import' && args.includes('--apply'))) {
    throw new Error('--force requires evidence import --apply and explicit authorization to summarize again.');
  }
  if (command === 'status' && positional.length === 1) {
    if (args.includes('--ensure-running')) await ensureBoardRunning(explicitUrl);
    await status();
  } else if (command === 'snapshot' && positional.length === 3 && ['validate', 'preview', 'import'].includes(subcommand || '') && fileArgument) {
    await snapshotCommand(
      subcommand as 'validate' | 'preview' | 'import',
      fileArgument,
      args.includes('--apply'),
      args.includes('--ensure-running'),
      explicitUrl
    );
  } else if (command === 'evidence' && positional.length === 3 && ['validate', 'preview', 'import'].includes(subcommand || '') && fileArgument) {
    await evidenceCommand(subcommand!, fileArgument, explicitUrl);
  } else if (command === 'sync' && (subcommand === 'jobs' && positional.length === 2 || subcommand === 'status' && positional.length === 3)) {
    if (args.includes('--ensure-running')) await ensureBoardRunning(explicitUrl);
    const payload = await request('/api/sync/jobs') as { jobs?: Record<string, unknown>[] };
    const jobs = (payload.jobs || []).filter((job) => subcommand === 'jobs' || job.id === fileArgument);
    if (subcommand === 'status' && !jobs.length) throw new Error('Sync job was not found.');
    print({ jobs: jobs.map(jobReceipt) });
  } else {
    usage();
    process.exitCode = 2;
  }
} catch (error) {
  if (error instanceof ZodError) {
    const paths = [...new Set(error.issues.map((issue) => issue.path.join('.') || '(root)'))].slice(0, 12);
    console.error(`Input schema validation failed at: ${paths.join(', ')}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
}

async function status(): Promise<void> {
  const health = await request('/api/health') as Record<string, unknown>;
  const board = await request('/api/board') as {
    projects?: unknown[];
    threads?: unknown[];
    projectBriefs?: unknown[];
    todos?: unknown[];
    nodes?: { kind?: string }[];
    settings?: { lastGlobalSnapshotAt?: string | null };
  };
  print({
    service: 'available',
    health: {
      ok: health.ok,
      appVersion: health.appVersion,
      snapshotSchemaVersions: health.snapshotSchemaVersions,
      mode: health.mode,
      uptimeSeconds: health.uptimeSeconds
    },
    board: {
      projects: board.projects?.length || 0,
      tasks: board.threads?.length || 0,
      projectBriefs: board.projectBriefs?.length || 0,
      humanTodos: board.todos?.length || 0,
      localNotes: board.nodes?.filter((node) => node.kind === 'note').length || 0,
      lastGlobalSnapshotAt: board.settings?.lastGlobalSnapshotAt || null
    }
  });
}

async function snapshotCommand(
  mode: 'validate' | 'preview' | 'import',
  fileArgument: string,
  apply: boolean,
  ensureRunning: boolean,
  explicitUrl: string | undefined
): Promise<void> {
  const file = path.resolve(process.cwd(), fileArgument);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`Snapshot file does not exist: ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  const snapshot = parseSnapshotText(text);
  const summary = {
    schemaVersion: snapshot.schemaVersion,
    summaryLanguage: snapshot.schemaVersion >= 3 && 'summaryLanguage' in snapshot ? snapshot.summaryLanguage : null,
    generatedAt: snapshot.generatedAt,
    source: snapshot.source,
    projects: snapshot.projects.length,
    tasks: snapshot.threads.length,
    projectBriefs: snapshot.schemaVersion !== 1 ? snapshot.projectBriefs.length : null,
    humanTodos: snapshot.schemaVersion !== 1 ? snapshot.todos.length : null,
    coverage: {
      projectsFound: snapshot.coverage.projectsFound,
      threadsFound: snapshot.coverage.threadsFound,
      deepRead: snapshot.coverage.deepRead,
      fileChecked: snapshot.coverage.fileChecked,
      truncated: snapshot.coverage.truncated,
      inaccessibleCount: snapshot.coverage.inaccessible.length
    }
  };

  if (mode === 'validate') {
    print({ valid: true, ...summary });
    return;
  }
  if (mode === 'preview') {
    print({ valid: true, mutation: false, ...summary });
    return;
  }
  if (!apply) {
    print({ valid: true, mutation: false, plan: 'Import this snapshot into the local board.', ...summary });
    console.log('Preview only. Re-run with --apply after the user approves this exact import.');
    return;
  }
  if (ensureRunning) await ensureBoardRunning(explicitUrl);

  const imported = await request('/api/snapshots/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-zz-board-mutation': '1' },
    body: JSON.stringify({ text })
  });
  print({ mutation: true, imported });
}

function jobReceipt(job: Record<string, unknown>) {
  return { id: job.id, state: job.state, completed: job.completed, total: job.total, skipped: job.skipped,
    model: job.model, effort: job.effort, usage: job.usage, needsResubmit: job.needsResubmit,
    hasError: Boolean(job.error), createdAt: job.createdAt, updatedAt: job.updatedAt };
}

async function evidenceCommand(mode: string, fileArgument: string, explicitUrl: string | undefined) {
  const file = path.resolve(process.cwd(), fileArgument);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('Evidence file does not exist.');
  if (fs.statSync(file).size > MAX_EVIDENCE_BYTES) throw new Error('Evidence bundle exceeds the byte limit.');
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Evidence bundle is not valid JSON.'); }
  const bundle = evidenceBundleSchema.parse(raw);
  const summary = { schemaVersion: bundle.schemaVersion, projects: bundle.projects.length, tasks: bundle.threads.length,
    deepRead: bundle.coverage.deepRead, truncated: bundle.coverage.truncated, inaccessibleCount: bundle.coverage.inaccessible.length };
  if (mode !== 'import' || !args.includes('--apply')) {
    print({ valid: true, mutation: false, ...summary });
    return;
  }
  if (args.includes('--ensure-running')) await ensureBoardRunning(explicitUrl);
  // Never expose provider errors: they may echo source text. The board retains diagnostics locally.
  let job: Record<string, unknown>;
  try { job = await request('/api/sync/jobs', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-zz-board-mutation': '1' },
    body: JSON.stringify({ bundle, force: args.includes('--force') }) }) as Record<string, unknown>; }
  catch { throw new Error('Evidence submission failed; inspect the local board sync panel. No completion is claimed.'); }
  print({ mutation: true, ...summary, job: jobReceipt(job) });
}

async function ensureBoardRunning(explicitUrl: string | undefined): Promise<void> {
  const binding = loadBinding();
  if (!explicitUrl) baseUrl = loopbackUrl(binding.boardUrl);
  const expectedStoreId = dataStoreId(binding.dataDir);
  const existing = await probeHealth();
  if (existing) {
    assertExpectedService(existing, expectedStoreId);
    return;
  }

  const configuredExecutable = optionValue(args, '--desktop-exe') || binding.desktopExecutable;
  const executable = path.isAbsolute(configuredExecutable)
    ? configuredExecutable
    : path.resolve(binding.projectRoot, configuredExecutable);
  if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
    throw new Error('The configured ZZ Board desktop executable is unavailable. Update the local binding and retry.');
  }
  spawn(executable, ['--background'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await delay(250);
    const health = await probeHealth();
    if (!health) continue;
    assertExpectedService(health, expectedStoreId);
    return;
  }
  throw new Error(`ZZ Board did not become available at ${baseUrl.origin} within 20 seconds.`);
}

function loadBinding(): BoardBinding {
  const explicitBinding = optionValue(args, '--binding');
  const userProfile = process.env.USERPROFILE;
  const bindingPath = explicitBinding
    ? path.resolve(process.cwd(), explicitBinding)
    : userProfile ? path.join(userProfile, '.codex', 'zz-board.json') : '';
  if (!bindingPath || !fs.existsSync(bindingPath) || !fs.statSync(bindingPath).isFile()) {
    const dataDir = optionValue(args, '--data-dir');
    const desktopExecutable = optionValue(args, '--desktop-exe');
    if (dataDir && desktopExecutable) {
      return validateBinding({
        schemaVersion: 1,
        projectRoot: process.cwd(),
        dataDir: path.resolve(process.cwd(), dataDir),
        desktopExecutable: path.resolve(process.cwd(), desktopExecutable),
        boardUrl: baseUrl.href
      });
    }
    throw new Error('ZZ Board local binding was not found. Configure %USERPROFILE%\\.codex\\zz-board.json or provide --desktop-exe and --data-dir.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(bindingPath, 'utf8')); }
  catch { throw new Error('ZZ Board local binding is not valid JSON.'); }
  const result = bindingSchema.safeParse(parsed);
  if (!result.success) throw new Error('ZZ Board local binding does not match schema version 1.');
  return validateBinding(result.data);
}

function validateBinding(binding: BoardBinding): BoardBinding {
  if (!path.isAbsolute(binding.projectRoot) || !path.isAbsolute(binding.dataDir) || !path.isAbsolute(binding.desktopExecutable)) {
    throw new Error('ZZ Board local binding paths must be absolute.');
  }
  const resolvedDataDir = path.resolve(binding.dataDir);
  const dataDirKey = normalizedPathKey(resolvedDataDir);
  const rootKey = normalizedPathKey(path.parse(resolvedDataDir).root);
  const userProfileKey = process.env.USERPROFILE ? normalizedPathKey(process.env.USERPROFILE) : null;
  if (dataDirKey === rootKey || (userProfileKey && dataDirKey === userProfileKey)) {
    throw new Error('ZZ Board dataDir must not be a drive root or the user profile directory.');
  }
  loopbackUrl(binding.boardUrl);
  return binding;
}

function normalizedPathKey(value: string): string {
  return path.resolve(value).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
}

async function probeHealth(): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(new URL('/api/health', baseUrl), { signal: AbortSignal.timeout(1_000) });
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { incompatibleHttpService: true, status: response.status };
    }
    return payload as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function assertExpectedService(health: Record<string, unknown>, expectedStoreId: string): void {
  if (health.appVersion !== APP_VERSION || health.dataStoreId !== expectedStoreId) {
    throw new Error(`A different or incompatible service is listening at ${baseUrl.origin}; it was left untouched.`);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function request(route: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(new URL(route, baseUrl), { ...init, signal: init?.signal || AbortSignal.timeout(5_000) });
  } catch {
    throw new Error(`ZZ Board is unavailable at ${baseUrl.origin}. Run pnpm board -- status --ensure-running, or reopen the desktop app, then retry.`);
  }
  const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
  if (!response.ok) throw new Error(payload?.error || `ZZ Board returned HTTP ${response.status}.`);
  return payload;
}

function loopbackUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.username || url.password || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('The board CLI only connects to an HTTP loopback address.');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

function optionValue(values: string[], option: string): string | undefined {
  const index = values.indexOf(option);
  if (index < 0) return undefined;
  const value = values[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return value;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function usage(): void {
  console.log(`ZZ Board agent CLI

  pnpm board -- status [--url http://127.0.0.1:4318] [--ensure-running] [--binding <file>]
  pnpm board -- snapshot validate <file>
  pnpm board -- snapshot preview <file>
  pnpm board -- snapshot import <file> [--apply] [--ensure-running] [--binding <file>]
  pnpm board -- evidence validate <file>
  pnpm board -- evidence preview <file>
  pnpm board -- evidence import <file> [--apply] [--ensure-running] [--force]
  pnpm board -- sync jobs
  pnpm board -- sync status <job-id>

--ensure-running uses %USERPROFILE%\\.codex\\zz-board.json by default. Snapshot import remains preview-only unless --apply is present.
Without a binding, provide both --desktop-exe <file> and --data-dir <directory>.
Evidence validate/preview never starts the desktop or calls a model. Evidence import only queues a job;
poll sync status for completion. --force requires evidence import --apply and bypasses unchanged-input reuse.
The CLI never deletes the supplied input file or connects to a non-loopback host.`);
}
