import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ownRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const textExtensions = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js', '.rs', '.toml', '.css', '.html', '.json', '.yaml', '.yml', '.md', '.txt', '.ps1', '.cmd', '.nsh', '.svg']);
const hash = value => createHash('sha256').update(value).digest('hex');
const slash = value => value.replaceAll('\\', '/');
const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
export const within = (root, candidate) => { const rel = path.relative(path.resolve(root), path.resolve(candidate)); return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const commonPublicationGates = [
  'licenseApproved', 'copyrightOwnershipConfirmed', 'thirdPartyObligationsReviewed',
  'syntheticScreenshotReviewed', 'firstRunVerified', 'nativeWindowsAcceptanceVerified', 'cleanPublicBuildVerified',
];
// Keep the original schema-v1 export for callers that use the CloudBase gates.
export const publicationGates = [
  ...commonPublicationGates, 'privacyDeploymentVerified', 'cloudReceiptVerified', 'cloudDeletionVerified', 'cloudPrivacyRetentionVerified',
];
function gatesForFeedbackChannel(channel = 'cloudbase') {
  if (channel === 'cloudbase') return publicationGates;
  if (channel === 'github-issues') return [...commonPublicationGates, 'githubIssueFormsVerified', 'githubFeedbackPrivacyVerified'];
  throw new Error('Unsupported feedbackChannel in release gates. Select github-issues or cloudbase.');
}
export function publicGitMatches(root, expected) {
  if (!/^[a-f0-9]{40}$/.test(expected || '')) return false;
  try {
    const options = { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], options).trim() === expected && !execFileSync('git', ['-C', root, 'status', '--porcelain'], options).trim();
  } catch { return false; }
}

export async function assertNoLinks(file, allowMissing = false) {
  const absolute = path.resolve(file), parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = await lstat(cursor); } catch (error) { if (allowMissing && error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw new Error('Symbolic links and junctions are not allowed.');
  }
  if (!samePath(await realpath(absolute), absolute)) throw new Error('Resolved path differs from its checked physical path.');
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':') || value.startsWith('/')
    || value.split('/').some(part => !part || part === '.' || part === '..') || /[\u0000-\u001f<>"|?*]/.test(value)) throw new Error('Invalid public relative path.');
  return value;
}

function normalized(relative, bytes) {
  if (!textExtensions.has(path.extname(relative).toLowerCase())) return bytes;
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`Public text must be UTF-8: ${relative}`);
  // Official license/source evidence keeps exact bytes for upstream blob and
  // SHA-256 provenance; source code and editable templates use stable EOLs.
  if (relative.startsWith('docs/public-launch/licenses/') || relative.startsWith('docs/public-launch/third-party-source-evidence/')) return bytes;
  const lf = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  return Buffer.from(/\.(ps1|cmd)$/i.test(relative) ? lf.replaceAll('\n', '\r\n') : lf);
}

function publicContentCheck(relative, bytes, sourceRoot) {
  const text = bytes.toString('utf8');
  const rootVariants = [sourceRoot, slash(sourceRoot), sourceRoot.replaceAll('\\', '\\\\')];
  if (rootVariants.some(value => value.length > 6 && text.includes(value))) throw new Error(`Machine-specific source path found in public candidate: ${relative}`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bsk-(?!fake|synthetic|test)[A-Za-z0-9_-]{32,}\b/.test(text)) throw new Error(`Possible credential found in public candidate: ${relative}`);
}

async function optionalRead(root, relative) {
  safeRelative(relative); const file = path.join(root, ...relative.split('/'));
  if (!within(root, file)) throw new Error('Source file escaped the export root.');
  try { await assertNoLinks(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const stat = await lstat(file);
  if (!stat.isFile()) throw new Error(`Expected a regular source file: ${relative}`);
  return { file, bytes: await readFile(file), stat };
}

export async function createPublicExportPlan({ sourceRoot = ownRoot, channel = 'alpha.1', date = new Date().toISOString().slice(0, 10), publicCommit = process.env.ZZ_BOARD_SOURCE_COMMIT } = {}) {
  if (!/^(alpha|beta|rc)\.\d+$/.test(channel)) throw new Error('Invalid candidate channel.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) throw new Error('Invalid release record date.');
  if (publicCommit && !/^[a-f0-9]{40}$/.test(publicCommit)) throw new Error('Invalid external public source commit.');
  const root = path.resolve(sourceRoot); await assertNoLinks(root);
  const policySource = await optionalRead(root, 'docs/public-launch/export-policy.json');
  if (!policySource) throw new Error('The reviewed public export policy is missing.');
  const policy = JSON.parse(policySource.bytes);
  if (policy.schemaVersion !== 1 || !Number.isSafeInteger(policy.maxFiles) || policy.maxFiles < 1 || !Number.isSafeInteger(policy.maxFileBytes) || policy.maxFileBytes < 1) throw new Error('Invalid export policy.');
  const pkgSource = await optionalRead(root, 'package.json'); if (!pkgSource) throw new Error('package.json missing.');
  const pkg = JSON.parse(pkgSource.bytes);
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Expected a stable application version with a separate candidate channel.');
  const gatesSource = await optionalRead(root, 'docs/public-launch/release-gates.json');
  if (!gatesSource) throw new Error('Release gates missing.'); const gates = { ...JSON.parse(gatesSource.bytes), ...(publicCommit ? { exactPublicCommit: publicCommit } : {}) };
  if (gates.schemaVersion !== 1 || gates.repository !== 'zh3zhou/zz-board') throw new Error('Unexpected release gate contract.');
  const requiredGates = gatesForFeedbackChannel(gates.feedbackChannel);
  const entries = new Map(), caseNames = new Set(), skipped = [];
  const exclusions = new Set(policy.excludedSegments.map(value => value.toLowerCase()));
  const excludedFiles = new Set(policy.excludedFiles.map(value => value.toLowerCase()));
  const forbidden = value => value.split('/').some(part => exclusions.has(part.toLowerCase()) || (part.startsWith('.') && !['.github', '.gitignore', '.gitattributes', '.env.example', '.gitkeep'].includes(part))) || excludedFiles.has(path.posix.basename(value).toLowerCase()) || /(?:\.sqlite(?:-.*)?|\.log|\.zip|\.exe|\.dll|\.pdb)$/i.test(value);
  const add = async (source, destination = source, transform) => {
    safeRelative(source); safeRelative(destination);
    if (forbidden(destination) && destination !== 'src-tauri/resources/runtime/.gitkeep') throw new Error(`Forbidden public destination: ${destination}`);
    const read = await optionalRead(root, source); if (!read) return false;
    if (read.stat.size > policy.maxFileBytes) throw new Error(`Source exceeds the reviewed size limit: ${source}`);
    if (entries.has(destination) || caseNames.has(destination.toLowerCase())) throw new Error(`Duplicate public destination: ${destination}`);
    const bytes = normalized(destination, transform ? transform(read.bytes) : read.bytes);
    publicContentCheck(destination, bytes, root);
    entries.set(destination, { source, destination, preimage: hash(read.bytes), bytes, sha256: hash(bytes), transformed: !!transform || !read.bytes.equals(bytes) });
    caseNames.add(destination.toLowerCase());
    if (entries.size > policy.maxFiles) throw new Error('Export exceeds the reviewed file limit.');
    return true;
  };
  const walk = async relative => {
    safeRelative(relative); if (forbidden(relative)) return;
    const directory = path.join(root, ...relative.split('/'));
    try { await assertNoLinks(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!(await lstat(directory)).isDirectory()) throw new Error(`Expected source directory: ${relative}`);
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = `${relative}/${item.name}`;
      // Excluded private directories are never enumerated or opened.
      if (forbidden(next)) { skipped.push(next); continue; }
      if (item.isSymbolicLink()) throw new Error(`Source link rejected: ${next}`);
      if (item.isDirectory()) await walk(next);
      else if (item.isFile() && policy.sourceExtensions.includes(path.extname(item.name).toLowerCase())) await add(next);
      else skipped.push(next);
    }
  };
  for (const file of policy.rootFiles) {
    const transform = file === 'package.json' ? bytes => {
      const value = JSON.parse(bytes); value.repository = { type: 'git', url: 'https://github.com/zh3zhou/zz-board.git' };
      value.homepage = 'https://github.com/zh3zhou/zz-board#readme';
      value.license = gates.licenseApproved ? 'SEE LICENSE IN LICENSE' : 'UNLICENSED';
      return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    } : undefined;
    if (!await add(file, file, transform) && policy.requiredRootFiles.includes(file)) throw new Error(`Required source missing: ${file}`);
  }
  for (const tree of [...policy.trees, ...policy.desktopTrees]) await walk(tree);
  for (const file of policy.desktopFiles) if (!await add(file) && (policy.requiredDesktopFiles || []).includes(file)) throw new Error(`Required desktop source missing: ${file}`);
  for (const file of policy.publicDocs) await add(file);
  // The public launch templates/policy and third-party texts remain usable in
  // the exported source. Original private project memory is never read.
  await walk('docs/public-launch');
  const screenshot = entries.has('docs/public-launch/assets/board-synthetic.png');
  const screenshotText = screenshot ? '![ZZ Board 合成演示画布](docs/public-launch/assets/board-synthetic.png)\n\n图中数据是合成示例；不是外部用户案例。' : '';
  for (const [template, destination] of Object.entries(policy.templateMap)) {
    const added = await add(`docs/public-launch/${template}`, destination, bytes => {
      const value = bytes.toString('utf8').replaceAll('{{VERSION}}', pkg.version).replaceAll('{{CHANNEL}}', channel)
        .replaceAll('{{RELEASE_DATE}}', date).replaceAll('{{SCREENSHOT}}', screenshotText);
      if (/\{\{[A-Z_]+\}\}/.test(value)) throw new Error(`Unresolved public template: ${template}`);
      return Buffer.from(value);
    });
    if (!added) throw new Error(`Required public template missing: ${template}`);
  }
  if (policy.agentAdapterProvenance || policy.agentAdapterMap) {
    const provenanceSource = await optionalRead(root, policy.agentAdapterProvenance);
    if (!provenanceSource) throw new Error('Public Agent adapter provenance missing.');
    const provenance = JSON.parse(provenanceSource.bytes);
    if (provenance.schemaVersion !== 1 || provenance.generator?.name !== 'agent-ready' || !/^\d+\.\d+\.\d+$/.test(provenance.generator.version || '')) throw new Error('Invalid public Agent adapter provenance.');
    for (const template of ['agent.project.public.yaml', 'AGENTS.public.md']) {
      const relative = `docs/public-launch/${template}`, source = await optionalRead(root, relative);
      if (!source || hash(normalized(relative, source.bytes)) !== provenance.templates?.[template]) throw new Error(`Stale public Agent adapter template: ${template}. Regenerate in an isolated public candidate.`);
    }
    for (const [file, destination] of Object.entries(policy.agentAdapterMap)) {
      const relative = `docs/public-launch/agent-adapters/${safeRelative(file)}`, source = await optionalRead(root, relative);
      if (!source || hash(normalized(relative, source.bytes)) !== provenance.files?.[file] || !source.bytes.toString('utf8').includes('<!-- generated_by: agent-ready -->')) throw new Error(`Changed or missing generated public Agent adapter: ${file}.`);
      await add(relative, destination);
    }
  }
  const files = [...entries.values()].sort((a, b) => a.destination < b.destination ? -1 : a.destination > b.destination ? 1 : 0);
  const sourceDigest = hash(files.map(file => `${file.destination}\0${file.bytes.length}\0${file.sha256}\n`).join(''));
  const blockers = [];
  for (const key of requiredGates) if (gates[key] !== true) blockers.push(key);
  if (gates.feedbackChannel === 'github-issues') {
    const forms = ['.github/ISSUE_TEMPLATE/bug.yml', '.github/ISSUE_TEMPLATE/feature.yml'];
    if (forms.some(file => !entries.get(file)?.bytes.toString('utf8').trim())) blockers.push('githubIssueFormsMissing');
  }
  if (!/^[a-f0-9]{40}$/.test(gates.exactPublicCommit || '')) blockers.push('exactPublicCommit');
  if (!publicGitMatches(root, gates.exactPublicCommit)) blockers.push('publicSourceCommitUnverified');
  const publicManifestSource = await optionalRead(root, 'PUBLIC_SOURCE_MANIFEST.json');
  let previousManifest;
  try { previousManifest = publicManifestSource && JSON.parse(publicManifestSource.bytes); } catch { /* incomplete source identity remains a blocker */ }
  const manifestEntries = Array.isArray(previousManifest?.files) ? new Map(previousManifest.files.map(file => [file.path, file])) : new Map();
  const manifestFilesMatch = manifestEntries.size === files.length && previousManifest?.files?.length === files.length && files.every(file => manifestEntries.get(file.destination)?.sha256 === file.sha256 && manifestEntries.get(file.destination)?.bytes === file.bytes.length);
  if (previousManifest?.schemaVersion !== 1 || !manifestFilesMatch || previousManifest.sourceDigest !== sourceDigest || previousManifest.appVersion !== pkg.version || previousManifest.channel !== channel || previousManifest.date !== date) blockers.push('publicSourceExportManifestUnverified');
  if (/OWNER REVIEW DRAFT|Draft status:/i.test(entries.get('LICENSE').bytes.toString('utf8'))) blockers.push('licenseTextStillDraft');
  if (!screenshot) blockers.push('syntheticScreenshotMissing');
  return { root, version: pkg.version, channel, date, sourceDigest, files, skipped, blockers, gates };
}

async function emptyTarget(target, root) {
  if (!path.isAbsolute(target)) throw new Error('Export output must be an explicit absolute path.');
  const output = path.resolve(target);
  if (samePath(root, output) || within(root, output) || within(output, root)) throw new Error('Public export must be separate from the private source checkout.');
  await assertNoLinks(output, true);
  try { if (!(await lstat(output)).isDirectory() || (await readdir(output)).length) throw new Error('Export output must be absent or empty.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return output;
}

export async function exportPublicSource({ sourceRoot = ownRoot, output, audit, channel = 'alpha.1', date, publicCommit, apply = false, requireReady = false } = {}) {
  const plan = await createPublicExportPlan({ sourceRoot, channel, date, publicCommit });
  if (requireReady && plan.blockers.length) throw new Error(`Public release gates incomplete: ${plan.blockers.join(', ')}`);
  if (!apply) return plan;
  if (!output || !audit || !path.isAbsolute(audit)) throw new Error('--apply requires absolute output and private audit paths.');
  const destination = await emptyTarget(output, plan.root), auditPath = path.resolve(audit);
  if (samePath(auditPath, destination) || within(destination, auditPath) || within(plan.root, auditPath)) throw new Error('Audit material must stay outside both source and public export.');
  await assertNoLinks(auditPath, true);
  try { await lstat(auditPath); throw new Error('Audit file already exists.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const original = async () => {
    for (const file of plan.files) {
      const read = await optionalRead(plan.root, file.source);
      if (!read || hash(read.bytes) !== file.preimage) throw new Error(`Source changed during export: ${file.source}`);
    }
  };
  await original();
  await mkdir(path.dirname(auditPath), { recursive: true });
  const metadata = { schemaVersion: 1, state: 'writing', sourceRoot: plan.root, destination, createdAt: new Date().toISOString(), sourceDigest: plan.sourceDigest, version: plan.version, channel, blockers: plan.blockers, files: plan.files.map(({ source, destination: file, preimage, sha256, transformed, bytes }) => ({ source, destination: file, preimage, postimage: sha256, bytes: bytes.length, transformed })) };
  try {
    metadata.gitHead = execFileSync('git', ['-C', plan.root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    metadata.gitBranch = execFileSync('git', ['-C', plan.root, 'branch', '--show-current'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { metadata.gitHead = null; metadata.gitBranch = null; }
  await writeFile(auditPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
  // No deletion/rollback of an interrupted export: leave the exact owned
  // candidate plus audit for inspection, never overwrite a nonempty target.
  await mkdir(destination, { recursive: true });
  for (const file of plan.files) {
    const target = path.join(destination, ...file.destination.split('/'));
    if (!within(destination, target)) throw new Error('Public write escaped output.');
    await assertNoLinks(path.dirname(target), true);
    await mkdir(path.dirname(target), { recursive: true }); await assertNoLinks(path.dirname(target));
    await writeFile(target, file.bytes, { flag: 'wx' });
    if (hash(await readFile(target)) !== file.sha256) throw new Error(`Export verification failed: ${file.destination}`);
  }
  await original();
  const publicManifest = { schemaVersion: 1, appVersion: plan.version, channel, date: plan.date, exactPublicCommit: plan.gates.exactPublicCommit || null, sourceDigest: plan.sourceDigest, publicationReady: plan.blockers.length === 0, blockers: plan.blockers, files: metadata.files.map(({ destination: file, bytes, postimage }) => ({ path: file, bytes, sha256: postimage })) };
  await writeFile(path.join(destination, 'PUBLIC_SOURCE_MANIFEST.json'), `${JSON.stringify(publicManifest, null, 2)}\n`, { flag: 'wx' });
  metadata.state = 'verified'; metadata.publicManifestSha256 = hash(await readFile(path.join(destination, 'PUBLIC_SOURCE_MANIFEST.json')));
  await writeFile(auditPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return plan;
}

async function main() {
  const args = process.argv.slice(2).filter(arg => arg !== '--'), options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (['--apply', '--require-ready'].includes(key)) options[key === '--apply' ? 'apply' : 'requireReady'] = true;
    else if (['--source', '--output', '--audit', '--channel', '--date', '--public-commit'].includes(key)) { const value = args[++index]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`); options[{ '--source': 'sourceRoot', '--public-commit': 'publicCommit' }[key] || key.slice(2)] = value; }
    else throw new Error(`Unknown option: ${key}`);
  }
  const plan = await exportPublicSource(options);
  console.log(JSON.stringify({ mode: options.apply ? 'exported-and-verified' : 'dry-run', version: plan.version, channel: plan.channel, files: plan.files.length, bytes: plan.files.reduce((sum, file) => sum + file.bytes.length, 0), sourceDigest: plan.sourceDigest, publicationReady: plan.blockers.length === 0, blockers: plan.blockers, boundary: 'No history, original private project memory, deployment or GitHub action included.' }, null, 2));
}
if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) main().catch(error => { console.error(`Public export failed: ${error.message}`); process.exitCode = 1; });
