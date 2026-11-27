import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPath, registeredDirectory } from './install-portable.mjs';
import { writeNewCodexBinding } from './source-deployment.mjs';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const knownSkills = ['review-project-progress', 'create-zz-board-skin', 'read-zz-board-project', 'save-zz-board-note', 'review-zz-board-week'];
let apply = false, selected;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply' && !apply) apply = true;
  else if (args[i] === '--skill' && !selected && knownSkills.includes(args[i+1])) selected = args[++i];
  else throw new Error('Usage: sync-skill.mjs [--skill <canonical-name>] [--apply]');
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonicalSkillsRoot = path.resolve(repoRoot, 'skills');
const skillsRoot = path.resolve(os.homedir(), '.codex', 'skills');
const skillNames = selected ? [selected] : knownSkills;
const bindingPath = path.resolve(os.homedir(), '.codex', 'zz-board.json');
const binding = {
  schemaVersion: 1,
  projectRoot: repoRoot,
  dataDir: path.join(repoRoot, '.local-data'),
  desktopExecutable: path.join(repoRoot, 'src-tauri', 'target', 'release', 'zz-board.exe'),
  boardUrl: 'http://127.0.0.1:4318'
};

function collect(root, base = root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    const relative = path.relative(base, absolute).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) return [{ relative, absolute, symlink: true }];
    return entry.isDirectory() ? collect(absolute, base) : [{ relative, absolute, symlink: false }];
  });
}

const operations = [];
for (const skillName of skillNames) {
  const sourceRoot = path.resolve(canonicalSkillsRoot, skillName);
  const targetRoot = path.resolve(skillsRoot, skillName);
  if (path.dirname(targetRoot) !== skillsRoot || path.basename(targetRoot) !== skillName) {
    throw new Error(`Refusing unsafe Skill target: ${targetRoot}`);
  }
  if (!fs.existsSync(path.join(sourceRoot, 'SKILL.md'))) throw new Error(`Canonical Skill is missing: ${sourceRoot}`);
  if (fs.existsSync(targetRoot) && fs.lstatSync(targetRoot).isSymbolicLink()) {
    throw new Error(`Refusing a symlinked or junction Skill target: ${targetRoot}`);
  }
  const sourceFiles = collect(sourceRoot);
  if (sourceFiles.some((file) => file.symlink)) throw new Error(`Canonical Skill must not contain symlinks: ${skillName}`);
  const targetFiles = collect(targetRoot);
  if (targetFiles.some((file) => file.symlink)) throw new Error(`Refusing symlinks in the installed Skill tree: ${skillName}`);
  const sourceByName = new Map(sourceFiles.map((file) => [file.relative, file]));
  const targetByName = new Map(targetFiles.map((file) => [file.relative, file]));
  const writes = sourceFiles.filter((source) => {
    const target = targetByName.get(source.relative);
    return !target || !fs.readFileSync(source.absolute).equals(fs.readFileSync(target.absolute));
  });
  const removals = targetFiles.filter((target) => !sourceByName.has(target.relative));
  operations.push({ skillName, sourceRoot, targetRoot, sourceFiles, writes, removals });
}

for (const operation of operations) {
  console.log(`Canonical: ${operation.sourceRoot}`);
  console.log(`Install target: ${operation.targetRoot}`);
  for (const file of operation.writes) console.log(`WRITE  ${operation.skillName}/${file.relative}`);
  for (const file of operation.removals) console.log(`REMOVE ${operation.skillName}/${file.relative}`);
}
let createDevelopmentBinding = false;
const stableInstall = () => process.platform === 'win32' && registeredDirectory(process.env);
if (!selected) {
  console.log(`Local binding: ${bindingPath}`);
  if (await checkPath(bindingPath)) console.log('KEEP   ../zz-board.json (existing local binding)');
  else if (await stableInstall()) console.log('For a registered installation, use pnpm setup:windows -- -BindCodex.');
  else {
    createDevelopmentBinding = true;
    console.log('WRITE  ../zz-board.json (local development binding)');
  }
}

const changed = operations.some((operation) => operation.writes.length || operation.removals.length) || createDevelopmentBinding;
if (!changed) {
  console.log('Installed Skills are already current.');
  process.exit(0);
}
if (!apply) {
  console.log('Preview only. Re-run with --apply after approving the user-level Skill update.');
  process.exit(0);
}

for (const operation of operations) {
  fs.mkdirSync(operation.targetRoot, { recursive: true });
  for (const file of operation.writes) {
    const destination = path.resolve(operation.targetRoot, file.relative);
    if (!destination.startsWith(`${operation.targetRoot}${path.sep}`)) throw new Error(`Refusing unsafe write: ${destination}`);
    if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) fs.unlinkSync(destination);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file.absolute, destination);
  }
  for (const file of operation.removals) {
    const destination = path.resolve(operation.targetRoot, file.relative);
    if (!destination.startsWith(`${operation.targetRoot}${path.sep}`)) throw new Error(`Refusing unsafe removal: ${destination}`);
    fs.unlinkSync(destination);
  }
  removeEmptyDirectories(operation.targetRoot);
  console.log(`Installed ${operation.sourceFiles.length} canonical files for ${operation.skillName}.`);
}

if (createDevelopmentBinding && !await stableInstall()) {
  if (await writeNewCodexBinding(bindingPath, binding)) console.log('Installed the private local development binding.');
}

function removeEmptyDirectories(root) {
  const directories = [];
  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = path.join(directory, entry.name);
      visit(child);
      directories.push(child);
    }
  }
  visit(root);
  for (const directory of directories) {
    if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
  }
}
