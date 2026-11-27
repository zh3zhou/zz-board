import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SMOKE_RUNTIME = 'Nodejs24.11';
export const SMOKE_CANARY = 'zzb-deploy-smoke-v1';
const ROOT = path.resolve('.tmp/cloudbase-deploy-smoke');
const TEMPLATE = path.resolve('cloudbase/deploy-smoke/template');

const hash = value => createHash('sha256').update(value).digest('hex');

export function makeSmokeName(now = new Date()) {
  const suffix = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14).toLowerCase();
  return `zzb-deploy-smoke-${suffix}`;
}

export function buildSmokePlan({ name = makeSmokeName(), envId, root = ROOT } = {}) {
  if (!/^[a-z][a-z0-9-]{2,59}$/.test(name) || !name.startsWith('zzb-deploy-smoke-')) throw new Error('Smoke function name is outside the owned zzb-deploy-smoke namespace.');
  if (typeof envId !== 'string' || !envId) throw new Error('An explicit CloudBase environment ID is required.');
  // The live MCP packs the supplied directory itself. Keep the launch files at
  // that directory's root; its documented parent-directory convention did not
  // include scf_bootstrap in a real dry-run package.
  const functionRootPath = path.join(root, name);
  return {
    schemaVersion: 1,
    mode: 'deploy-smoke',
    envId,
    name,
    functionRootPath,
    template: TEMPLATE,
    canary: SMOKE_CANARY,
    create: {
      action: 'createFunction',
      // The live MCP schema reserves protocolType for WebSocket functions; HTTP
      // is implied by type and passing "HTTP" is rejected before deployment.
      func: { name, type: 'HTTP', runtime: SMOKE_RUNTIME, timeout: 20 },
      functionRootPath
    },
    readback: { action: 'getFunctionDetail', functionName: name },
    cleanup: { action: 'deleteFunction', functionName: name, confirm: true },
    invariants: [
      'No database, API key, environment variable, trigger, gateway route, OPA policy, or permission mutation.',
      'No public security-rule relaxation; the platform default remains in force.',
      'The only allowed deletion target is the function name generated for this run.'
    ]
  };
}

export async function stageSmoke(plan) {
  const target = plan.functionRootPath;
  if (!path.resolve(plan.functionRootPath).startsWith(ROOT + path.sep)) throw new Error('Smoke staging must remain under .tmp.');
  await mkdir(ROOT, { recursive: true });
  const rootInfo = await lstat(ROOT);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Smoke staging root must be a real directory.');
  const parentInfo = await lstat(path.dirname(ROOT));
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error('Smoke staging parent must be a real directory.');
  // Never replace a run directory: it may be evidence from a failed cleanup.
  await mkdir(plan.functionRootPath, { recursive: false });
  await cp(TEMPLATE, target, { recursive: true, force: false });
  const bootstrap = await readFile(path.join(target, 'scf_bootstrap'), 'utf8');
  if (bootstrap !== '#!/bin/bash\nexec /var/lang/node24/bin/node index.cjs\n') throw new Error('The smoke bootstrap is not the reviewed Node 24 launcher.');
  const source = await readFile(path.join(target, 'index.cjs'), 'utf8');
  if (!source.includes(`'${SMOKE_CANARY}'`) || /headers|process\.env|x-cloudbase-context/i.test(source)) throw new Error('The smoke handler violates the fixed-payload privacy contract.');
  return { stagedPath: target, sourceSha256: hash(source), bootstrapSha256: hash(bootstrap) };
}

function readArg(flag) {
  const at = process.argv.indexOf(flag);
  return at < 0 ? undefined : process.argv[at + 1];
}

class OfficialMcpClient {
  constructor(entry) {
    this.child = spawn(process.execPath, [entry], { cwd: process.cwd(), windowsHide: true, stdio: 'pipe', env: { ...process.env, TCB_SITE: 'domestic', INTEGRATION_IDE: 'CodeX' } });
    this.pending = new Map(); this.sequence = 0;
    this.child.stdin.on('error', () => {});
    const failPending = () => { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Official MCP transport ended.')); } this.pending.clear(); };
    this.child.once('error', failPending); this.child.once('exit', failPending);
    this.child.stderr.on('data', () => {});
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`Official MCP ${pending.method} failed.`)); else pending.resolve(message.result);
    });
  }
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence; const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Official MCP ${method} timed out.`)); }, 45_000);
      this.pending.set(id, { resolve, reject, timer, method }); this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async connect() {
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'zzb-deploy-smoke', version: '1' } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const inventory = await this.request('tools/list', {}); this.tools = inventory.tools ?? [];
    for (const required of ['auth', 'queryFunctions', 'manageFunctions']) if (!this.tools.some(tool => tool.name === required)) throw new Error(`Official MCP does not expose required tool ${required}.`);
  }
  async call(name, args) {
    const result = await this.request('tools/call', { name, arguments: args });
    if (result.isError) throw new Error(`Official MCP ${name} rejected the smoke operation.`);
    let parsed = result.structuredContent;
    if (!parsed) {
      const text = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
      try { parsed = JSON.parse(text); } catch { throw new Error(`Official MCP ${name} returned unrecognized output.`); }
    }
    if (parsed?.success === false || parsed?.ok === false || parsed?.Error || parsed?.Response?.Error) throw new Error(`Official MCP ${name} reported failure.`);
    return parsed;
  }
  async close() {
    this.lines.close(); this.child.stdin.end();
    if (this.child.exitCode === null) await new Promise(resolve => { const timer = setTimeout(() => { this.child.kill(); resolve(); }, 3000); this.child.once('exit', () => { clearTimeout(timer); resolve(); }); });
  }
}

const requestIds = value => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(requestIds) : Object.entries(value).flatMap(([key, item]) => /requestid/i.test(key) && typeof item === 'string' ? [item] : requestIds(item));
const summary = value => ({ responseSha256: hash(JSON.stringify(value)), requestIds: requestIds(value) });
export function functionNames(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(functionNames);
  const self = typeof value.FunctionName === 'string' ? [value.FunctionName] : [];
  return [...self, ...Object.values(value).flatMap(functionNames)];
}
export function completeFunctionList(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(completeFunctionList);
  if (value.HasMore === true) return false;
  if (Array.isArray(value.Functions)) {
    if (typeof value.TotalCount === 'number' && value.TotalCount > value.Functions.length) return false;
    return value.HasMore === false || (typeof value.TotalCount === 'number' && value.TotalCount === value.Functions.length);
  }
  return Object.values(value).some(completeFunctionList);
}

export async function applySmoke(plan, entry, injectedClient) {
  if (!injectedClient && !path.isAbsolute(entry)) throw new Error('Pass an absolute path to an already-installed official CloudBase MCP dist/cli.cjs entry.');
  const evidence = { schemaVersion: 1, mode: 'apply-smoke', name: plan.name, envId: plan.envId, runtime: SMOKE_RUNTIME, canary: SMOKE_CANARY, startedAt: new Date().toISOString(), createAttempted: false, created: false, deleted: false, deletionVerified: false };
  const client = injectedClient ?? new OfficialMcpClient(entry);
  try {
    await client.connect();
    const status = await client.call('auth', { action: 'status', site: 'domestic', region: 'ap-shanghai' });
    if (status.auth_status !== 'READY' || status.current_env_id !== plan.envId) throw new Error('Authenticated MCP binding does not match the explicit smoke environment.');
    const listed = await client.call('queryFunctions', { action: 'listFunctions', limit: 100 });
    if (!completeFunctionList(listed)) throw new Error('Function listing is incomplete; refusing to create a smoke resource.');
    if (functionNames(listed).includes(plan.name)) throw new Error('Refusing to reuse an existing cloud function name.');
    evidence.createAttempted = true;
    try { evidence.create = summary(await client.call('manageFunctions', plan.create)); }
    catch (error) { evidence.createError = error instanceof Error ? error.message : 'Unknown creation error.'; }
    let detail;
    try { detail = await client.call('queryFunctions', plan.readback); }
    catch (error) { evidence.readbackError = error instanceof Error ? error.message : 'Function was not readable after creation.'; }
    if (detail) {
      evidence.readback = summary(detail);
      evidence.created = functionNames(detail).includes(plan.name);
      const matchesRuntime = value => value && typeof value === 'object' && (Array.isArray(value)
        ? value.some(matchesRuntime)
        : (value.FunctionName === plan.name && value.Runtime === SMOKE_RUNTIME) || Object.values(value).some(matchesRuntime));
      evidence.runtimeVerified = Boolean(matchesRuntime(detail));
      if (!evidence.created || !evidence.runtimeVerified) evidence.failure = 'Function readback does not prove the expected name and Nodejs24.11 runtime.';
    }
    // A timeout or an unsupported detail shape must be reconciled before
    // cleanup. Initial listing proved this name was not pre-existing, so only
    // a later listing containing this exact name authorizes its deletion.
    evidence.httpInvocation = 'not-verified; no publishable key, policy change, or gateway resource was introduced';
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message : 'Unknown smoke failure.';
  } finally {
    // Ownership reconciliation is a separate terminal phase. A failed create
    // or mismatched readback must not jump around cleanup via an exception.
    if (!evidence.created && evidence.createAttempted) {
      try {
        const afterCreate = await client.call('queryFunctions', { action: 'listFunctions', limit: 100 });
        evidence.afterCreateList = summary(afterCreate);
        evidence.created = completeFunctionList(afterCreate) && functionNames(afterCreate).includes(plan.name);
        if (!evidence.created) evidence.creationUnconfirmed = true;
      } catch (error) { evidence.creationUnconfirmed = true; evidence.afterCreateListError = error instanceof Error ? error.message : 'Could not reconcile creation state.'; }
    }
    if (evidence.created) {
      try {
        evidence.delete = summary(await client.call('manageFunctions', plan.cleanup)); evidence.deleted = true;
        const afterDelete = await client.call('queryFunctions', { action: 'listFunctions', limit: 100 }); evidence.deleteReadback = summary(afterDelete);
        evidence.deletionVerified = completeFunctionList(afterDelete) && !functionNames(afterDelete).includes(plan.name);
        if (!evidence.deletionVerified) evidence.cleanupError = 'Post-delete listing is incomplete or the named smoke function remains visible.';
      }
      catch (error) { evidence.cleanupError = error instanceof Error ? error.message : 'Unknown cleanup failure.'; }
    }
    evidence.finishedAt = new Date().toISOString();
    try { await client.close(); } catch { evidence.transportCloseError = true; }
  }
  return evidence;
}

async function main() {
  const apply = process.argv.includes('--apply-smoke');
  const envId = readArg('--env-id');
  const name = readArg('--name');
  const entry = readArg('--entry');
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/cloudbase-feedback-deploy-smoke.mjs --env-id <explicit-env-id> [--name <zzb-deploy-smoke-name>] [--apply-smoke --entry <absolute-official-mcp-dist-cli.cjs>]'); return;
  }
  if (!envId) throw new Error('Pass --env-id <explicit-env-id>; the script never relies on an implicit CloudBase binding.');
  const plan = buildSmokePlan({ envId, ...(name ? { name } : {}) });
  const staged = await stageSmoke(plan);
  const output = path.join(ROOT, `${plan.name}.plan.json`);
  await writeFile(output, JSON.stringify({ ...plan, staged, applyRequested: apply }, null, 2) + '\n');
  if (apply) {
    if (!entry) throw new Error('--apply-smoke requires --entry <absolute-existing-official-mcp-dist-cli.cjs>; no package is installed or downloaded.');
    const evidence = await applySmoke(plan, path.resolve(entry));
    const evidencePath = path.join(ROOT, `${plan.name}.evidence.json`);
    await writeFile(evidencePath, JSON.stringify({ ...evidence, staged }, null, 2) + '\n');
    if (!evidence.deleted || !evidence.deletionVerified || evidence.failure || evidence.createError || evidence.readbackError) throw new Error(`Smoke did not complete cleanly; evidence retained at ${evidencePath}: ${evidence.cleanupError ?? evidence.failure ?? evidence.createError ?? evidence.readbackError ?? 'unknown failure'}`);
    console.log(JSON.stringify({ result: 'METADATA_DEPLOY_CLEANED', evidence: path.relative(process.cwd(), evidencePath), name: plan.name, runtime: SMOKE_RUNTIME })); return;
  }
  console.log(JSON.stringify({ result: 'DRY_RUN_READY', plan: path.relative(process.cwd(), output), name: plan.name, runtime: SMOKE_RUNTIME, canary: SMOKE_CANARY }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
