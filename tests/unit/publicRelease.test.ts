import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const exporter = await import(new URL('../../scripts/export-public-source.mjs', import.meta.url).href);
const packager = await import(new URL('../../scripts/package-public-release.mjs', import.meta.url).href);
const temporaryParent = await realpath(os.tmpdir());
let temporary: string, project: string, destination: string, audit: string;
const links = new Set<string>();
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

async function put(relative: string, contents: string | Buffer) {
  const file = path.join(project, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, contents);
}
async function junction(link: string, target: string) {
  await mkdir(path.dirname(link), { recursive: true }); await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); links.add(link);
}
async function fixture() {
  await mkdir(project);
  await put('package.json', JSON.stringify({ name: 'synthetic-board', version: '0.0.1', private: true, license: 'UNLICENSED', dependencies: {}, devDependencies: {} }));
  await put('pnpm-lock.yaml', 'Synthetic lockfile, never installed.\n');
  await put('LICENSE', 'OWNER REVIEW DRAFT\nSynthetic license fixture only.\n');
  await put('src/board.ts', 'export const syntheticValue = "current uncommitted source";\r\n');
  await put('scripts/synthetic.ps1', 'Write-Output "synthetic"\n');
  await put('cloudbase/feedback/scf_bootstrap', '#!/bin/bash\n# synthetic bootstrap, never executed\n');
  await put('src-tauri/Cargo.toml', '[package]\nname="synthetic-board"\nversion="0.0.1"\n');
  await put('src-tauri/Cargo.lock', '# synthetic cargo lock\n');
  await put('src-tauri/tauri.conf.json', JSON.stringify({ version: '0.0.1' }));
  await put('docs/public-launch/README.public.md', '# Synthetic {{VERSION}} / {{CHANNEL}}\n{{SCREENSHOT}}\n');
  await put('docs/public-launch/PROGRESS.public.md', '# Public {{VERSION}} at {{RELEASE_DATE}}\n');
  await put('docs/public-launch/release-gates.json', JSON.stringify({ schemaVersion: 1, repository: 'zh3zhou/zz-board', licenseApproved: false }));
  await put('docs/public-launch/export-policy.json', JSON.stringify({
    schemaVersion: 1, rootFiles: ['package.json', 'pnpm-lock.yaml', 'LICENSE', 'cloudbase/feedback/scf_bootstrap'], requiredRootFiles: ['package.json', 'pnpm-lock.yaml', 'LICENSE', 'cloudbase/feedback/scf_bootstrap'], trees: ['src', 'scripts'], sourceExtensions: ['.ts', '.mjs', '.ps1', '.md', '.json', '.txt', '.png'], desktopTrees: [], desktopFiles: ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json'], publicDocs: [], templateMap: { 'README.public.md': 'README.md', 'PROGRESS.public.md': 'PROGRESS.md' }, excludedSegments: ['.git', '.local-data', '.tmp', '.harness-backups', 'node_modules', 'target', 'dist', 'exports'], excludedFiles: ['install-autostart.ps1'], maxFiles: 100, maxFileBytes: 100_000,
  }));
}

beforeEach(async () => {
  temporary = await realpath(await mkdtemp(path.join(temporaryParent, 'zz-public-release-test-')));
  project = path.join(temporary, 'project'); destination = path.join(temporary, 'public-source'); audit = path.join(temporary, 'private-audit', 'export.json');
  await fixture();
});
afterEach(async () => {
  for (const link of links) {
    if (!exporter.within(temporary, link)) throw new Error('Unsafe synthetic link cleanup.');
    try { await unlink(link); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  links.clear();
  if (path.dirname(temporary) !== temporaryParent || !path.basename(temporary).startsWith('zz-public-release-test-') || (await lstat(temporary)).isSymbolicLink() || await realpath(temporary) !== temporary) throw new Error('Unsafe synthetic fixture cleanup.');
  await rm(temporary, { recursive: true });
});

describe('public build machine paths', () => {
  it('remaps local roots for Rust and rejects them in package file bytes', () => {
    const profile = 'Q:\\fixture\\account', checkout = 'Q:\\fixture\\source tree';
    const privacy = packager.publicBuildPrivacy(checkout, { USERPROFILE: profile, CARGO_ENCODED_RUSTFLAGS: '-C\x1foverflow-checks=yes' });
    expect(privacy.encodedRustFlags.split('\x1f')).toContain('--remap-path-prefix=' + profile + '=/build/user');
    expect(privacy.encodedRustFlags.split('\x1f')).toContain('--remap-path-prefix=' + checkout + '=/build/zz-board');
    expect(privacy.encodedRustFlags.startsWith('-C\x1foverflow-checks=yes\x1f')).toBe(true);
    for (const bytes of [
      Buffer.from(checkout.toUpperCase() + '\\deps'), Buffer.from(checkout.replaceAll('\\', '/') + '/lib'),
      Buffer.from(JSON.stringify(profile + '\\.cargo')), Buffer.from(profile, 'utf16le'),
    ]) expect(() => privacy.checkFile('sample.bin', bytes)).toThrow(/local build path.*sample\.bin/i);
    expect(() => privacy.checkFile('sample.bin', Buffer.from('/build/user/.cargo/registry'))).not.toThrow();
  });
});

describe('reviewed public source export', { timeout: 60_000 }, () => {
  it('defaults to dry-run, takes current files, normalizes text, and does not change the private source', async () => {
    const before = await readFile(path.join(project, 'package.json'));
    const plan = await exporter.exportPublicSource({ sourceRoot: project, output: destination, audit, date: '2026-10-11' });
    const board = plan.files.find((file: { destination: string }) => file.destination === 'src/board.ts');
    expect(board.bytes.toString()).toContain('current uncommitted source'); expect(board.bytes.toString()).not.toContain('\r');
    expect(plan.files.find((file: { destination: string }) => file.destination === 'scripts/synthetic.ps1').bytes.toString()).toContain('\r\n');
    expect(plan.files.some((file: { destination: string }) => file.destination === 'cloudbase/feedback/scf_bootstrap')).toBe(true);
    expect(await readFile(path.join(project, 'package.json'))).toEqual(before);
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(audit)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(plan.blockers).toContain('licenseTextStillDraft');
  });
  it('never follows ignored private directories or reads original project memory', async () => {
    const privateTarget = path.join(temporary, 'synthetic-private-target'); await mkdir(privateTarget);
    await writeFile(path.join(privateTarget, 'keep.txt'), 'Synthetic private sentinel.');
    await junction(path.join(project, 'src', '.tmp'), privateTarget);
    await junction(path.join(project, '.local-data'), privateTarget);
    await junction(path.join(project, 'PROGRESS.md'), privateTarget);
    await put('.env', 'Synthetic unexported configuration.');
    const plan = await exporter.createPublicExportPlan({ sourceRoot: project });
    expect(plan.files.every((file: { source: string }) => file.source !== 'PROGRESS.md' && !file.source.includes('.local-data') && !file.source.includes('/.tmp/'))).toBe(true);
    expect(plan.files.some((file: { destination: string }) => file.destination === 'PROGRESS.md')).toBe(true);
    expect(await readFile(path.join(privateTarget, 'keep.txt'), 'utf8')).toBe('Synthetic private sentinel.');
  });
  it('writes only a separate empty tree and a private hash audit, with no history or private source paths in the public manifest', async () => {
    await put('.git', 'Synthetic invalid marker; exporter must not repair it.');
    const originalPackage = await readFile(path.join(project, 'package.json'));
    const plan = await exporter.exportPublicSource({ sourceRoot: project, output: destination, audit, apply: true, date: '2026-10-11' });
    const manifest = JSON.parse(await readFile(path.join(destination, 'PUBLIC_SOURCE_MANIFEST.json'), 'utf8'));
    expect(manifest.sourceDigest).toBe(plan.sourceDigest); expect(manifest.publicationReady).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain(project); expect(JSON.stringify(manifest)).not.toContain('gitHead');
    expect((await readdir(destination))).not.toContain('.git');
    expect(await readFile(path.join(destination, 'src/board.ts'), 'utf8')).toContain('current uncommitted source');
    expect(await readFile(path.join(destination, 'README.md'), 'utf8')).not.toContain('{{VERSION}}');
    expect(await readFile(path.join(destination, 'PROGRESS.md'), 'utf8')).toContain('Public 0.0.1');
    const privateAudit = JSON.parse(await readFile(audit, 'utf8'));
    expect(privateAudit.state).toBe('verified'); expect(privateAudit.sourceRoot).toBe(project);
    expect(privateAudit.files.find((file: { source: string }) => file.source === 'package.json').preimage).toBe(sha(originalPackage));
    expect(await readFile(path.join(project, 'package.json'))).toEqual(originalPackage);
    expect(await readFile(path.join(project, '.git'), 'utf8')).toContain('must not repair');
  });
  it('refuses nonempty output without changing its contents', async () => {
    await mkdir(destination); await writeFile(path.join(destination, 'keep.txt'), 'Keep existing public work.');
    await expect(exporter.exportPublicSource({ sourceRoot: project, output: destination, audit, apply: true })).rejects.toThrow(/absent or empty/);
    expect(await readFile(path.join(destination, 'keep.txt'), 'utf8')).toBe('Keep existing public work.');
  });
  it.each(['inside-source', 'source-itself', 'ancestor', 'relative', 'audit-in-output'])('rejects unsafe output/audit placement: %s', async scenario => {
    const output = scenario === 'inside-source' ? path.join(project, 'public') : scenario === 'source-itself' ? project : scenario === 'ancestor' ? temporary : scenario === 'relative' ? 'relative-public' : destination;
    const selectedAudit = scenario === 'audit-in-output' ? path.join(destination, 'audit.json') : audit;
    await expect(exporter.exportPublicSource({ sourceRoot: project, output, audit: selectedAudit, apply: true })).rejects.toThrow(/separate|absolute|outside/);
  });
  it('rejects a source junction without reading or altering its destination', async () => {
    const target = path.join(temporary, 'outside'); await mkdir(target); await writeFile(path.join(target, 'keep.ts'), 'Synthetic external source.');
    await junction(path.join(project, 'src', 'redirected'), target);
    await expect(exporter.createPublicExportPlan({ sourceRoot: project })).rejects.toThrow(/link|junction/i);
    expect(await readFile(path.join(target, 'keep.ts'), 'utf8')).toBe('Synthetic external source.');
  });
  it('rejects an output ancestor junction', async () => {
    const target = path.join(temporary, 'outside'); await mkdir(target);
    const parentLink = path.join(temporary, 'linked'); await junction(parentLink, target);
    await expect(exporter.exportPublicSource({ sourceRoot: project, output: path.join(parentLink, 'candidate'), audit, apply: true })).rejects.toThrow(/link|junction/i);
    expect(await readdir(target)).toEqual([]);
  });
  it('fails closed on personal source paths, possible credentials and missing required sources', async () => {
    await put('src/leak.ts', `export const privatePath = ${JSON.stringify(project)};`);
    await expect(exporter.createPublicExportPlan({ sourceRoot: project })).rejects.toThrow(/Machine-specific/);
    await put('src/leak.ts', '-----BEGIN ' + 'PRIVATE KEY-----\nSynthetic invalid key, never used.');
    await expect(exporter.createPublicExportPlan({ sourceRoot: project })).rejects.toThrow(/credential/);
    await put('src/leak.ts', 'Synthetic safe replacement.');
    await unlink(path.join(project, 'LICENSE'));
    await expect(exporter.createPublicExportPlan({ sourceRoot: project })).rejects.toThrow(/Required source missing/);
  });
  it('does not treat an exported draft as permission to publish', async () => {
    await expect(exporter.exportPublicSource({ sourceRoot: project, output: destination, audit, apply: true, requireReady: true })).rejects.toThrow(/gates incomplete/);
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([undefined, 'cloudbase'])('keeps the cloud, native and exact public commit gates for feedbackChannel=%s', async feedbackChannel => {
    const gates = Object.fromEntries(exporter.publicationGates.map((key: string) => [key, true]));
    const record = { schemaVersion: 1, repository: 'zh3zhou/zz-board', ...gates, feedbackChannel, exactPublicCommit: 'a'.repeat(40) };
    await put('LICENSE', 'Synthetic reviewed license fixture.');
    await put('docs/public-launch/assets/board-synthetic.png', Buffer.from('Synthetic image marker, never displayed.'));
    await put('docs/public-launch/release-gates.json', JSON.stringify(record));
    expect((await exporter.createPublicExportPlan({ sourceRoot: project })).blockers).toEqual(['publicSourceCommitUnverified', 'publicSourceExportManifestUnverified']);
    for (const key of ['privacyDeploymentVerified', 'cloudReceiptVerified', 'cloudDeletionVerified', 'cloudPrivacyRetentionVerified', 'nativeWindowsAcceptanceVerified', 'cleanPublicBuildVerified']) {
      await put('docs/public-launch/release-gates.json', JSON.stringify({ ...record, [key]: false }));
      expect((await exporter.createPublicExportPlan({ sourceRoot: project })).blockers).toContain(key);
    }
    await put('docs/public-launch/release-gates.json', JSON.stringify({ ...record, exactPublicCommit: 'not-a-commit' }));
    expect((await exporter.createPublicExportPlan({ sourceRoot: project })).blockers).toContain('exactPublicCommit');
  });
  it('requires both published forms and public-feedback privacy verification for a GitHub Issues release', async () => {
    const policyFile = 'docs/public-launch/export-policy.json';
    const policy = JSON.parse(await readFile(path.join(project, policyFile), 'utf8'));
    policy.trees.push('.github');
    policy.sourceExtensions.push('.yml');
    await put(policyFile, JSON.stringify(policy));
    const gatesFile = 'docs/public-launch/release-gates.json';
    const gates = {
      schemaVersion: 1, repository: 'zh3zhou/zz-board', feedbackChannel: 'github-issues', exactPublicCommit: 'a'.repeat(40),
      licenseApproved: true, copyrightOwnershipConfirmed: true, thirdPartyObligationsReviewed: true,
      syntheticScreenshotReviewed: true, firstRunVerified: true, nativeWindowsAcceptanceVerified: true, cleanPublicBuildVerified: true,
    };
    await put(gatesFile, JSON.stringify(gates));
    await put('LICENSE', 'Synthetic reviewed license fixture.');
    await put('docs/public-launch/assets/board-synthetic.png', Buffer.from('Synthetic image marker.'));
    await put('.github/ISSUE_TEMPLATE/bug.yml', 'name: Synthetic issue\n');
    await put('.github/ISSUE_TEMPLATE/feature.yml', 'name: Synthetic idea\n');
    const blockers = async () => (await exporter.createPublicExportPlan({ sourceRoot: project })).blockers;
    const sourceBlockers = ['publicSourceCommitUnverified', 'publicSourceExportManifestUnverified'];
    expect(await blockers()).toEqual(['githubIssueFormsVerified', 'githubFeedbackPrivacyVerified', ...sourceBlockers]);
    const verified = { ...gates, githubIssueFormsVerified: true, githubFeedbackPrivacyVerified: true };
    await put(gatesFile, JSON.stringify(verified));
    expect(await blockers()).toEqual(sourceBlockers);
    await put(gatesFile, JSON.stringify({ ...verified, nativeWindowsAcceptanceVerified: false, copyrightOwnershipConfirmed: false }));
    expect(await blockers()).toEqual(['copyrightOwnershipConfirmed', 'nativeWindowsAcceptanceVerified', ...sourceBlockers]);
    await put(gatesFile, JSON.stringify(verified));
    await unlink(path.join(project, '.github/ISSUE_TEMPLATE/feature.yml'));
    expect(await blockers()).toContain('githubIssueFormsMissing');
  });
  it.each(['other', '', null])('rejects an unknown explicit feedback channel: %s', async feedbackChannel => {
    await put('docs/public-launch/release-gates.json', JSON.stringify({ schemaVersion: 1, repository: 'zh3zhou/zz-board', feedbackChannel }));
    await expect(exporter.exportPublicSource({ sourceRoot: project, output: destination, audit, apply: true })).rejects.toThrow(/Unsupported feedbackChannel/);
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['2026-02-30', '2026-04-31', '2026-13-01'])('rejects impossible calendar dates: %s', async date => {
    await expect(exporter.createPublicExportPlan({ sourceRoot: project, date })).rejects.toThrow(/Invalid release record date/);
  });
  it('requires a matching clean public checkout even when every declared gate is true', async () => {
    const gates = Object.fromEntries(exporter.publicationGates.map((key: string) => [key, true]));
    await put('LICENSE', 'Synthetic reviewed license fixture.'); await put('docs/public-launch/assets/board-synthetic.png', Buffer.from('Synthetic image marker; never displayed.'));
    await put('docs/public-launch/release-gates.json', JSON.stringify({ schemaVersion: 1, repository: 'zh3zhou/zz-board', ...gates, exactPublicCommit: null }));
    await expect(exporter.exportPublicSource({ sourceRoot: project, requireReady: true, publicCommit: 'a'.repeat(40) })).rejects.toThrow(/publicSourceCommitUnverified/);
    await exporter.exportPublicSource({ sourceRoot: project, output: destination, audit, apply: true, date: '2026-10-11' });
    const git = (args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=.git/no-hooks', '-C', destination, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init', '--quiet']); git(['add', '.']); git(['-c', 'user.name=Synthetic Test', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'Synthetic public candidate only']);
    const head = git(['rev-parse', 'HEAD']);
    const plan = await exporter.createPublicExportPlan({ sourceRoot: destination, date: '2026-10-11', publicCommit: head });
    expect(plan.blockers).toEqual([]); expect(plan.gates.exactPublicCommit).toBe(head);
    expect(JSON.parse(await readFile(path.join(destination, 'docs/public-launch/release-gates.json'), 'utf8')).exactPublicCommit).toBeNull();
    await expect(exporter.exportPublicSource({ sourceRoot: destination, date: '2026-10-11', publicCommit: 'a'.repeat(40), requireReady: true })).rejects.toThrow(/publicSourceCommitUnverified/);
    await writeFile(path.join(destination, 'synthetic-untracked.txt'), 'Synthetic dirty checkout.');
    await expect(exporter.exportPublicSource({ sourceRoot: destination, date: '2026-10-11', publicCommit: head, requireReady: true })).rejects.toThrow(/publicSourceCommitUnverified/);
  });
  it('rejects duplicate/case-colliding destinations and changed source identities', async () => {
    const before = await exporter.createPublicExportPlan({ sourceRoot: project, date: '2026-10-11' });
    await put('src/board.ts', 'export const syntheticValue = "changed current source";');
    expect((await exporter.createPublicExportPlan({ sourceRoot: project, date: '2026-10-11' })).sourceDigest).not.toBe(before.sourceDigest);
    const policyPath = path.join(project, 'docs/public-launch/export-policy.json');
    const policy = JSON.parse(await readFile(policyPath, 'utf8')); policy.rootFiles.push('package.json');
    await writeFile(policyPath, JSON.stringify(policy));
    await expect(exporter.createPublicExportPlan({ sourceRoot: project })).rejects.toThrow(/Duplicate/);
  });
  it('exports only generated public adapters whose input templates and output hashes remain current', async () => {
    const agentTemplate = '{"synthetic":true}\n', agentsTemplate = '# Synthetic public Agent contract\n';
    const generated = '<!-- generated_by: agent-ready -->\n# Synthetic generated adapter\n';
    await put('docs/public-launch/agent.project.public.yaml', agentTemplate); await put('docs/public-launch/AGENTS.public.md', agentsTemplate);
    await put('docs/public-launch/agent-adapters/commands.md', generated);
    await put('docs/public-launch/agent-adapters/provenance.json', JSON.stringify({ schemaVersion: 1, generator: { name: 'agent-ready', version: '0.5.0' }, templates: { 'agent.project.public.yaml': sha(agentTemplate), 'AGENTS.public.md': sha(agentsTemplate) }, files: { 'commands.md': sha(generated) } }));
    const policyPath = path.join(project, 'docs/public-launch/export-policy.json'), policy = JSON.parse(await readFile(policyPath, 'utf8'));
    policy.agentAdapterProvenance = 'docs/public-launch/agent-adapters/provenance.json'; policy.agentAdapterMap = { 'commands.md': 'docs/agent/commands.md' };
    await writeFile(policyPath, JSON.stringify(policy));
    expect((await exporter.createPublicExportPlan({ sourceRoot: project })).files.some((file: { destination: string }) => file.destination === 'docs/agent/commands.md')).toBe(true);
    await put('docs/public-launch/AGENTS.public.md', agentsTemplate + 'Changed input.\n');
    await expect(exporter.createPublicExportPlan({ sourceRoot: project })).rejects.toThrow(/Stale public Agent adapter template/);
    await put('docs/public-launch/AGENTS.public.md', agentsTemplate); await put('docs/public-launch/agent-adapters/commands.md', generated + 'Changed generated output.\n');
    await expect(exporter.createPublicExportPlan({ sourceRoot: project })).rejects.toThrow(/Changed or missing generated public Agent adapter/);
  });
});

async function auditFixture() {
  const nodeVersion = process.versions.node, text = 'Synthetic Node license text, not official attribution.\n', bytes = Buffer.from(text);
  await put(`docs/public-launch/licenses/node-v${nodeVersion}-LICENSE.txt`, bytes);
  await put(`docs/public-launch/licenses/node-v${nodeVersion}-source.json`, JSON.stringify({ ref: `v${nodeVersion}`, gitBlobSha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') }));
  const crateRoot = path.join(temporary, 'synthetic-crate'); await mkdir(crateRoot);
  await writeFile(path.join(crateRoot, 'Cargo.toml'), '[package]\nname="synthetic-crate"\n');
  await writeFile(path.join(crateRoot, 'LICENSE'), 'Synthetic MIT license fixture, not a real grant.\n');
  const cargoRunner = async () => JSON.stringify({ resolve: { nodes: [{ id: 'synthetic' }] }, packages: [{ id: 'synthetic', name: 'synthetic-crate', version: '0.0.0', source: 'synthetic-registry', license: 'MIT', manifest_path: path.join(crateRoot, 'Cargo.toml') }] });
  return { cargoRunner };
}

describe('public release dependency and package gates', { timeout: 60_000 }, () => {
  it('preserves explicit record dates when packaging a private checkout', async () => {
    const exported = await exporter.createPublicExportPlan({ sourceRoot: project, date: '1999-01-01' });
    const plan = await packager.createBuildSourcePlan({ sourceRoot: project, date: '1999-01-01' });
    expect(plan.date).toBe('1999-01-01');
    expect(plan.sourceDigest).toBe(exported.sourceDigest);
    await expect(packager.createBuildSourcePlan({ sourceRoot: project, date: '2026-02-30' })).rejects.toThrow(/Invalid release record date/);
  });
  it('rejects conflicting explicit dates for an already exported candidate', async () => {
    await exporter.exportPublicSource({ sourceRoot: project, output: destination, audit, apply: true, date: '1999-01-01' });
    await expect(packager.createBuildSourcePlan({ sourceRoot: destination, date: '2000-01-01' })).rejects.toThrow(/date differs/);
  });
  it('restricts audit-only writes to public preparation or explicit separate/generated directories', () => {
    for (const relative of ['src/audit.json', '.local-data/audit.json', '.harness-backups/audit.json', 'node_modules/audit.json', 'docs/public-launch/.local-data/audit.json']) expect(() => packager.assertAuditOutput(project, relative)).toThrow(/source|private|directories/);
    expect(packager.assertAuditOutput(project, 'docs/public-launch/audit.json')).toBe(path.join(project, 'docs/public-launch/audit.json'));
    expect(packager.assertAuditOutput(project, path.join(temporary, 'separate-audit.json'))).toBe(path.join(temporary, 'separate-audit.json'));
  });
  it('pins public manifest dates, verifies actual build bytes and never attests a transformed private checkout', async () => {
    expect((await packager.createBuildSourcePlan({ sourceRoot: project })).verifiedPublicSource).toBe(false);
    await exporter.exportPublicSource({ sourceRoot: project, output: destination, audit, apply: true, date: '1999-01-01' });
    const plan = await packager.createBuildSourcePlan({ sourceRoot: destination });
    expect(plan.date).toBe('1999-01-01'); expect(plan.verifiedPublicSource).toBe(true);
    const publicReadme = path.join(destination, 'README.md'), original = await readFile(publicReadme);
    await writeFile(publicReadme, 'Synthetic altered rendered source.');
    await expect(packager.createBuildSourcePlan({ sourceRoot: destination })).rejects.toThrow(/build source bytes differ/);
    await writeFile(publicReadme, original); await writeFile(path.join(destination, 'src/board.ts'), 'Changed source after export.');
    await expect(packager.createBuildSourcePlan({ sourceRoot: destination })).rejects.toThrow(/manifest differs/);
  });
  it.each(['src/output', 'tests/output', 'cloudbase/output', '.local-data/output', '.harness-backups/output', 'src-tauri/target/output', '.tmp/.local-data/output'])('refuses package output into source or private data: %s', relative => {
    expect(() => packager.assertPackageOutput(project, path.join(project, relative))).toThrow(/source|private|artifacts/);
    expect(packager.assertPackageOutput(project, path.join(temporary, 'separate-artifacts'))).toBe(path.join(temporary, 'separate-artifacts'));
  });
  it('inventories exact license texts without exposing installed paths or claiming legal clearance', async () => {
    const options = await auditFixture();
    const result = await packager.collectDependencyNotices({ sourceRoot: project, ...options });
    expect(result.report.records).toHaveLength(2); expect(result.report.blockers).toEqual([]);
    expect(result.report.legalClearance).toBe(false); expect(JSON.stringify(result.report)).not.toContain(temporary);
    expect(result.notices).toContain('Synthetic Node license'); expect(result.notices).toContain('Synthetic MIT license');
  });
  it('does not clear absent dependency license texts or a changed Node license', async () => {
    const options = await auditFixture();
    await unlink(path.join(temporary, 'synthetic-crate', 'LICENSE'));
    await put(`docs/public-launch/licenses/node-v${process.versions.node}-LICENSE.txt`, 'Changed synthetic license.');
    const result = await packager.collectDependencyNotices({ sourceRoot: project, ...options });
    expect(result.report.blockers.some((item: string) => item.includes('Node'))).toBe(true);
    expect(result.report.blockers.some((item: string) => item.includes('synthetic-crate'))).toBe(true);
  });
  it('uses hashed exact-version source evidence without claiming license compliance, and preserves its bytes in source exports', async () => {
    const options = await auditFixture(); await unlink(path.join(temporary, 'synthetic-crate', 'LICENSE'));
    const text = 'Synthetic supplementary MIT license fixture, no actual grant.\r\n';
    const prefix = 'docs/public-launch/third-party-source-evidence/';
    await put(`${prefix}synthetic-crate/LICENSE.txt`, text);
    const entry = { ecosystem: 'rust', name: 'synthetic-crate', version: '0.0.0', license: 'MIT', files: [{ path: 'synthetic-crate/LICENSE.txt', sha256: sha(text) }], source: { url: 'https://example.invalid/synthetic-crate/v0.0.0/LICENSE', ref: 'v0.0.0' } };
    await put(`${prefix}resolved-licenses.json`, JSON.stringify({ schemaVersion: 1, records: [entry] }));
    const result = await packager.collectDependencyNotices({ sourceRoot: project, ...options });
    expect(result.report.blockers).toEqual([]); expect(result.report.legalClearance).toBe(false);
    expect(result.report.records.find((item: { name: string }) => item.name === 'synthetic-crate').supplementalEvidence.ref).toBe('v0.0.0');
    const exported = await exporter.createPublicExportPlan({ sourceRoot: project });
    expect(exported.files.find((file: { destination: string }) => file.destination === `${prefix}synthetic-crate/LICENSE.txt`).bytes).toEqual(Buffer.from(text));
    await put(`${prefix}resolved-licenses.json`, JSON.stringify({ schemaVersion: 1, records: [{ ...entry, files: [] }] }));
    const sourceOnly = await packager.collectDependencyNotices({ sourceRoot: project, ...options });
    expect(sourceOnly.report.blockers.some((item: string) => item.includes('synthetic-crate'))).toBe(true);
    expect(sourceOnly.report.reviewNotes.some((item: string) => item.includes('Source reference only'))).toBe(true);
    await put(`${prefix}resolved-licenses.json`, JSON.stringify({ schemaVersion: 1, records: [{ ...entry, version: '0.0.1', source: { ...entry.source, ref: 'v0.0.1' } }] }));
    expect((await packager.collectDependencyNotices({ sourceRoot: project, ...options })).report.blockers.some((item: string) => item.includes('synthetic-crate'))).toBe(true);
    await put(`${prefix}resolved-licenses.json`, JSON.stringify({ schemaVersion: 1, records: [entry] }));
    await put(`${prefix}synthetic-crate/LICENSE.txt`, 'Synthetic changed evidence.');
    await expect(packager.collectDependencyNotices({ sourceRoot: project, ...options })).rejects.toThrow(/bytes\/hash differ/);
  });
  it('keeps private machine paths out of failed dependency audit diagnostics', async () => {
    await auditFixture();
    const result = await packager.collectDependencyNotices({ sourceRoot: project, cargoRunner: async () => { throw new Error(`Synthetic failure at ${temporary}`); } });
    expect(JSON.stringify(result.report)).not.toContain(temporary);
    expect(result.report.blockers.some((item: string) => item.includes('Rust dependency audit unavailable'))).toBe(true);
  });
  it('keeps documented build-only tools as review notes but retains missing text blockers when they become production dependencies', async () => {
    const options = await auditFixture(), pkg = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
    pkg.devDependencies = { 'synthetic-build-tool': '0.0.0' }; await put('package.json', JSON.stringify(pkg));
    await put('node_modules/synthetic-build-tool/package.json', JSON.stringify({ name: 'synthetic-build-tool', version: '0.0.0', license: 'MIT' }));
    await put('docs/public-launch/third-party-source-evidence/resolved-licenses.json', JSON.stringify({ schemaVersion: 1, records: [{ ecosystem: 'npm', name: 'synthetic-build-tool', version: '0.0.0', license: 'MIT', files: [], source: { url: 'https://example.invalid/synthetic-build-tool/v0.0.0', ref: 'v0.0.0', buildOnly: true } }] }));
    const buildOnly = await packager.collectDependencyNotices({ sourceRoot: project, ...options });
    expect(buildOnly.report.blockers).toEqual([]); expect(buildOnly.report.reviewNotes.some((item: string) => item.includes('Verified build-only dependency'))).toBe(true);
    pkg.dependencies = pkg.devDependencies; pkg.devDependencies = {}; await put('package.json', JSON.stringify(pkg));
    const production = await packager.collectDependencyNotices({ sourceRoot: project, ...options });
    expect(production.report.blockers.some((item: string) => item.includes('synthetic-build-tool'))).toBe(true);
    expect(production.report.legalClearance).toBe(false);
  });
  it('rejects artifacts outside generated targets before inspecting their contents', async () => {
    await expect(packager.createReleasePlan({ sourceRoot: project, buildRoot: path.join(temporary, 'arbitrary'), executableVersion: async () => '0.0.1' })).rejects.toThrow(/generated desktop target/);
  });
  it.skipIf(process.platform !== 'win32')('ships the double-click installer and its reviewed offline dependencies inside the Windows ZIP', async () => {
    const auditOptions = await auditFixture();
    const policy = JSON.parse(await readFile(path.join(project, 'docs/public-launch/export-policy.json'), 'utf8'));
    policy.sourceExtensions.push('.cmd');
    const crateName = 'synthetic-crate-0.0.0.crate';
    const cratePath = 'docs/public-launch/third-party-source-evidence/mpl/' + crateName;
    const originalArchive = Buffer.from([0x1f, 0x8b, 0x00, 0xff, 0x0d, 0x0a]);
    await put(cratePath, originalArchive);
    policy.rootFiles.push(cratePath);
    policy.requiredRootFiles.push(cratePath);
    await put('src-tauri/Cargo.lock', '[[package]]\nname = "synthetic-crate"\nversion = "0.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "' + sha(originalArchive) + '"\n');
    await put('docs/public-launch/export-policy.json', JSON.stringify(policy));
    const helpers = ['install-portable.cmd', 'install-portable.mjs', 'desktop-runtime.ts'];
    for (const file of helpers) await put('scripts/' + file, await readFile(new URL('../../scripts/' + file, import.meta.url)));
    const buildRoot = path.join(project, 'src-tauri/target/release');
    const content = Buffer.from('Synthetic program, never launched.');
    await put('src-tauri/target/release/resources/runtime/node.exe', content);
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, appVersion: '0.0.1', nodeVersion: process.version, platform: 'win32', arch: 'x64', releaseChannel: 'alpha.1', files: [{ path: 'node.exe', bytes: content.length, sha256: sha(content) }] }));
    await put('src-tauri/target/release/resources/runtime/manifest.json', manifest);
    await put('src-tauri/target/release/zz-board.exe', 'Synthetic executable zzb-runtime-' + sha(manifest));
    const result = await packager.packagePublicRelease({ sourceRoot: project, buildRoot, reviewCandidate: true, apply: true, output: destination, auditOptions, executableVersion: async () => '0.0.1' });
    const zip = path.join(destination, result.stem + '.zip');
    const portable = path.join(destination, result.stem);
    const packageManifest = JSON.parse(await readFile(path.join(portable, 'PUBLIC_PACKAGE_MANIFEST.json'), 'utf8'));
    const zipNames = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(
      "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead($env:ZZB_SYNTHETIC_ZIP); try { ConvertTo-Json -Compress -InputObject @($zip.Entries | ForEach-Object { $_.FullName.Replace('\\','/') }) } finally { $zip.Dispose() }",
      'utf16le').toString('base64')], { env: { ...process.env, ZZB_SYNTHETIC_ZIP: zip }, windowsHide: true, encoding: 'utf8' }));
    expect(await readFile(path.join(portable, 'third-party-source', crateName))).toEqual(originalArchive);
    expect(await readFile(path.join(destination, result.sourceStem, cratePath))).toEqual(originalArchive);
    for (const name of ['安装或更新 ZZ Board.cmd', 'scripts/install-portable.mjs', 'scripts/desktop-runtime.ts', 'third-party-source/' + crateName]) {
      expect(zipNames).toContain(result.stem + '/' + name);
      expect(packageManifest.files).toContainEqual(expect.objectContaining({ path: name, sha256: sha(await readFile(path.join(portable, name))) }));
    }
    await put(cratePath, Buffer.from([0x1f, 0x8b, 0x00, 0xfd]));
    await expect(packager.createReleasePlan({ sourceRoot: project, buildRoot, auditOptions, executableVersion: async () => '0.0.1' })).rejects.toThrow(/crate source differs from Cargo.lock/);
    expect(await readFile(path.join(portable, '安装或更新 ZZ Board.cmd'), 'utf8')).toContain('resources\\runtime\\node.exe');
  });
  it('rejects mismatched executable/runtime metadata, retains draft gates and never guesses source-build correspondence', async () => {
    const options = await auditFixture(), buildRoot = path.join(project, 'src-tauri', 'target', 'release'), runtime = path.join(buildRoot, 'resources', 'runtime');
    await mkdir(runtime, { recursive: true }); await writeFile(path.join(buildRoot, 'zz-board.exe'), 'Synthetic executable, never launched.');
    const content = Buffer.from('Synthetic node, never executed.'); await writeFile(path.join(runtime, 'node.exe'), content);
    await writeFile(path.join(runtime, 'manifest.json'), JSON.stringify({ schemaVersion: 2, appVersion: '0.0.1', nodeVersion: process.version, platform: 'win32', arch: 'x64', releaseChannel: 'alpha.1', files: [{ path: 'node.exe', bytes: content.length, sha256: sha(content) }] }));
    await expect(packager.createReleasePlan({ sourceRoot: project, buildRoot, executableVersion: async () => '0.0.2', auditOptions: options })).rejects.toThrow(/executable version/);
    await expect(packager.createReleasePlan({ sourceRoot: project, buildRoot, executableVersion: async () => '0.0.1', auditOptions: options })).rejects.toThrow(/fingerprints do not match/);
    await writeFile(path.join(buildRoot, 'zz-board.exe'), 'Synthetic executable zzb-runtime-' + sha(await readFile(path.join(runtime, 'manifest.json'))));
    const plan = await packager.createReleasePlan({ sourceRoot: project, buildRoot, executableVersion: async () => '0.0.1', auditOptions: options });
    expect(plan.blockers).toContain('licenseTextStillDraft'); expect(plan.blockers).toContain('sourceBuildCorrespondenceUnverified');
    expect(plan.blockers).toContain('windowsBinaryDistributionNotApproved');
    expect(plan.blockers).toContain('runtimeOfficialBuildUnverified'); expect(plan.blockers).toContain('publicSourceCommitUnverified');
    const dated = await packager.packagePublicRelease({ sourceRoot: project, buildRoot, date: '1999-01-01', executableVersion: async () => '0.0.1', auditOptions: options });
    expect(dated.exported.date).toBe('1999-01-01');
    await expect(packager.createReleasePlan({ sourceRoot: project, buildRoot, channel: 'alpha.2', executableVersion: async () => '0.0.1', auditOptions: options })).rejects.toThrow(/release channel/);
    await expect(packager.packagePublicRelease({ sourceRoot: project, buildRoot, executableVersion: async () => '0.0.1', auditOptions: options, apply: true, output: destination })).rejects.toThrow(/Publication gates/);
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe.skipIf(process.platform !== 'win32' || process.arch !== 'x64')('sidecar guards before runtime cleanup', { timeout: 60_000 }, () => {
  async function sidecarFixture() {
    for (const file of ['build-desktop-sidecar.mjs', 'desktop-runtime.ts']) await copyFile(new URL(`../../scripts/${file}`, import.meta.url), path.join(project, 'scripts', file));
    await put('src-tauri/resources/runtime/keep.txt', 'Synthetic preexisting runtime; never launch.');
    const cleanEnv = { ...process.env };
    for (const key of ['ZZ_BOARD_SOURCE_COMMIT', 'ZZ_BOARD_OFFICIAL_BUILD', 'ZZ_BOARD_FEEDBACK_ENV_ID', 'ZZ_BOARD_FEEDBACK_PUBLISHABLE_KEY']) delete cleanEnv[key];
    return { cleanEnv, runtime: path.join(project, 'src-tauri', 'resources', 'runtime'), script: path.join(project, 'scripts', 'build-desktop-sidecar.mjs') };
  }
  it('refuses a service_role feedback credential before touching runtime', async () => {
    const { cleanEnv, runtime, script } = await sidecarFixture();
    const syntheticToken = ['synthetic', Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url'), 'not-a-signature'].join('.');
    const result = spawnSync(process.execPath, [script], { cwd: project, encoding: 'utf8', windowsHide: true, env: { ...cleanEnv, ZZ_BOARD_FEEDBACK_ENV_ID: 'synthetic-env', ZZ_BOARD_FEEDBACK_PUBLISHABLE_KEY: syntheticToken } });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('Only an explicit public anon credential');
    expect(await readdir(runtime)).toEqual(['keep.txt']); expect(await readFile(path.join(runtime, 'keep.txt'), 'utf8')).toContain('Synthetic preexisting');
  });
  it('requires official sourceCommit, matching HEAD and a clean tree before touching runtime', async () => {
    const { cleanEnv, runtime, script } = await sidecarFixture();
    const git = (args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=.git/no-hooks', '-C', project, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init', '--quiet']); git(['add', '.']); git(['-c', 'user.name=Synthetic Test', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'Synthetic guard fixture only']);
    const head = git(['rev-parse', 'HEAD']);
    expect(packager.publicCommitMatches(project, head)).toBe(true);
    expect(packager.publicCommitMatches(project, 'a'.repeat(40))).toBe(false);
    for (const sourceCommit of [undefined, 'a'.repeat(40), head]) {
      if (sourceCommit === head) await put('untracked-synthetic.txt', 'Synthetic dirty tree.');
      const result = spawnSync(process.execPath, [script], { cwd: project, encoding: 'utf8', windowsHide: true, env: { ...cleanEnv, ZZ_BOARD_OFFICIAL_BUILD: '1', ...(sourceCommit ? { ZZ_BOARD_SOURCE_COMMIT: sourceCommit } : {}) } });
      expect(result.status).not.toBe(0); expect(result.stderr).toContain('Official packaging requires the reviewed clean public source commit');
      expect(await readdir(runtime)).toEqual(['keep.txt']); expect(await readFile(path.join(runtime, 'keep.txt'), 'utf8')).toContain('Synthetic preexisting');
    }
    expect(packager.publicCommitMatches(project, head)).toBe(false);
  });
});
