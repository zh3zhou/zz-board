import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardDatabase } from '../../src/server/database.js';
import { previewHistory, safeHistoryRoot, fileEvidenceStillCurrent } from '../../src/server/historyFiles.js';
import { bundle } from '../fixtures/summary.js';
import { grantSyntheticCodexAccess } from '../fixtures/codexAccess.js';
import { requireCodexAccess } from '../../src/shared/codexAccess.js';
const roots: string[] = []; const dbs: BoardDatabase[] = [];
afterEach(async () => { vi.restoreAllMocks(); dbs.forEach(db => db.close()); dbs.length = 0; for (const root of roots) await fs.rm(root, { recursive: true, force: true }); roots.length = 0; });
async function setup() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zz-history-test-')); roots.push(root); const db = new BoardDatabase(':memory:'); grantSyntheticCodexAccess(db); dbs.push(db); const input = bundle([]); input.projects[0]!.cwd = root; db.prepareEvidence(input, new Map()); return { db, root }; }
const section = (version: string) => `## ${version} — 2026-09-01\n\n- 问题：合成组件需要可靠地保存数据。\n- 决定：使用本地文件。\n- 验证：仅完成构建，尚未启动，不可称作运行验证。\n`;
describe('bounded file history evidence', () => {
  it('does not start later file reads when consent is revoked during root resolution', async () => {
    const { db, root } = await setup(); await fs.writeFile(path.join(root, 'CHANGELOG.md'), section('1.0'));
    let release!: (value: string) => void;
    vi.spyOn(fs, 'realpath').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const read = vi.spyOn(fs, 'readFile');
    const pending = previewHistory(db, 'example').catch(error => error);
    db.saveCodexAccess({ schemaVersion: 1, localRead: false, modelUse: false, decidedAt: new Date().toISOString() });
    release(root); expect(await pending).toMatchObject({ code: 'CODEX_ACCESS_REQUIRED' }); expect(read).not.toHaveBeenCalled();
  });
  it('stops file freshness checks before stat and contents when model access is revoked', async () => {
    const { db, root } = await setup(); await fs.writeFile(path.join(root, 'CHANGELOG.md'), section('1.0'));
    const first = await previewHistory(db, 'example'); const file = first.evidence[0]!;
    let release!: (value: string) => void;
    vi.spyOn(fs, 'realpath').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const read = vi.spyOn(fs, 'readFile'); const stat = vi.spyOn(fs, 'stat');
    const pending = fileEvidenceStillCurrent(file, { check: () => requireCodexAccess(db.getCodexAccess(), 'modelUse') }).catch(error => error);
    db.saveCodexAccess({ schemaVersion: 1, localRead: true, modelUse: false, decidedAt: new Date().toISOString() });
    release(file.path); expect(await pending).toMatchObject({ code: 'CODEX_ACCESS_REQUIRED' }); expect(read).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled();
  });
  it('preserves file source identity, hashes only sections and never uses mtime as event time', async () => {
    const { db, root } = await setup(); const file = path.join(root, 'CHANGELOG.md');
    await fs.writeFile(file, section('1.0') + section('1.1'));
    const first = await previewHistory(db, 'example'); expect(first.evidence).toHaveLength(2);
    expect(first.evidence[0]).not.toHaveProperty('threadId'); expect(first.evidence[0]!.evidence[0]).toMatchObject({ role: 'file', occurredAt: '2026-09-01' });
    for (const entry of first.evidence) { db.timeline.prepareFile(entry); db.timeline.finishFile(entry); }
    await fs.utimes(file, new Date(), new Date()); expect((await previewHistory(db, 'example')).preview.pending).toBe(0);
    await fs.writeFile(file, section('1.0') + section('1.1') + section('1.2'));
    const next = await previewHistory(db, 'example'); expect(next.preview.pending).toBe(1); expect(next.evidence[0]!.fileKey).toBe(first.evidence[0]!.fileKey);
    expect(await fileEvidenceStillCurrent(first.evidence[0]!)).toBe(false); expect(await fileEvidenceStillCurrent(next.evidence[0]!)).toBe(true);
  });
  it('rejects broad roots, ignores other filenames and records undated content as unknown', async () => {
    expect(safeHistoryRoot(path.parse(process.cwd()).root)).toBe(false); expect(safeHistoryRoot(os.homedir())).toBe(false); expect(safeHistoryRoot('relative')).toBe(false);
    const { db, root } = await setup(); await fs.writeFile(path.join(root, 'PRIVATE.md'), section('1.0'));
    await fs.writeFile(path.join(root, 'PROGRESS.md'), '## 一次讨论\n\n讨论内容足够长，但没有记录日期。提出了两个可行方案，尚未决定采用哪一个。');
    const found = await previewHistory(db, 'example'); expect(found.preview.files.map(file => file.name)).toEqual(['PROGRESS.md']);
    expect(found.evidence[0]!.evidence[0]!.occurredAt).toBe('时间未知');
  });
  it('does not follow project file links outside the root or read oversized files', async () => {
    const { db, root } = await setup(); await fs.writeFile(path.join(root, 'CHANGELOG.md'), 'x'.repeat(1024 * 1024 + 1));
    const found = await previewHistory(db, 'example'); expect(found.evidence).toEqual([]); expect(found.preview.gaps.join('')).toContain('1 MiB');
  });
});
