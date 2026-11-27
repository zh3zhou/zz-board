import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createDemoSnapshot } from '../../src/shared/demo.js';
import { dataStoreId } from '../../src/server/config.js';
import { APP_VERSION } from '../../src/shared/version.js';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const boardCli = path.join(repoRoot, 'scripts', 'board-cli.ts');
const temporaryDirectories: string[] = [];
const temporaryFiles: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryFiles.splice(0).map((file) => fs.rm(file, { force: true })));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rmdir(directory)));
});

describe('Agent board CLI', () => {
  it('validates a synthetic snapshot without printing inaccessible details', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zz-board-cli-'));
    temporaryDirectories.push(directory);
    const file = path.join(directory, 'snapshot.json');
    temporaryFiles.push(file);
    const snapshot = createDemoSnapshot(2, new Date('2026-08-20T00:00:00.000Z'));
    snapshot.coverage.inaccessible = ['private path that should not be printed'];
    await fs.writeFile(file, JSON.stringify(snapshot), 'utf8');

    const { stdout } = await execFileAsync(process.execPath, [tsxCli, boardCli, 'snapshot', 'validate', file], { cwd: repoRoot });
    const output = JSON.parse(stdout);
    expect(output).toMatchObject({ valid: true, schemaVersion: 3, projects: 8, tasks: 2 });
    expect(output.coverage.inaccessibleCount).toBe(1);
    expect(stdout).not.toContain('private path');
  });

  it('refuses a non-loopback service URL without a stack trace', async () => {
    await expect(execFileAsync(process.execPath, [tsxCli, boardCli, 'status', '--url', 'https://example.com'], { cwd: repoRoot }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('only connects to an HTTP loopback address') });
  });

  it('keeps import preview-only and does not require a binding without --apply', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zz-board-cli-preview-'));
    temporaryDirectories.push(directory);
    const file = path.join(directory, 'snapshot.json');
    temporaryFiles.push(file);
    await fs.writeFile(file, JSON.stringify(createDemoSnapshot(1)), 'utf8');

    const { stdout } = await execFileAsync(
      process.execPath,
      [tsxCli, boardCli, 'snapshot', 'import', file, '--ensure-running'],
      { cwd: repoRoot, env: { ...process.env, USERPROFILE: directory } }
    );
    expect(stdout).toContain('"mutation": false');
    expect(stdout).toContain('Preview only');
  });

  it('uses a strict local binding and verifies the running service identity', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zz-board-cli-binding-'));
    temporaryDirectories.push(directory);
    const dataDir = path.join(directory, 'data');
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/health') {
        response.end(JSON.stringify({ ok: true, appVersion: APP_VERSION, dataStoreId: dataStoreId(dataDir) }));
      } else if (request.url === '/api/board') {
        response.end(JSON.stringify({ projects: [], threads: [], projectBriefs: [], todos: [], nodes: [], settings: {} }));
      } else {
        response.statusCode = 404;
        response.end('{}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Synthetic server did not bind.');
      const bindingFile = path.join(directory, 'binding.json');
      temporaryFiles.push(bindingFile);
      await fs.writeFile(bindingFile, JSON.stringify({
        schemaVersion: 1,
        projectRoot: repoRoot,
        dataDir,
        desktopExecutable: path.join(directory, 'ZZ Board.exe'),
        boardUrl: `http://127.0.0.1:${address.port}`
      }), 'utf8');

      const { stdout } = await execFileAsync(
        process.execPath,
        [tsxCli, boardCli, 'status', '--ensure-running', '--binding', bindingFile],
        { cwd: repoRoot }
      );
      expect(JSON.parse(stdout)).toMatchObject({ service: 'available', board: { projects: 0, tasks: 0 } });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('rejects a binding that points data storage at the user profile root', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zz-board-cli-unsafe-'));
    temporaryDirectories.push(directory);
    const bindingFile = path.join(directory, 'binding.json');
    temporaryFiles.push(bindingFile);
    await fs.writeFile(bindingFile, JSON.stringify({
      schemaVersion: 1,
      projectRoot: repoRoot,
      dataDir: directory,
      desktopExecutable: path.join(directory, 'ZZ Board.exe'),
      boardUrl: 'http://127.0.0.1:4318'
    }), 'utf8');

    await expect(execFileAsync(
      process.execPath,
      [tsxCli, boardCli, 'status', '--ensure-running', '--binding', bindingFile],
      { cwd: repoRoot, env: { ...process.env, USERPROFILE: directory } }
    )).rejects.toMatchObject({ stderr: expect.stringContaining('must not be a drive root or the user profile directory') });
  });
});
