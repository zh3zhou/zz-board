import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const root = process.cwd();
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const port = 43_500 + (process.pid % 1_000);
const dataDir = path.join(root, '.local-data', `smoke-${process.pid}`);
const child = spawn(process.execPath, ['dist/server/index.js'], {
  cwd: root,
  windowsHide: true,
  env: { ...process.env, ZZ_BOARD_PORT: String(port), ZZ_BOARD_DATA_DIR: dataDir, ZZ_BOARD_DEMO: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
child.stdout.on('data', (chunk) => { logs += chunk; });
child.stderr.on('data', (chunk) => { logs += chunk; });
let childExit = null;
let resolveChildExit;
const childExitPromise = new Promise((resolve) => { resolveChildExit = resolve; });
child.once('exit', (code, signal) => { childExit = { code, signal }; resolveChildExit(); });

try {
  let response;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (childExit) break;
    try { response = await fetch(`http://127.0.0.1:${port}/api/board`); if (response.ok) break; } catch {}
  }
  if (!response?.ok) throw new Error(`Server did not become ready within 60 seconds.${childExit ? ` Child exit: ${JSON.stringify(childExit)}.` : ''}\n${logs}`);
  const board = await response.json();
  const projectBubbles = board.nodes.filter((node) => node.kind === 'task' && node.projectKey);
  if (board.projects.length !== 8 || board.threads.length !== 56 || projectBubbles.length !== 8) throw new Error('Demo seed did not preserve 56 conversations inside 8 project bubbles.');
  if (board.projectBriefs.length !== 8 || board.todos.length !== 6) throw new Error('Demo seed did not produce the expected V2 summaries.');
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  if (health.appVersion !== packageJson.version || !health.snapshotSchemaVersions.includes(3)) throw new Error('Health compatibility metadata is incorrect.');

  const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const boardCli = path.join(root, 'scripts', 'board-cli.ts');
  const { stdout } = await execFileAsync(process.execPath, [tsxCli, boardCli, 'status', '--url', `http://127.0.0.1:${port}`], { cwd: root });
  const agentStatus = JSON.parse(stdout);
  if (agentStatus.board.projectBriefs !== 8 || agentStatus.board.humanTodos !== 6) throw new Error('Agent CLI status does not match the board.');
  console.log(`Windows smoke passed: ${projectBubbles.length} project bubbles, ${board.threads.length} conversations, ${board.todos.length} human todos.`);
} finally {
  if (!childExit) child.kill();
  await childExitPromise;
  const safeParent = path.resolve(root, '.local-data');
  if (path.dirname(path.resolve(dataDir)) !== safeParent || !path.basename(dataDir).startsWith('smoke-')) throw new Error('Refusing unsafe smoke cleanup.');
  await fs.rm(dataDir, { recursive: true, force: true });
}
