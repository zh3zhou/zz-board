import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface RuntimeFile { path: string; bytes: number; sha256: string }
interface RuntimeMetadata {
  appVersion: string; nodeVersion: string; platform: string; arch: string;
  sourceCommit?: string; releaseChannel?: string; declaredBuild?: 'official' | 'modified' | 'development';
  publicFeedback?: { envId: string; publishableKey: string };
  trialDiagnostics?: { schemaVersion: 1 };
}

export async function copyDesktopDependency(source: string, destination: string) {
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    // Package-manager launchers can embed the build directory. The package's
    // own bin/, libraries and notices remain part of the runtime.
    filter: file => path.basename(file) !== '.bin' || path.basename(path.dirname(file)) !== 'node_modules',
  });
}

async function inventory(root: string, hash = true): Promise<RuntimeFile[]> {
  const files: RuntimeFile[] = [];
  async function walk(directory: string) {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('Runtime directories must not be links.');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Runtime files must not be links.');
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile()) throw new Error('Unsupported runtime entry.');
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (relative === 'manifest.json' || relative === '.gitkeep') continue;
      if (files.length >= 10_000) throw new Error('Runtime file count exceeds its packaging limit.');
      const digest = createHash('sha256');
      if (hash) for await (const chunk of createReadStream(file)) digest.update(chunk);
      files.push({ path: relative, bytes: (await lstat(file)).size, sha256: hash ? digest.digest('hex') : '' });
    }
  }
  await walk(root);
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export async function writeRuntimeManifest(root: string, metadata: RuntimeMetadata) {
  const files = await inventory(root);
  await writeFile(path.join(root, 'manifest.json'), `${JSON.stringify({ schemaVersion: 2, ...metadata, files }, null, 2)}\n`);
  return files;
}

export async function verifyRuntime(root: string, version: string): Promise<RuntimeFile[]> {
  const manifestPath = path.join(root, 'manifest.json');
  const stat = await lstat(manifestPath);
  if (stat.isSymbolicLink() || stat.size > 2_000_000) throw new Error('Invalid runtime manifest file.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 2 || manifest.appVersion !== version || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 10_000) {
    throw new Error('Runtime inventory/version missing or incompatible; rebuild the desktop package.');
  }
  const trial = manifest.trialDiagnostics;
  if (trial !== undefined && (!trial || typeof trial !== 'object' || Object.keys(trial).length !== 1 || trial.schemaVersion !== 1)) {
    throw new Error('Invalid desktop trial diagnostics marker.');
  }
  const expected = new Map<string, RuntimeFile>();
  const names = new Set<string>();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !entry.path || /[\\<>:"|?*\x00-\x1f]/.test(entry.path) || entry.path.split('/').some((part: string) => !part || part === '.' || part === '..')
      || ['manifest.json', '.gitkeep'].includes(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid runtime inventory entry.');
    if (names.has(entry.path.toLowerCase())) throw new Error('Duplicate runtime inventory path.');
    names.add(entry.path.toLowerCase()); expected.set(entry.path, entry);
  }
  const actual = await inventory(root);
  for (const entry of actual) {
    const wanted = expected.get(entry.path);
    if (!wanted) throw new Error(`Unexpected runtime file: ${entry.path}`);
    if (entry.bytes !== wanted.bytes || entry.sha256 !== wanted.sha256) throw new Error(`Changed runtime file: ${entry.path}`);
    expected.delete(entry.path);
  }
  if (expected.size) throw new Error(`Missing runtime file: ${expected.keys().next().value}`);
  return actual;
}

function within(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function removeGeneratedRuntime(projectRoot: string, runtime: string, preservePlaceholder = false) {
  if (!within(path.resolve(projectRoot), runtime)) throw new Error('Refusing an out-of-project runtime.');
  let cursor = path.resolve(projectRoot);
  for (const segment of ['', ...path.relative(cursor, runtime).split(path.sep)]) {
    cursor = path.join(cursor, segment);
    try { const stat = await lstat(cursor); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Refusing a redirected desktop target.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: 0 }; throw error; }
  }
  if (!within(await realpath(projectRoot), await realpath(runtime))) throw new Error('Resolved runtime escaped its project.');
  const files = await inventory(runtime, false);
  if (preservePlaceholder) {
    for (const name of await readdir(runtime)) {
      if (name !== '.gitkeep') await rm(path.join(runtime, name), { recursive: true });
    }
  } else await rm(runtime, { recursive: true });
  return { removed: files.length };
}

/** Fixed generated source only; reject junctions before any cleanup or writes. */
export async function cleanSourceRuntime(projectRoot: string) {
  return removeGeneratedRuntime(projectRoot, path.resolve(projectRoot, 'src-tauri', 'resources', 'runtime'), true);
}

/** Only the selected, non-running Cargo profile's generated runtime is replaced.
 * desktop-tauri.ps1 checks processes before invoking this operation. */
export async function cleanTargetRuntime(projectRoot: string, targetRoot: string, profile: string) {
  const base = path.resolve(projectRoot, 'src-tauri', 'target'), target = path.resolve(targetRoot);
  if (!['release', 'debug'].includes(profile) || (path.relative(base, target) !== '' && !within(base, target))) throw new Error('Refusing an out-of-project desktop target.');
  const runtime = path.join(target, profile, 'resources', 'runtime');
  // Reject redirected ancestors before resolving/deleting anything. No traversal
  // through junctions into user data or another checkout is permitted.
  return removeGeneratedRuntime(projectRoot, runtime);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, first, second, third] = process.argv.slice(2);
    if (command === 'verify' && first && second) {
      const files = await verifyRuntime(first, second);
      console.log(`Runtime integrity verified: ${files.length} files.`);
    } else if (command === 'clean-target' && first && second && third) {
      const result = await cleanTargetRuntime(first, second, third);
      console.log(`Generated target runtime reset: ${result.removed} payload files; build will regenerate it.`);
    } else throw new Error('Expected verify <runtime> <version> or clean-target <project> <target> <profile>.');
  } catch (error) { console.error(error instanceof Error ? error.message : 'Desktop runtime check failed.'); process.exitCode = 1; }
}
