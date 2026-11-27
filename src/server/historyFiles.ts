import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import type { BoardDatabase } from './database.js';
import type { FileEvidence, HistoryPreview } from '../shared/milestones.js';
import { checkCodexOperation, CodexAccessRequiredError, requireCodexAccess, type CodexOperationGuard } from '../shared/codexAccess.js';
import { watchProjectPageCheck } from './projectPagePolicy.js';

const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const MAX_FILE_BYTES = 1024 * 1024;
const NAMES = ['CHANGELOG.md', 'PROGRESS.md'] as const;
export function safeHistoryRoot(cwd: string): boolean {
  if (!path.isAbsolute(cwd) || /^(?:\\\\|\/\/)/.test(cwd)) return false;
  const root = path.resolve(cwd);
  return ![path.parse(root).root, path.resolve(os.homedir()), path.resolve('/root')].some(value => value.toLowerCase() === root.toLowerCase());
}
function sections(text: string): Array<{ heading: string; text: string }> {
  const result: Array<{ heading: string; text: string }> = [];
  let heading = '文件说明'; let lines: string[] = []; let fenced = false;
  const flush = () => { const content = lines.join('\n').trim(); if (content) result.push({ heading, text: content }); lines = []; };
  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && /^#{1,2}\s+/.test(line)) { flush(); heading = line.replace(/^#+\s+/, ''); }
    lines.push(line);
  }
  flush(); return result;
}

/** Exactly two allowlisted files. No recursive search, links, arbitrary API path or transcript reads. */
export async function previewHistory(db: BoardDatabase, projectKey: string, operation?: CodexOperationGuard): Promise<{ preview: HistoryPreview; evidence: FileEvidence[] }> {
  const epoch = db.getCodexAccessEpoch();
  const access = operation ?? { check: () => {
    requireCodexAccess(db.getCodexAccess(), 'localRead');
    if (epoch !== db.getCodexAccessEpoch()) throw new CodexAccessRequiredError('localRead');
  } };
  const page = watchProjectPageCheck(db, projectKey);
  const guard = { check: () => { checkCodexOperation(access); page.check(); }, signal: access.signal };
  try {
  checkCodexOperation(guard);
  const project = db.getBoard().projects.find(project => project.projectKey === projectKey);
  if (!project || (project.hostId && project.hostId !== 'local') || !project.cwd || !safeHistoryRoot(project.cwd)) throw new Error('此项目没有可安全读取的本机项目目录。');
  const root = await fs.realpath(project.cwd);
  checkCodexOperation(guard);
  if (!safeHistoryRoot(root)) throw new Error('不能从宽泛目录补充历史。');
  const evidence: FileEvidence[] = []; const files: HistoryPreview['files'] = []; const gaps: string[] = [];
  const checkedAt = new Date().toISOString();
  for (const name of NAMES) {
    checkCodexOperation(guard);
    const requested = path.join(root, name);
    try {
      const file = await fs.realpath(requested);
      checkCodexOperation(guard);
      if (file.toLowerCase() !== requested.toLowerCase()) { gaps.push(`${name} 是重定向文件，未读取。`); continue; }
      const stat = await fs.stat(file);
      checkCodexOperation(guard);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) { gaps.push(`${name} 超过单文件 1 MiB 范围，未读取。`); continue; }
      const bytes = await fs.readFile(file); if (bytes.length > MAX_FILE_BYTES) throw new Error('File grew.');
      checkCodexOperation(guard);
      const text = bytes.toString('utf8'); const fileFingerprint = digest(bytes); const found: FileEvidence[] = [];
      const occurrences = new Map<string, number>();
      for (const section of sections(text)) {
        const occurrence = occurrences.get(section.heading) ?? 0; occurrences.set(section.heading, occurrence + 1);
        // Ignore headings with no narrative and the general maintenance preamble.
        if (section.text.replace(/^#+[^\n]*(?:\n|$)/, '').trim().length < 30) continue;
        for (let start = 0, part = 0; start < section.text.length; start += 14000, part++) {
          const body = section.text.slice(start, start + 14000);
          const fingerprint = digest(body);
          const fileKey = `file:${digest(JSON.stringify([projectKey, name, section.heading, occurrence, part]))}`;
          const date = section.heading.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ?? '时间未知';
          found.push({ fileKey, projectKey, projectName: project.name, label: `${name} · ${section.heading}${part ? `（续 ${part + 1}）` : ''}`,
            path: file, heading: section.heading, fingerprint, fileFingerprint, sourceUpdatedAt: stat.mtime.toISOString(), checkedAt,
            evidence: [{ id: `${fileKey}:${fingerprint}`, role: 'file', occurredAt: date, turnId: null, path: file, heading: section.heading, fingerprint, text: body }] });
        }
      }
      evidence.push(...found); files.push({ name, bytes: bytes.length, blocks: found.length, pending: found.filter(value => !db.timeline.fileCached(value)).length });
    } catch { checkCodexOperation(guard); gaps.push(`${name} 暂不可读；已有历程保留。`); }
  }
  const pending = evidence.filter(file => !db.timeline.fileCached(file));
  const characters = pending.reduce((sum, file) => sum + file.evidence.reduce((n, value) => n + value.text.length, 0), 0);
  checkCodexOperation(guard);
  return { preview: { projectKey, fingerprint: digest(JSON.stringify(evidence.map(file => [file.fileKey, file.fingerprint]))), files,
    blocks: evidence.length, pending: pending.length, characters, estimatedInputTokens: [Math.ceil(characters / 3), characters + pending.length * 2000],
    gaps: [...gaps, '仅包含项目记录；未回看完整对话历史。预估不含输出、推理及运行时开销。'] }, evidence };
  } finally { page.dispose(); }
}
export async function fileEvidenceStillCurrent(file: FileEvidence, operation?: CodexOperationGuard): Promise<boolean> {
  checkCodexOperation(operation);
  try {
    if (!NAMES.includes(path.basename(file.path) as typeof NAMES[number])) return false;
    const resolved = await fs.realpath(file.path); checkCodexOperation(operation);
    if (resolved !== file.path) return false;
    const stat = await fs.stat(file.path); checkCodexOperation(operation);
    if (stat.size > MAX_FILE_BYTES) return false;
    const bytes = await fs.readFile(file.path); checkCodexOperation(operation);
    return digest(bytes) === file.fileFingerprint;
  } catch { checkCodexOperation(operation); return false; }
}
