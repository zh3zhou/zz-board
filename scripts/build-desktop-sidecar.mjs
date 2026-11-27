import { copyFile, cp, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { cleanSourceRuntime, copyDesktopDependency, writeRuntimeManifest, verifyRuntime } from './desktop-runtime.ts';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const runtimeDir = path.join(projectRoot, 'src-tauri', 'resources', 'runtime');
const webSource = path.join(projectRoot, 'dist', 'web');

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error(`Desktop sidecar packaging currently supports Windows x64 only; got ${process.platform}/${process.arch}.`);
}

const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const sourceCommit = process.env.ZZ_BOARD_SOURCE_COMMIT;
const trialDiagnostics = process.env.ZZ_BOARD_BUILD_TRIAL === '1';
if (trialDiagnostics && process.env.ZZ_BOARD_OFFICIAL_BUILD === '1') throw new Error('Trial diagnostics require a private trial build.');
if (sourceCommit && !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Invalid public source commit.');
if (process.env.ZZ_BOARD_OFFICIAL_BUILD === '1') {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', windowsHide: true });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8', windowsHide: true });
  if (!sourceCommit || head.status !== 0 || head.stdout.trim() !== sourceCommit || status.status !== 0 || status.stdout.trim()) throw new Error('Official packaging requires the reviewed clean public source commit.');
}
let publicFeedback;
if (process.env.ZZ_BOARD_FEEDBACK_ENV_ID || process.env.ZZ_BOARD_FEEDBACK_PUBLISHABLE_KEY) {
  const envId = process.env.ZZ_BOARD_FEEDBACK_ENV_ID || '';
  const publishableKey = process.env.ZZ_BOARD_FEEDBACK_PUBLISHABLE_KEY || '';
  let role;
  try { role = JSON.parse(Buffer.from(publishableKey.split('.')[1], 'base64url').toString('utf8')).role; } catch { /* Fail closed below. */ }
  if (!/^[a-z0-9][a-z0-9-]{5,100}$/.test(envId) || publishableKey.length > 8192 || publishableKey.split('.').length !== 3 || role !== 'anon') throw new Error('Only an explicit public anon credential can be packaged for feedback.');
  publicFeedback = { envId, publishableKey };
}
let esbuild;
try {
  ({ build: esbuild } = await import('esbuild'));
} catch {
  throw new Error('The desktop build needs esbuild as a direct devDependency. Run pnpm add -D esbuild.');
}

await cleanSourceRuntime(projectRoot);
await mkdir(path.join(runtimeDir, 'dist'), { recursive: true });

await esbuild({
  stdin: {
    contents: `
      import { buildApp } from './src/server/app.ts';
      import { loadConfig } from './src/server/config.ts';
      void (async () => {
        const config = loadConfig();
        const app = await buildApp(config);
        try {
          await app.listen({ host: config.host, port: config.port });
          app.log.info(\`ZZ Board is listening on http://\${config.host}:\${config.port}\`);
        } catch (error) {
          app.log.error(error);
          process.exitCode = 1;
        }
      })();
    `,
    resolveDir: projectRoot,
    sourcefile: 'desktop-server-entry.ts',
    loader: 'ts'
  },
  outfile: path.join(runtimeDir, 'server.cjs'),
  bundle: true,
  external: ['sharp'],
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: false,
  legalComments: 'inline',
  logLevel: 'info'
});
// Native image decoding stays external to esbuild. Copy only the installed runtime
// dependency closure (including this platform's @img binary), without pnpm links.
const copied = new Set();
async function locatePackage(name, from) {
  // Resolve installed package directories rather than assuming package.json is
  // exported. Native @img packages intentionally expose only sharp.node.
  const require = createRequire(from);
  for (const directory of require.resolve.paths(name) || []) {
    try {
      const file = await realpath(path.join(directory, name, 'package.json'));
      if (JSON.parse(await readFile(file, 'utf8')).name === name) return file;
    } catch { /* package absent at this resolution level */ }
  }
  return null;
}
async function copyRuntimePackage(name, from) {
  if (copied.has(name)) return;
  const packageFile = await locatePackage(name, from);
  if (!packageFile) throw new Error(`Cannot locate runtime package ${name}`);
  const metadata = JSON.parse(await readFile(packageFile, 'utf8'));
  copied.add(name);
  await copyDesktopDependency(path.dirname(packageFile), path.join(runtimeDir, 'node_modules', name));
  for (const dependency of Object.keys(metadata.dependencies || {})) await copyRuntimePackage(dependency, packageFile);
  for (const dependency of Object.keys(metadata.optionalDependencies || {})) {
    const optional = await locatePackage(dependency, packageFile); if (!optional) continue;
    const target = JSON.parse(await readFile(optional, 'utf8'));
    if (target.os && !target.os.includes(process.platform) || target.cpu && !target.cpu.includes(process.arch)) continue;
    await copyRuntimePackage(dependency, packageFile);
  }
}
await copyRuntimePackage('sharp', path.join(projectRoot, 'package.json'));
await cp(webSource, path.join(runtimeDir, 'dist', 'web'), { recursive: true, force: true });
await copyFile(process.execPath, path.join(runtimeDir, 'node.exe'));
const decoderProbe = spawnSync(path.join(runtimeDir, 'node.exe'), ['-e', "require(process.argv[1])({create:{width:2,height:2,channels:3,background:'white'}}).png().toBuffer().catch(()=>process.exit(1))", path.join(runtimeDir, 'node_modules', 'sharp')], { windowsHide: true, timeout: 30000, encoding: 'utf8' });
if (decoderProbe.status !== 0) throw new Error(`Packaged image decoder failed: ${decoderProbe.stderr || decoderProbe.error || decoderProbe.status}`);
await writeRuntimeManifest(runtimeDir, { appVersion: packageJson.version, nodeVersion: process.version, platform: process.platform, arch: process.arch,
  ...(sourceCommit ? { sourceCommit } : {}), releaseChannel: 'alpha.1', declaredBuild: process.env.ZZ_BOARD_OFFICIAL_BUILD === '1' ? 'official' : sourceCommit ? 'modified' : 'development',
  ...(publicFeedback ? { publicFeedback } : {}), ...(trialDiagnostics ? { trialDiagnostics: { schemaVersion: 1 } } : {}) });
await verifyRuntime(runtimeDir, packageJson.version);

console.log(`Prepared the ZZ Board desktop runtime at ${runtimeDir}`);
