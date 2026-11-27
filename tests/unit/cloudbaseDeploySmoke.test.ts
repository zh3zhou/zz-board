import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
const smoke = await import(new URL('../../scripts/cloudbase-feedback-deploy-smoke.mjs', import.meta.url).href);

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });

describe('CloudBase deployment smoke plan', () => {
  it('keeps the temporary HTTP function private, fixed-payload, and deletion-scoped', async () => {
    const plan = smoke.buildSmokePlan({ envId: 'synthetic-env', name: `zzb-deploy-smoke-${Date.now()}-private` }); temporary.push(plan.functionRootPath);
    expect(plan.create.func).toMatchObject({ type: 'HTTP', runtime: smoke.SMOKE_RUNTIME, timeout: 20 });
    expect(plan.create.func).not.toHaveProperty('protocolType');
    expect(plan.create.func).not.toHaveProperty('envVariables');
    expect(plan).not.toHaveProperty('gateway');
    expect(plan.cleanup).toEqual({ action: 'deleteFunction', functionName: plan.name, confirm: true });
    const staged = await smoke.stageSmoke(plan);
    expect(staged.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    const source = await readFile(path.join(staged.stagedPath, 'index.cjs'), 'utf8');
    expect(source).toContain(smoke.SMOKE_CANARY);
    expect(source).not.toMatch(/process\.env|headers|x-cloudbase-context/i);
  });

  it('rejects names outside its owned resource namespace', () => {
    expect(() => smoke.buildSmokePlan({ envId: 'synthetic-env', name: 'existing-function' })).toThrow('owned zzb-deploy-smoke namespace');
    expect(smoke.makeSmokeName(new Date('2026-10-11T12:34:56.000Z'))).toBe('zzb-deploy-smoke-20261011123456');
  });

  it('refuses to replace a prior smoke run directory', async () => {
    const plan = smoke.buildSmokePlan({ envId: 'synthetic-env', name: `zzb-deploy-smoke-${Date.now()}-existing` }); temporary.push(plan.functionRootPath);
    await (await import('node:fs/promises')).mkdir(plan.functionRootPath, { recursive: true });
    await writeFile(path.join(plan.functionRootPath, 'evidence.json'), 'keep');
    await expect(smoke.stageSmoke(plan)).rejects.toThrow();
    expect(await readFile(path.join(plan.functionRootPath, 'evidence.json'), 'utf8')).toBe('keep');
  });

  it('requires a complete exact-name function listing before creation or deletion', () => {
    expect(smoke.completeFunctionList({ Functions: [{ FunctionName: 'zzb-deploy-smoke-a' }], TotalCount: 1, HasMore: false })).toBe(true);
    expect(smoke.functionNames({ Functions: [{ FunctionName: 'zzb-deploy-smoke-a' }, { FunctionName: 'other' }] })).toEqual(['zzb-deploy-smoke-a', 'other']);
    expect(smoke.completeFunctionList({ Functions: [{ FunctionName: 'zzb-deploy-smoke-a' }], TotalCount: 2, HasMore: true })).toBe(false);
    expect(smoke.completeFunctionList({ Functions: [], TotalCount: 1, HasMore: false })).toBe(false);
  });

  it('reconciles a creation timeout by exact name and still deletes the owned resource', async () => {
    const plan = smoke.buildSmokePlan({ envId: 'synthetic-env', name: 'zzb-deploy-smoke-timeout' });
    const calls: string[] = []; let listed = 0;
    const client = { connect: async () => {}, close: async () => {}, call: async (name: string, args: { action: string }) => {
      calls.push(`${name}:${args.action}`);
      if (name === 'auth') return { auth_status: 'READY', current_env_id: 'synthetic-env' };
      if (name === 'manageFunctions' && args.action === 'createFunction') throw new Error('timeout');
      if (name === 'queryFunctions' && args.action === 'getFunctionDetail') return { FunctionName: plan.name, Runtime: smoke.SMOKE_RUNTIME };
      if (name === 'queryFunctions') return listed++ === 0 ? { Functions: [], TotalCount: 0, HasMore: false } : { Functions: [], TotalCount: 0, HasMore: false };
      return { RequestId: 'synthetic' };
    }};
    const evidence = await smoke.applySmoke(plan, 'C:\\official\\cli.cjs', client);
    expect(evidence.created).toBe(true); expect(evidence.deleted).toBe(true); expect(evidence.deletionVerified).toBe(true); expect(calls).toContain('manageFunctions:deleteFunction');
  });

  it('never deletes a pre-existing matching resource and reports incomplete cleanup listings', async () => {
    const plan = smoke.buildSmokePlan({ envId: 'synthetic-env', name: 'zzb-deploy-smoke-existing' });
    const existing = { connect: async () => {}, close: async () => {}, call: async (name: string, args: { action: string }) => name === 'auth' ? { auth_status: 'READY', current_env_id: 'synthetic-env' } : { Functions: [{ FunctionName: plan.name }], TotalCount: 1, HasMore: false } };
    const collision = await smoke.applySmoke(plan, 'C:\\official\\cli.cjs', existing);
    expect(collision.created).toBe(false); expect(collision.deleted).toBe(false); expect(collision.failure).toMatch(/reuse/);
  });

  it.each(['runtime-mismatch', 'delete-error', 'incomplete-readback'])('retains failed %s evidence and never reports verified cleanup too early', async mode => {
    const plan = smoke.buildSmokePlan({ envId: 'synthetic-env', name: `zzb-deploy-smoke-${mode}` });
    const actions: string[] = []; let listings = 0;
    const client = { connect: async () => {}, close: async () => {}, call: async (tool: string, args: { action: string }) => {
      actions.push(args.action);
      if (tool === 'auth') return { auth_status: 'READY', current_env_id: 'synthetic-env' };
      if (args.action === 'getFunctionDetail') return { FunctionName: plan.name, Runtime: mode === 'runtime-mismatch' ? 'Nodejs18.15' : smoke.SMOKE_RUNTIME };
      if (args.action === 'deleteFunction' && mode === 'delete-error') throw new Error('synthetic delete error');
      if (args.action === 'listFunctions') {
        listings++;
        return { Functions: [], TotalCount: listings > 1 && mode === 'incomplete-readback' ? 1 : 0, HasMore: false };
      }
      return { RequestId: 'synthetic' };
    }};
    const evidence = await smoke.applySmoke(plan, 'C:\\official\\cli.cjs', client);
    expect(evidence.created).toBe(true); expect(actions).toContain('deleteFunction');
    if (mode === 'runtime-mismatch') { expect(evidence.failure).toMatch(/runtime/); expect(evidence.deletionVerified).toBe(true); }
    else { expect(evidence.deletionVerified).toBe(false); expect(evidence.cleanupError).toBeTruthy(); }
  });
});
