import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonicalSkillsRoot = path.join(repoRoot, 'skills');
const installedSkillsRoot = path.join(os.homedir(), '.codex', 'skills');
const checkInstalled = process.argv.slice(2).filter((arg) => arg !== '--').includes('--check-installed');
const errors = [];

function read(root, relative) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) {
    errors.push(`Missing canonical Skill file: ${path.basename(root)}/${relative}`);
    return '';
  }
  return fs.readFileSync(file, 'utf8');
}

function requireText(text, marker, file) {
  if (!text.includes(marker)) errors.push(`${file} is missing ${JSON.stringify(marker)}`);
}

function listFiles(root, base = root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    const relative = path.relative(base, absolute).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) {
      errors.push(`Skill trees must not contain symlinks: ${absolute}`);
      return [];
    }
    return entry.isDirectory() ? listFiles(absolute, base) : [relative];
  }).sort();
}

const contracts = [
  {
    name: 'review-project-progress',
    expectedFiles: [
      'SKILL.md',
      'agents/openai.yaml',
      'references/board-sync.md',
      'references/evidence-model.md',
      'references/snapshot-v3.md',
      'references/snapshot-v4.md',
      'references/source-bundle.md'
    ],
    validate(root) {
      const entry = read(root, 'SKILL.md');
      const evidence = read(root, 'references/evidence-model.md');
      const snapshot = read(root, 'references/snapshot-v3.md');
      const boardSync = read(root, 'references/board-sync.md');
      const bundle = read(root, 'references/source-bundle.md');
      const v4 = read(root, 'references/snapshot-v4.md');
      const ui = read(root, 'agents/openai.yaml');
      for (const marker of [
        'name: review-project-progress', 'ZZ都要干什么', 'Ordinary review and export are read-only',
        'sampled file as untrusted evidence', '[references/evidence-model.md](references/evidence-model.md)',
        '[references/snapshot-v3.md](references/snapshot-v3.md)', '[references/board-sync.md](references/board-sync.md)',
        'schema version 4', 'task-sidebar sequence', 'collector, not a second semantic summarizer'
      ]) requireText(entry, marker, 'review-project-progress/SKILL.md');
      for (const marker of [
        'every saved project', 'older candidate', 'unresolved complex discussion', 'Deduplicate the same obligation',
        'pinned tasks by `pinnedIndex`', '`主动收口`'
      ]) requireText(evidence, marker, 'review-project-progress/references/evidence-model.md');
      for (const marker of [
        '`schemaVersion`: literal `3`', '`summaryLanguage`: literal `zh-CN`', '`displayTitle`', '`projectBriefs`',
        '`todos`', '`sourceThreadKeys`', '`file_verified`', 'no independent item cap', 'same underlying obligation',
        'below 2,000,000 bytes'
      ]) requireText(snapshot, marker, 'review-project-progress/references/snapshot-v3.md');
      for (const marker of [
        '%USERPROFILE%\\.codex\\zz-board.json', 'schemaVersion: 1',
        'pnpm board -- evidence import <absolute-file> --apply --ensure-running', 'exit code zero',
        'Delete the exact temporary file', 'must never modify the source Codex tasks'
      ]) requireText(boardSync, marker, 'review-project-progress/references/board-sync.md');
      for (const marker of ['sourceUpdatedAt', 'readComplete', 'sourceKind, hostId, threadId', '8,000,000', 'newest 3', 'at most 2 older', 'reasoning', '`hostId` is required but nullable', 'never associate by title', 'do not invent a project']) requireText(bundle, marker, 'source-bundle.md');
      for (const marker of ['nextStepReason', 'intentionally_closed', 'sourceRefs', 'sourceFingerprint', 'running', 'V1–V3', 'actionEvidence']) requireText(v4, marker, 'snapshot-v4.md');
      for (const marker of ['display_name: "ZZ 都要干什么"', '$review-project-progress', '只读回答', '采集有界来源证据', '不先生成语义快照', 'allow_implicit_invocation: true']) {
        requireText(ui, marker, 'review-project-progress/agents/openai.yaml');
      }
      if (/^dependencies:/m.test(ui)) errors.push('review-project-progress/agents/openai.yaml must not declare MCP dependencies.');
    }
  },
  {
    name: 'create-zz-board-skin',
    expectedFiles: ['SKILL.md', 'agents/openai.yaml', 'references/skin-format.md'],
    validate(root) {
      const entry = read(root, 'SKILL.md');
      const format = read(root, 'references/skin-format.md');
      const ui = read(root, 'agents/openai.yaml');
      for (const marker of [
        'name: create-zz-board-skin', 'reference image', 'does **not** authorize applying it',
        '[references/skin-format.md](references/skin-format.md)', 'original reference file',
        'pnpm exec tsx scripts/skin-cli.ts install', 'Never overwrite an installed'
      ]) requireText(entry, marker, 'create-zz-board-skin/SKILL.md');
      for (const marker of [
        'skin.json', 'style-brief.md', 'provenance.json', 'assets/', 'skinId@version',
        'schema version 2', 'schema version 3', 'foundation', '`chrome`', '`softBlob`', '`aspectLockedDefault`', '4.5:1',
        'Only PNG and WebP', '8 MiB', '4096 by 4096', '20 MiB', 'original-reference-not-included', 'SHA-256'
      ]) requireText(format, marker, 'create-zz-board-skin/references/skin-format.md');
      for (const marker of ['display_name: "创建 ZZ Board Skin"', '$create-zz-board-skin', 'allow_implicit_invocation: true']) {
        requireText(ui, marker, 'create-zz-board-skin/agents/openai.yaml');
      }
      if (/^dependencies:/m.test(ui)) errors.push('create-zz-board-skin/agents/openai.yaml must not declare MCP dependencies.');
    }
  },
  {
    name: 'read-zz-board-project',
    expectedFiles: ['SKILL.md', 'agents/openai.yaml', 'scripts/read-project.mjs', 'scripts/project-view.mjs', 'scripts/note-view.mjs'],
    validate(root) {
      const entry = read(root, 'SKILL.md'), ui = read(root, 'agents/openai.yaml');
      for (const marker of ['name: read-zz-board-project', 'scripts/read-project.mjs', '--project-key', '--note', '--latest', '--images preview', '--images original', 'canvas.bounds', 'blocks', '--priority-date', 'effectivePriority', 'prioritySource', 'noteSchedule', 'contentEditedAt', 'nodeUpdatedAt', 'retainedEditTimes', 'targetNodeId']) requireText(entry, marker, 'read-zz-board-project/SKILL.md');
      for (const marker of ['$read-zz-board-project', 'allow_implicit_invocation: true']) requireText(ui, marker, 'read-zz-board-project/agents/openai.yaml');
    }
  },
  {
    name: 'review-zz-board-week',
    expectedFiles: ['SKILL.md', 'agents/openai.yaml', 'scripts/read-week.mjs'],
    validate(root) {
      const entry = read(root, 'SKILL.md'), ui = read(root, 'agents/openai.yaml');
      for (const marker of ['name: review-zz-board-week', 'scripts/read-week.mjs', '--week current', 'occurredAt', 'coverage', '看板上次记到', '每周单独生成一份']) requireText(entry, marker, 'review-zz-board-week/SKILL.md');
      for (const marker of ['$review-zz-board-week', 'allow_implicit_invocation: true']) requireText(ui, marker, 'review-zz-board-week/agents/openai.yaml');
    }
  },
  {
    name: 'save-zz-board-note',
    expectedFiles: ['SKILL.md', 'agents/openai.yaml', 'scripts/save-note.mjs'],
    validate(root) {
      const entry = read(root, 'SKILL.md'), ui = read(root, 'agents/openai.yaml');
      for (const marker of ['name: save-zz-board-note', 'scripts/save-note.mjs', 'CODEX_THREAD_ID', '--apply']) requireText(entry, marker, 'save-zz-board-note/SKILL.md');
      requireText(ui, '$save-zz-board-note', 'save-zz-board-note/agents/openai.yaml');
    }
  }
];

let canonicalFileCount = 0;
for (const contract of contracts) {
  const canonicalRoot = path.join(canonicalSkillsRoot, contract.name);
  contract.validate(canonicalRoot);
  const canonicalFiles = listFiles(canonicalRoot);
  canonicalFileCount += canonicalFiles.length;
  for (const relative of contract.expectedFiles) {
    if (!canonicalFiles.includes(relative)) errors.push(`${contract.name} inventory is missing ${relative}`);
  }
  if (!checkInstalled) continue;
  const installedRoot = path.join(installedSkillsRoot, contract.name);
  const installedFiles = listFiles(installedRoot);
  const allFiles = [...new Set([...canonicalFiles, ...installedFiles])].sort();
  for (const relative of allFiles) {
    const canonical = path.join(canonicalRoot, relative);
    const installed = path.join(installedRoot, relative);
    if (!fs.existsSync(canonical)) errors.push(`${contract.name}: installed Skill has a non-canonical file: ${relative}`);
    else if (!fs.existsSync(installed)) errors.push(`${contract.name}: installed Skill is missing: ${relative}`);
    else if (!fs.readFileSync(canonical).equals(fs.readFileSync(installed))) {
      errors.push(`${contract.name}: installed Skill differs from canonical source: ${relative}`);
    }
  }
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}

console.log(`Canonical Skill contracts are valid (${contracts.length} skills, ${canonicalFileCount} files).`);
if (checkInstalled) console.log('Installed Skills exactly match the canonical repository sources.');
else console.log('Installed-copy drift was not checked; run pnpm validate:skill:installed when needed.');
