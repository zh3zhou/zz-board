import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoLinks, createPublicExportPlan, publicGitMatches, within } from './export-public-source.mjs';
import { verifyRuntime } from './desktop-runtime.ts';
import { embeddedSlot } from './install-portable.mjs';

const ownRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const slash = value => value.replaceAll('\\', '/');

async function licenseTexts(directory) {
  const texts = [];
  const collect = async (dir, prefix = '', depth = 0) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name), name = `${prefix}${entry.name}`;
      if (entry.isFile() && (/^(licen[cs]e|copying|notice)(?:[._-]|$)/i.test(entry.name) || (depth > 0 && /\.(txt|md)$/i.test(entry.name)))) {
        const stat = await lstat(file); if (stat.size > 2_000_000) throw new Error('A dependency license text exceeds the audit size limit.');
        const bytes = await readFile(file), text = bytes.toString('utf8');
        if (bytes.length && Buffer.from(text).equals(bytes)) texts.push({ path: slash(name), sha256: sha(bytes), text });
      } else if (entry.isDirectory() && depth === 0 && /^licen[cs]es?$/i.test(entry.name)) await collect(file, `${name}/`, 1);
    }
  };
  await collect(directory);
  return texts.sort((a, b) => a.path.localeCompare(b.path));
}

async function installedPackage(name, from) {
  const require = createRequire(from);
  for (const directory of require.resolve.paths(name) || []) {
    try {
      const file = await realpath(path.join(directory, name, 'package.json')), metadata = JSON.parse(await readFile(file));
      if (metadata.name === name) return { file, metadata };
    } catch { /* optional/unavailable candidate; do not fetch packages */ }
  }
  return null;
}

const compatible = (metadata, platform, arch) => (!metadata.os || metadata.os.includes(platform)) && (!metadata.cpu || metadata.cpu.includes(arch));

const auditFailure = error => typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : Number.isInteger(error.status) ? `process exit ${error.status}` : 'metadata, file or provenance check failed';

async function supplementalLicenses(root) {
  const directory = path.join(root, 'docs', 'public-launch', 'third-party-source-evidence'), file = path.join(directory, 'resolved-licenses.json');
  let value;
  try { await assertNoLinks(file); value = JSON.parse(await readFile(file)); } catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
  if (value.schemaVersion !== 1 || !Array.isArray(value.records)) throw new Error('Invalid supplemental license evidence map.');
  const result = new Map();
  for (const entry of value.records) {
    const key = `${entry.ecosystem}:${entry.name}@${entry.version}`;
    if (!['npm', 'rust'].includes(entry.ecosystem) || typeof entry.name !== 'string' || !entry.name || !/^[0-9A-Za-z.+-]+$/.test(entry.version || '') || typeof entry.license !== 'string' || !entry.license || !Array.isArray(entry.files) || result.has(key)) throw new Error('Invalid or duplicate supplemental license identity.');
    const source = new URL(entry.source?.url);
    if (source.protocol !== 'https:' || source.username || source.password || typeof entry.source?.ref !== 'string' || !entry.source.ref || /[\r\n]/.test(entry.source.ref) || (!/^[a-f0-9]{40}$/.test(entry.source.ref) && !entry.source.ref.includes(entry.version)) || (entry.source.blobSha && !/^[a-f0-9]{40}$/.test(entry.source.blobSha))) throw new Error('Supplemental licenses require an exact public source reference.');
    const texts = [];
    for (const evidence of entry.files) {
      if (typeof evidence.path !== 'string' || /[\\:\u0000-\u001f]/.test(evidence.path) || evidence.path.split('/').some(part => !part || part === '.' || part === '..') || !/^[a-f0-9]{64}$/.test(evidence.sha256 || '')) throw new Error('Invalid supplemental license path/hash.');
      const target = path.join(directory, ...evidence.path.split('/'));
      if (!within(directory, target)) throw new Error('Supplemental license escaped its evidence directory.');
      await assertNoLinks(target);
      const bytes = await readFile(target), text = bytes.toString('utf8');
      if (!bytes.length || bytes.length > 2_000_000 || !Buffer.from(text).equals(bytes) || sha(bytes) !== evidence.sha256) throw new Error('Supplemental license bytes/hash differ from their evidence map.');
      texts.push({ path: `supplemental/${evidence.path}`, sha256: evidence.sha256, text });
    }
    result.set(key, { license: entry.license, source: { url: source.href, ref: entry.source.ref, ...(entry.source.blobSha ? { blobSha: entry.source.blobSha } : {}), ...(entry.source.buildOnly === true ? { buildOnly: true } : {}) }, texts });
  }
  return result;
}

export async function collectDependencyNotices({ sourceRoot = ownRoot, platform = 'win32', arch = 'x64', cargoRunner, nodeVersion = process.versions.node } = {}) {
  const root = path.resolve(sourceRoot), pkg = JSON.parse(await readFile(path.join(root, 'package.json')));
  const records = [], blocks = [], notes = [], optionalUnavailable = [], visited = new Set();
  const visit = async (name, from, scope, optional = false) => {
    const resolved = await installedPackage(name, from);
    if (!resolved) { if (optional) optionalUnavailable.push(name); else blocks.push(`npm package unavailable: ${name}`); return; }
    const { file, metadata } = resolved;
    if (!compatible(metadata, platform, arch)) return;
    const key = `${metadata.name}@${metadata.version}`; if (visited.has(key)) return; visited.add(key);
    const texts = await licenseTexts(path.dirname(file));
    const license = typeof metadata.license === 'string' ? metadata.license : metadata.license?.type || null;
    records.push({ ecosystem: 'npm', name: metadata.name, version: metadata.version, scope, license, texts });
    if (!license || !texts.length) blocks.push(`npm license metadata/text needs review: ${key}`);
    for (const child of Object.keys(metadata.dependencies || {})) await visit(child, file, scope);
    for (const child of Object.keys(metadata.optionalDependencies || {})) await visit(child, file, scope, true);
  };
  for (const name of Object.keys(pkg.dependencies || {})) await visit(name, path.join(root, 'package.json'), 'production-root closure');
  // Build tools can inject runtime JavaScript (for example the PWA worker).
  // Include their installed closure conservatively; this is an inventory
  // superset, not a claim that every build dependency is shipped.
  for (const name of Object.keys(pkg.devDependencies || {})) await visit(name, path.join(root, 'package.json'), 'build-root closure (conservative)');
  const nodeLicense = path.join(root, 'docs', 'public-launch', 'licenses', `node-v${nodeVersion}-LICENSE.txt`);
  try {
    const bytes = await readFile(nodeLicense), provenance = JSON.parse(await readFile(nodeLicense.replace('-LICENSE.txt', '-source.json')));
    const gitBlob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (provenance.ref !== `v${nodeVersion}` || provenance.gitBlobSha !== gitBlob) throw new Error('Node license provenance does not match its exact file.');
    records.push({ ecosystem: 'node', name: 'Node.js and embedded third-party components', version: nodeVersion, scope: 'bundled node.exe', license: 'MIT and component-specific terms', texts: [{ path: path.basename(nodeLicense), sha256: sha(bytes), text: bytes.toString('utf8') }] });
  } catch (error) { blocks.push(`Node ${nodeVersion} exact license/provenance unavailable: ${auditFailure(error)}`); }
  try {
    const args = ['metadata', '--manifest-path', path.join(root, 'src-tauri', 'Cargo.toml'), '--filter-platform', 'x86_64-pc-windows-msvc', '--offline', '--locked', '--format-version', '1'];
    const metadata = JSON.parse(cargoRunner ? await cargoRunner(args) : execFileSync('cargo', args, { cwd: root, encoding: 'utf8', maxBuffer: 64_000_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    if (!metadata.resolve?.nodes?.length) throw new Error('Cargo did not return a dependency graph.');
    const ids = new Set(metadata.resolve.nodes.map(node => node.id));
    for (const dependency of metadata.packages.filter(item => ids.has(item.id) && item.source)) {
      const texts = await licenseTexts(path.dirname(dependency.manifest_path));
      if (dependency.license_file && !texts.some(item => item.path === slash(dependency.license_file))) {
        const licensePath = path.resolve(path.dirname(dependency.manifest_path), dependency.license_file);
        if (!within(path.dirname(dependency.manifest_path), licensePath)) throw new Error('Cargo license_file escapes its dependency directory.');
        const bytes = await readFile(licensePath); texts.push({ path: slash(dependency.license_file), sha256: sha(bytes), text: bytes.toString('utf8') });
      }
      records.push({ ecosystem: 'rust', name: dependency.name, version: dependency.version, scope: 'Windows target resolve graph (including build dependencies)', license: dependency.license || null, texts });
      if (!dependency.license || !texts.length) blocks.push(`Rust license metadata/text needs review: ${dependency.name}@${dependency.version}`);
    }
  } catch (error) { blocks.push(`Rust dependency audit unavailable: ${auditFailure(error)}`); }
  const supplements = await supplementalLicenses(root), resolved = new Set();
  for (const record of records) {
    const evidence = supplements.get(`${record.ecosystem}:${record.name}@${record.version}`); if (!evidence) continue;
    if (record.license && record.license !== evidence.license) { blocks.push(`Supplemental license expression differs from installed metadata: ${record.name}@${record.version}`); continue; }
    record.license ||= evidence.license;
    record.texts.push(...evidence.texts.filter(text => !record.texts.some(existing => existing.sha256 === text.sha256)));
    record.supplementalEvidence = { ...evidence.source, licenseTextAvailable: evidence.texts.length > 0 };
    const missingTextBlock = `${record.ecosystem === 'npm' ? 'npm' : 'Rust'} license metadata/text needs review: ${record.name}@${record.version}`;
    if (evidence.texts.length) resolved.add(missingTextBlock);
    else if (evidence.source.buildOnly === true && record.ecosystem === 'npm' && record.scope === 'build-root closure (conservative)') {
      resolved.add(missingTextBlock);
      notes.push(`Verified build-only dependency; not included as a runtime text blocker: ${record.name}@${record.version}. Exact source provenance recorded; revisit if the component is later shipped.`);
    } else notes.push(`Source reference only; exact license text not locally captured: ${record.ecosystem}:${record.name}@${record.version}`);
  }
  const unresolvedBlocks = blocks.filter(item => !resolved.has(item));
  const copyleft = records.filter(record => /(?:^|\W)(?:A?GPL|LGPL|MPL|EUPL)[-\s\d]/i.test(record.license || ''));
  if (copyleft.length) notes.push('Review each copyleft expression and available alternatives; metadata alone does not select an OR branch or establish binary compliance.');
  const sharpNative = records.filter(record => record.name.startsWith('@img/sharp-'));
  if (!sharpNative.length && Object.hasOwn(pkg.dependencies || {}, 'sharp')) blocks.push('Installed Windows Sharp native packages were not found.');
  if (sharpNative.some(record => /LGPL/i.test(record.license || '') || record.texts.some(item => /LGPL|Lesser General Public License/i.test(item.text)))) notes.push('Sharp/native libvips LGPL material requires corresponding-source/linking/replacement review before binary redistribution.');
  notes.push('Presence/hashes are verified inventory evidence, not a legal clearance. Actual static-link attribution and binary obligations remain owner review gates.');
  records.sort((a, b) => `${a.ecosystem}:${a.name}@${a.version}`.localeCompare(`${b.ecosystem}:${b.name}@${b.version}`));
  const report = { schemaVersion: 1, applicationVersion: pkg.version, target: `${platform}-${arch}`, nodeVersion, packageLockSha256: sha(await readFile(path.join(root, 'pnpm-lock.yaml'))), cargoLockSha256: sha(await readFile(path.join(root, 'src-tauri', 'Cargo.lock'))), scope: 'Installed npm production/build closures plus Windows Cargo resolve graph; conservative inventory, not exact linker tracing', records: records.map(({ texts, ...record }) => ({ ...record, texts: texts.map(({ text, ...item }) => item) })), blockers: unresolvedBlocks, reviewNotes: notes, copyleft: copyleft.map(({ ecosystem, name, version, license }) => ({ ecosystem, name, version, license })), optionalUnavailable: [...new Set(optionalUnavailable)].sort(), legalClearance: false };
  const notices = ['ZZ Board third-party license texts', 'Inventory only; terms below remain owned by their respective holders.', ...records.flatMap(record => [`\n===== ${record.ecosystem}: ${record.name}@${record.version} =====`, `Declared license: ${record.license || 'UNKNOWN'}`, `Inventory scope: ${record.scope}`, ...(record.supplementalEvidence ? [`Supplemental source: ${record.supplementalEvidence.url} @ ${record.supplementalEvidence.ref}; local license text: ${record.supplementalEvidence.licenseTextAvailable}`] : []), ...record.texts.flatMap(item => [`\n--- ${item.path}; SHA256 ${item.sha256} ---\n`, item.text])])].join('\n');
  return { report, notices };
}

export function publicBuildPrivacy(sourceRoot, env = process.env) {
  const locations = [[env.USERPROFILE, '/build/user'], [env.CARGO_HOME, '/build/cargo'], [sourceRoot, '/build/zz-board']];
  const flags = env.CARGO_ENCODED_RUSTFLAGS !== undefined
    ? env.CARGO_ENCODED_RUSTFLAGS.split('\x1f').filter(Boolean)
    : (env.RUSTFLAGS || '').split(/\s+/).filter(Boolean);
  const needles = new Set();
  for (const [value, target] of locations) {
    if (!value || !(path.isAbsolute(value) || path.win32.isAbsolute(value))) continue;
    const local = value.replace(/[\\/]+$/, '');
    if (!local || /^[a-z]:$/i.test(local)) continue;
    const native = local.replaceAll('/', '\\');
    const forms = new Set([local, slash(local)]);
    if (/^[a-z]:\\/i.test(native)) {
      forms.add(native);
      forms.add('\\\\?\\' + native);
    }
    for (const form of forms) {
      flags.push('--remap-path-prefix=' + form + '=' + target);
      for (const spelling of new Set([form, form.replaceAll('\\', '\\\\')])) {
        for (const encoding of ['utf8', 'utf16le']) {
          needles.add(Buffer.from(spelling, encoding).toString('latin1').toLowerCase());
        }
      }
    }
  }
  const terms = [...needles];
  const overlap = Math.max(0, ...terms.map(term => term.length - 1));
  return {
    encodedRustFlags: flags.join('\x1f'),
    checkFile(relative, bytes) {
      // Binary and text assets use the same check. The overlap covers paths
      // that straddle chunks without allocating another entire executable.
      const chunkSize = 1024 * 1024;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const chunk = bytes.toString('latin1', offset, Math.min(bytes.length, offset + chunkSize + overlap)).toLowerCase();
        if (terms.some(term => chunk.includes(term))) throw new Error('Local build path in ' + relative);
      }
    },
  };
}

function powershell(data, body) {
  const encodedData = Buffer.from(JSON.stringify(data)).toString('base64');
  const script = `$ErrorActionPreference='Stop'; $zzReleaseArgs=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedData}')) | ConvertFrom-Json; ${body}`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, maxBuffer: 4_000_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export async function createBuildSourcePlan({ sourceRoot = ownRoot, channel = 'alpha.1', date, publicCommit = process.env.ZZ_BOARD_SOURCE_COMMIT } = {}) {
  const root = path.resolve(sourceRoot), manifestPath = path.join(root, 'PUBLIC_SOURCE_MANIFEST.json');
  let manifest;
  try { await assertNoLinks(manifestPath); manifest = JSON.parse(await readFile(manifestPath)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!manifest) return { ...await createPublicExportPlan({ sourceRoot: root, channel, date, publicCommit }), verifiedPublicSource: false };
  if (manifest.schemaVersion !== 1 || manifest.channel !== channel || !Array.isArray(manifest.files) || !/^\d{4}-\d{2}-\d{2}$/.test(manifest.date || '')) throw new Error('Invalid public source manifest for this build.');
  if (date !== undefined && date !== manifest.date) throw new Error('Explicit record date differs from the public source manifest.');
  const plan = await createPublicExportPlan({ sourceRoot: root, channel, date: manifest.date, publicCommit });
  if (manifest.appVersion !== plan.version || manifest.sourceDigest !== plan.sourceDigest || manifest.files.length !== plan.files.length) throw new Error('Public source manifest differs from current source. Export a new candidate.');
  const recorded = new Map();
  for (const file of manifest.files) {
    if (recorded.has(file.path)) throw new Error('Duplicate public source manifest entry.');
    recorded.set(file.path, file);
  }
  for (const file of plan.files) {
    const target = path.join(root, ...file.destination.split('/')), expected = recorded.get(file.destination);
    if (!within(root, target)) throw new Error('Public source manifest escaped its root.');
    await assertNoLinks(target);
    const bytes = await readFile(target);
    if (!expected || expected.sha256 !== file.sha256 || expected.bytes !== file.bytes.length || !bytes.equals(file.bytes)) throw new Error(`Public build source bytes differ: ${file.destination}. Export a new candidate.`);
  }
  return { ...plan, verifiedPublicSource: true };
}

const mplSourcePrefix = 'docs/public-launch/third-party-source-evidence/mpl/';

function verifyMplSources(exported, copyleft, blockers) {
  const archives = exported.files.filter(file => file.destination.startsWith(mplSourcePrefix) && file.destination.endsWith('.crate'));
  const components = copyleft.filter(item => item.ecosystem === 'rust' && item.license === 'MPL-2.0');
  if (!archives.length && !components.length) return archives;
  const lockFile = exported.files.find(file => file.destination === 'src-tauri/Cargo.lock');
  if (!lockFile) throw new Error('Missing Cargo.lock for bundled MPL source.');
  const cargoLock = lockFile.bytes.toString('utf8');
  const lockHashes = new Map();
  for (const entry of cargoLock.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    if (!/^source = "registry\+https:\/\/github\.com\/rust-lang\/crates\.io-index"\s*$/m.test(entry)) continue;
    const name = /^name = "([^"]+)"\s*$/m.exec(entry)?.[1];
    const version = /^version = "([^"]+)"\s*$/m.exec(entry)?.[1];
    const checksum = /^checksum = "([a-f0-9]{64})"\s*$/m.exec(entry)?.[1];
    if (name && version && checksum) lockHashes.set(name + '-' + version + '.crate', checksum);
  }
  for (const archive of archives) {
    const name = archive.destination.slice(mplSourcePrefix.length);
    if (lockHashes.get(name) !== archive.sha256) throw new Error('Bundled crate source differs from Cargo.lock: ' + name);
  }
  for (const component of components) {
    const name = component.name + '-' + component.version + '.crate';
    if (!archives.some(file => file.destination === mplSourcePrefix + name)) blockers.push('MPL source archive missing: ' + name);
  }
  return archives;
}

export async function createReleasePlan({ sourceRoot = ownRoot, buildRoot, channel = 'alpha.1', date, publicCommit = process.env.ZZ_BOARD_SOURCE_COMMIT, executableVersion, auditOptions = {} } = {}) {
  const root = path.resolve(sourceRoot), exported = await createBuildSourcePlan({ sourceRoot: root, channel, date, publicCommit });
  const build = path.resolve(buildRoot || path.join(root, 'src-tauri', 'target', 'release'));
  if (!within(path.join(root, 'src-tauri', 'target'), build)) throw new Error('Build must be an explicitly selected generated desktop target.');
  await assertNoLinks(build);
  const config = JSON.parse(await readFile(path.join(root, 'src-tauri', 'tauri.conf.json')));
  const cargo = await readFile(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
  if (config.version !== exported.version || !new RegExp(`^version\\s*=\\s*"${exported.version.replaceAll('.', '\\.') }"`, 'm').test(cargo)) throw new Error('Application package/Tauri/Cargo versions do not agree.');
  const executable = path.join(build, 'zz-board.exe'); await assertNoLinks(executable);
  if (!(await lstat(executable)).isFile()) throw new Error('Desktop executable missing.');
  const actualVersion = executableVersion ? await executableVersion(executable) : process.platform === 'win32' ? powershell({ file: executable }, '(Get-Item -LiteralPath $zzReleaseArgs.file).VersionInfo.ProductVersion') : null;
  if (actualVersion !== exported.version) throw new Error('Actual Windows executable version differs or could not be inspected.');
  const runtime = path.join(build, 'resources', 'runtime'); await assertNoLinks(runtime);
  const runtimeManifest = await readFile(path.join(runtime, 'manifest.json'));
  const runtimeFiles = await verifyRuntime(runtime, exported.version), runtimeMetadata = JSON.parse(runtimeManifest);
  if (sha(await readFile(path.join(runtime, 'manifest.json'))) !== sha(runtimeManifest)) throw new Error('Runtime manifest changed during inspection.');
  if (runtimeMetadata.platform !== 'win32' || runtimeMetadata.arch !== 'x64') throw new Error('Expected a Windows x64 runtime.');
  if (runtimeMetadata.releaseChannel !== channel) throw new Error('Runtime release channel differs from the selected package channel.');
  const executableBytes = await readFile(executable);
  if (embeddedSlot(executableBytes) !== 'zzb-runtime-' + sha(runtimeManifest)) throw new Error('Executable and runtime manifest fingerprints do not match.');
  const thirdParty = await collectDependencyNotices({ sourceRoot: root, nodeVersion: runtimeMetadata.nodeVersion.replace(/^v/, ''), ...auditOptions });
  const blockers = [...exported.blockers, ...thirdParty.report.blockers, 'sourceBuildCorrespondenceUnverified'];
  if (exported.gates.windowsBinaryDistributionApproved !== true) blockers.push('windowsBinaryDistributionNotApproved');
  const mplSources = verifyMplSources(exported, thirdParty.report.copyleft, blockers);
  if (runtimeMetadata.declaredBuild !== 'official' || runtimeMetadata.sourceCommit !== exported.gates.exactPublicCommit) blockers.push('runtimeOfficialBuildUnverified');
  return { root, exported, build, executable, executableSha256: sha(executableBytes), runtime, runtimeFiles, runtimeManifestSha256: sha(runtimeManifest), runtimeMetadata, thirdParty, mplSources, blockers, stem: `ZZ-Board-${exported.version}-${channel}-windows-x64`, sourceStem: `ZZ-Board-${exported.version}-${channel}-source` };
}

export const publicCommitMatches = publicGitMatches;

export function assertPackageOutput(root, target) {
  const destination = path.resolve(root, target);
  if (destination === root || within(destination, root)) throw new Error('Package output cannot overwrite source or desktop targets.');
  if (within(root, destination)) {
    const parts = path.relative(root, destination).split(path.sep);
    if (!['artifacts', '.tmp'].includes(parts[0]) || parts.some(part => ['.local-data', '.harness-backups', 'node_modules', '.git', 'target'].includes(part.toLowerCase()))) throw new Error('Package output must use artifacts or an owned .tmp directory, outside private data and source directories.');
  }
  return destination;
}

export function assertAuditOutput(root, target) {
  const destination = path.resolve(root, target);
  if (destination.split(path.sep).some(part => ['.local-data', '.harness-backups', 'node_modules', '.git'].includes(part.toLowerCase()))) throw new Error('Audit output cannot enter private data or dependency directories.');
  if (within(path.join(root, 'docs', 'public-launch'), destination)) return destination;
  assertPackageOutput(root, destination);
  return destination;
}

async function makeZip(directory, file) {
  if (process.platform !== 'win32') throw new Error('Portable packaging currently uses Windows ZipFile.');
  powershell({ directory, file }, 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($zzReleaseArgs.directory,$zzReleaseArgs.file,[System.IO.Compression.CompressionLevel]::Optimal,$true)');
}

export async function packagePublicRelease({ sourceRoot = ownRoot, buildRoot, output, channel = 'alpha.1', date, publicCommit = process.env.ZZ_BOARD_SOURCE_COMMIT, apply = false, reviewCandidate = false, build = false, ...testing } = {}) {
  const root = path.resolve(sourceRoot);
  const privacy = publicBuildPrivacy(root);
  let buildReceipt = null;
  let selectedDate = date;
  if (build) {
    if (!apply || process.platform !== 'win32') throw new Error('--build requires --apply on Windows.');
    if (buildRoot && path.resolve(buildRoot) !== path.join(root, 'src-tauri', 'target', 'release')) throw new Error('--build cannot attest a custom desktop target. Use the default target or package a separately reviewed candidate.');
    const before = await createBuildSourcePlan({ sourceRoot: root, channel, date: selectedDate, publicCommit });
    selectedDate = before.date;
    powershell({ root, publicCommit: publicCommit || null, rustFlags: privacy.encodedRustFlags }, 'Set-Location -LiteralPath $zzReleaseArgs.root; $env:CARGO_ENCODED_RUSTFLAGS=$zzReleaseArgs.rustFlags; if ($zzReleaseArgs.publicCommit) { $env:ZZ_BOARD_SOURCE_COMMIT=$zzReleaseArgs.publicCommit }; & pnpm desktop:build; if ($LASTEXITCODE -ne 0) { throw "Desktop build failed." }');
    const after = await createBuildSourcePlan({ sourceRoot: root, channel, date: selectedDate, publicCommit });
    if (before.sourceDigest !== after.sourceDigest) throw new Error('Source changed during the desktop build.');
    buildReceipt = { sourceDigest: after.sourceDigest, correspondingPublicSourceVerified: before.verifiedPublicSource && after.verifiedPublicSource, command: 'pnpm desktop:build', result: 'exit0 in this packaging process' };
  }
  const plan = await createReleasePlan({ sourceRoot: root, buildRoot, channel, date: selectedDate, publicCommit, ...testing });
  if (buildReceipt?.correspondingPublicSourceVerified) plan.blockers = plan.blockers.filter(item => item !== 'sourceBuildCorrespondenceUnverified');
  if (!apply) return plan;
  if (!reviewCandidate && plan.blockers.length) throw new Error(`Publication gates incomplete: ${plan.blockers.join(', ')}`);
  if (!output) throw new Error('--apply requires an explicit output directory.');
  const destination = assertPackageOutput(root, output);
  await assertNoLinks(destination, true);
  try { if (!(await lstat(destination)).isDirectory() || (await readdir(destination)).length) throw new Error('Package output must be absent or empty.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(destination, { recursive: true }); await assertNoLinks(destination);
  const portable = path.join(destination, plan.stem), source = path.join(destination, plan.sourceStem);
  await mkdir(portable); await mkdir(source);
  const inventory = [];
  const put = async (relative, bytes) => {
    privacy.checkFile(relative, bytes);
    const target = path.join(portable, ...relative.split('/'));
    if (!within(portable, target)) throw new Error('Unsafe portable destination.');
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx' });
    inventory.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) });
  };
  const executableBytes = await readFile(plan.executable);
  if (sha(executableBytes) !== plan.executableSha256) throw new Error('Executable changed after package inspection.');
  await put('zz-board.exe', executableBytes);
  for (const [sourcePath, outputPath] of [
    ['scripts/install-portable.cmd', '安装或更新 ZZ Board.cmd'],
    ['scripts/install-portable.mjs', 'scripts/install-portable.mjs'],
    ['scripts/desktop-runtime.ts', 'scripts/desktop-runtime.ts'],
  ]) {
    const entry = plan.exported.files.find(file => file.destination === sourcePath);
    if (!entry) throw new Error('Required portable install helper missing from reviewed source: ' + sourcePath);
    await put(outputPath, entry.bytes);
  }
  for (const file of [...plan.runtimeFiles, { path: 'manifest.json', sha256: plan.runtimeManifestSha256 }]) {
    const bytes = await readFile(path.join(plan.runtime, ...file.path.split('/')));
    if (sha(bytes) !== file.sha256 || (file.bytes !== undefined && bytes.length !== file.bytes)) throw new Error('Runtime changed after package inspection.');
    await put(`resources/runtime/${file.path}`, bytes);
  }
  for (const name of ['LICENSE', 'PRIVACY.md', 'CONTRIBUTING.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md']) {
    const entry = plan.exported.files.find(file => file.destination === name); if (entry) await put(name, entry.bytes);
  }
  for (const name of ['docs/USER_AGENT_GUIDE.md', 'docs/AGENT_CUSTOMIZATION.md', 'docs/DEPLOYMENT_QUICKSTART.md']) {
    const entry = plan.exported.files.find(file => file.destination === name); if (entry) await put(name, entry.bytes);
  }
  await put('AGENT_START_HERE.md', Buffer.from('# ZZ Board Agent help\n\nRead docs/USER_AGENT_GUIDE.md and docs/AGENT_CUSTOMIZATION.md in this package first. You can explain operation and import an existing .zzskin without a source checkout. To create/validate a Skin or change code, download the matching source ZIP named in SOURCE.txt and work in its directory; the tools and canonical Skills are in that source ZIP. Do not patch this EXE. Reading Codex history, model calls, installing Skills, and cloud deployment require the user\'s explicit choice.\n'));
  await put('THIRD-PARTY-LICENSES.txt', Buffer.from(plan.thirdParty.notices));
  for (const entry of plan.mplSources) await put('third-party-source/' + path.posix.basename(entry.destination), entry.bytes);
  await put('DEPENDENCY_AUDIT.json', Buffer.from(`${JSON.stringify(plan.thirdParty.report, null, 2)}\n`));
  await put('SOURCE.txt', Buffer.from(`Corresponding source asset: ${plan.sourceStem}.zip\nSource export SHA256: ${plan.exported.sourceDigest}\nThis package is ${plan.blockers.length ? 'an unpublished review candidate' : 'ready for separately approved publication'}.\n`));
  for (const file of plan.exported.files) {
    privacy.checkFile(file.destination, file.bytes);
    const target = path.join(source, ...file.destination.split('/'));
    if (!within(source, target)) throw new Error('Unsafe source archive destination.');
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, file.bytes, { flag: 'wx' });
    if (sha(await readFile(target)) !== file.sha256) throw new Error('Source archive byte verification failed.');
  }
  const current = await createBuildSourcePlan({ sourceRoot: root, channel, date: plan.exported.date, publicCommit });
  if (current.sourceDigest !== plan.exported.sourceDigest) throw new Error('Source changed during packaging.');
  if (sha(await readFile(plan.executable)) !== inventory.find(item => item.path === 'zz-board.exe').sha256) throw new Error('Executable changed during packaging.');
  await verifyRuntime(plan.runtime, plan.exported.version);
  if (sha(await readFile(path.join(plan.runtime, 'manifest.json'))) !== plan.runtimeManifestSha256) throw new Error('Runtime manifest changed during packaging.');
  if (!publicCommitMatches(root, plan.exported.gates.exactPublicCommit)) {
    if (!plan.blockers.includes('publicSourceCommitUnverified')) plan.blockers.push('publicSourceCommitUnverified');
    if (!reviewCandidate) throw new Error('Public source commit or clean-tree state changed during packaging.');
  }
  for (const item of inventory) if (sha(await readFile(path.join(portable, ...item.path.split('/')))) !== item.sha256) throw new Error('Portable copy verification failed.');
  const manifest = { schemaVersion: 1, applicationVersion: plan.exported.version, channel, sourceDigest: plan.exported.sourceDigest, sourceAsset: `${plan.sourceStem}.zip`, buildReceipt, exactPublicCommit: plan.exported.gates.exactPublicCommit || null, declaredBuild: plan.runtimeMetadata.declaredBuild || 'unknown', publicationReady: plan.blockers.length === 0, blockers: plan.blockers, files: inventory };
  await put('PUBLIC_PACKAGE_MANIFEST.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  const sourceManifest = { schemaVersion: 1, appVersion: plan.exported.version, channel, date: plan.exported.date, sourceDigest: plan.exported.sourceDigest, publicationReady: plan.blockers.length === 0, blockers: plan.blockers, files: plan.exported.files.map(file => ({ path: file.destination, bytes: file.bytes.length, sha256: file.sha256 })) };
  const sourceManifestBytes = Buffer.from(`${JSON.stringify(sourceManifest, null, 2)}\n`);
  privacy.checkFile('PUBLIC_SOURCE_MANIFEST.json', sourceManifestBytes);
  await writeFile(path.join(source, 'PUBLIC_SOURCE_MANIFEST.json'), sourceManifestBytes, { flag: 'wx' });
  const portableZip = path.join(destination, `${plan.stem}.zip`), sourceZip = path.join(destination, `${plan.sourceStem}.zip`);
  await makeZip(portable, portableZip); await makeZip(source, sourceZip);
  const checksums = [`${sha(await readFile(portableZip))}  ${path.basename(portableZip)}`, `${sha(await readFile(sourceZip))}  ${path.basename(sourceZip)}`].join('\n');
  await writeFile(path.join(destination, 'SHA256SUMS.txt'), `${checksums}\n`, { flag: 'wx' });
  return plan;
}

async function main() {
  const args = process.argv.slice(2).filter(item => item !== '--'), options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (['--apply', '--review-candidate', '--audit-only', '--build'].includes(key)) options[{ '--apply': 'apply', '--review-candidate': 'reviewCandidate', '--audit-only': 'auditOnly', '--build': 'build' }[key]] = true;
    else if (['--source', '--build-root', '--output', '--channel', '--date', '--report', '--notices', '--public-commit'].includes(key)) { const value = args[++index]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`); options[{ '--source': 'sourceRoot', '--build-root': 'buildRoot', '--public-commit': 'publicCommit' }[key] || key.slice(2)] = value; }
    else throw new Error(`Unknown option: ${key}`);
  }
  if (options.auditOnly) {
    const result = await collectDependencyNotices(options);
    if (options.apply) {
      if (!options.report || !options.notices) throw new Error('Audit --apply requires explicit --report and --notices.');
      for (const [file, value] of [[options.report, `${JSON.stringify(result.report, null, 2)}\n`], [options.notices, result.notices]]) {
        const target = assertAuditOutput(path.resolve(options.sourceRoot || ownRoot), file); await assertNoLinks(target, true);
        await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, value, { flag: 'wx' });
      }
    }
    console.log(JSON.stringify({ mode: 'dependency-inventory', records: result.report.records.length, blockers: result.report.blockers, reviewNotes: result.report.reviewNotes, copyleft: result.report.copyleft, legalClearance: false }, null, 2));
    return;
  }
  const plan = await packagePublicRelease(options);
  console.log(JSON.stringify({ mode: options.apply ? 'packaged-for-review' : 'dry-run', version: plan.exported.version, channel: plan.exported.channel, runtimeFiles: plan.runtimeFiles.length, dependencyRecords: plan.thirdParty.report.records.length, sourceDigest: plan.exported.sourceDigest, publicationReady: plan.blockers.length === 0, blockers: plan.blockers }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`Public package failed: ${error.message}`); process.exitCode = 1; });
