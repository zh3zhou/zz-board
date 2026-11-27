import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const root = process.cwd();
const tsx = path.join(root, 'node_modules/tsx/dist/cli.mjs');
const cli = path.join(root, 'scripts/board-cli.ts');
const files: string[] = [], dirs: string[] = [];
const stamp = '2026-09-09T00:00:00.000Z';
const bundle = { schemaVersion: 1, generatedAt: stamp,
  coverage: { projectsFound: 1, threadsFound: 1, deepRead: 1, fileChecked: 0, truncated: false, inaccessible: ['do-not-echo-gap'] },
  projects: [{ projectKey: 'synthetic-project', name: 'do-not-echo-project', observedAt: stamp }],
  threads: [{ threadKey: 'synthetic:thread', threadId: 'thread', projectKey: 'synthetic-project', hostId: 'synthetic',
    sourceKind: 'codex', title: 'do-not-echo-title', sourceUpdatedAt: stamp, evidenceCheckedAt: stamp,
    runtimeState: 'idle', readComplete: true, readReason: 'bounded synthetic fixture',
    evidence: [{ id: 'source-one', role: 'assistant', occurredAt: stamp, turnId: 'turn-one', path: null, text: 'do-not-echo-body' }] }] };
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zz-evidence-cli-')); dirs.push(dir);
  const file = path.join(dir, 'evidence.json'); files.push(file); await fs.writeFile(file, JSON.stringify(bundle)); return { dir, file };
}
afterEach(async () => { await Promise.all(files.splice(0).map(f => fs.rm(f, { force: true }))); await Promise.all(dirs.splice(0).map(d => fs.rmdir(d))); });
describe('bounded evidence CLI', () => {
  it('validates/previews without launching, importing or exposing source text', async () => {
    const { dir, file } = await fixture();
    for (const mode of ['validate', 'preview', 'import']) {
      const { stdout } = await run(process.execPath, [tsx, cli, 'evidence', mode, file, '--ensure-running', '--binding', path.join(dir, 'absent.json')], { cwd: root });
      expect(JSON.parse(stdout)).toMatchObject({ valid: true, mutation: false, projects: 1, tasks: 1, inaccessibleCount: 1 });
      expect(stdout).not.toContain('do-not-echo');
    }
    expect(await fs.readFile(file, 'utf8')).toContain('do-not-echo-body');
  });
  it('requires explicit apply for force and rejects malformed data without echoing it', async () => {
    const { file } = await fixture();
    await expect(run(process.execPath, [tsx, cli, 'evidence', 'import', file, '--force'], { cwd: root }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('--force requires evidence import --apply') });
    await fs.writeFile(file, JSON.stringify({ ...bundle, schemaVersion: 'do-not-echo-invalid' }));
    await expect(run(process.execPath, [tsx, cli, 'evidence', 'validate', file], { cwd: root }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('Input schema validation failed at: schemaVersion') });
  });
  it('queues once with deliberate mutation header and prints only allowlisted job metadata', async () => {
    const { file } = await fixture(); let imports = 0;
    const job = { id: 'synthetic-job', state: 'queued', completed: 0, total: 1, skipped: 0, error: 'do-not-echo-server', title: 'do-not-echo-title', model: 'test-model', effort: 'medium' };
    const server = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST') {
        imports++; expect(req.headers['x-zz-board-mutation']).toBe('1');
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
        expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({ bundle, force: true });
        res.end(JSON.stringify(job));
      } else res.end(JSON.stringify({ jobs: [job] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('No test listener');
      const url = `http://127.0.0.1:${addr.port}`;
      const result = await run(process.execPath, [tsx, cli, 'evidence', 'import', file, '--apply', '--force', '--url', url], { cwd: root });
      expect(JSON.parse(result.stdout)).toMatchObject({ mutation: true, job: { id: job.id, state: 'queued', hasError: true } });
      expect(result.stdout).not.toContain('do-not-echo');
      const status = await run(process.execPath, [tsx, cli, 'sync', 'status', job.id, '--url', url], { cwd: root });
      expect(JSON.parse(status.stdout).jobs).toHaveLength(1); expect(status.stdout).not.toContain('do-not-echo');
      expect(imports).toBe(1); expect(await fs.readFile(file, 'utf8')).toContain('do-not-echo-body');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
