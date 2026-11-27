import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { disableListedMcp, parseFeatureNames, configurationArgs } from '../../src/server/codex/summaryRuntime.js';
import { CodexSummaryRuntime, assertEphemeralStart, assertIsolationConfiguration, assertNoToolsRequest, assertStartupConfiguration, catalogSettings, classifyTurnFailure, isolationSettings, parseModelChoices, parseSummaryUsage, productionEnvironment, restrictCatalog } from '../../src/server/codex/summaryRuntime.js';

const privateOtel = { exporter: 'none', trace_exporter: 'none', metrics_exporter: 'none', log_user_prompt: false };

describe('summary runtime boundaries', () => {
  it('disables literal dotted feature names through one TOML table and verifies the effective flat key', () => {
    const names = parseFeatureNames('shell_tool stable true\nguardianv2.thread_context under development false\nobsolete removed true');
    expect(names).toEqual(['shell_tool', 'guardianv2.thread_context']);
    const settings = { 'features.shell_tool': false, 'features.guardianv2.thread_context': false };
    expect(configurationArgs(settings)).toEqual(['-c', 'features={"shell_tool"=false,"guardianv2.thread_context"=false}']);
    const config = { features: { shell_tool: false, 'guardianv2.thread_context': false }, otel: privateOtel };
    expect(() => assertIsolationConfiguration({ config }, settings)).not.toThrow();
    expect(() => assertIsolationConfiguration({ config: { ...config, features: { shell_tool: false, guardianv2: { thread_context: false } } } }, settings)).toThrow();
    expect(() => assertIsolationConfiguration({ config: { ...config, features: { ...config.features, 'guardianv2.thread_context': true } } }, settings)).toThrow();
    for (const name of ['', 'bad..name', 'bad"=true', 'a.__proto__', 'a.constructor']) expect(() => parseFeatureNames(`${name} stable true`)).toThrow();
  });
  it('invalidates a previous successful gate when a new preflight fails without exposing raw errors', async () => {
    const runtime = new CodexSummaryRuntime('unused', 'unused');
    const internals = runtime as unknown as { available: boolean; readModels(): Promise<unknown> };
    internals.available = true;
    vi.spyOn(internals, 'readModels').mockRejectedValue(Error('private upstream body'));
    await expect(runtime.models()).rejects.toThrow(); expect(runtime.status().available).toBe(false);
    expect(runtime.status().reason).not.toContain('private');
    internals.available = true;
    await expect(runtime.summarize({ model: 'test', effort: 'medium', prompt: '', outputSchema: {} })).rejects.toThrow();
    expect(runtime.status().available).toBe(false);
  });
  it('serializes initializers, cancels a queued caller and keeps state while cleaning request files', async () => {
    const parent = path.resolve('.tmp'); await mkdir(parent, { recursive: true });
    const dir = await mkdtemp(path.join(parent, 'runtime-unit-'));
    try {
      const runtime = new CodexSummaryRuntime('unused', dir) as unknown as { inDirectory<T>(work: (request: string, state: string) => Promise<T>, signal?: AbortSignal): Promise<T> };
      let release!: () => void; let started!: () => void;
      const hold = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { started = resolve; });
      const order: string[] = [];
      const first = runtime.inDirectory(async (request, state) => { order.push('first'); await writeFile(path.join(state, 'marker'), 'persistent'); await writeFile(path.join(request, 'evidence'), 'synthetic'); started(); await hold; });
      await ready;
      const controller = new AbortController();
      const cancelled = runtime.inDirectory(async () => { order.push('cancelled'); }, controller.signal).catch(error => error);
      const last = runtime.inDirectory(async (_request, state) => { order.push('last'); expect(await readFile(path.join(state, 'marker'), 'utf8')).toBe('persistent'); });
      controller.abort(); expect((await cancelled).code).toBe('cancelled'); expect(order).toEqual(['first']);
      release(); await Promise.all([first, last]); expect(order).toEqual(['first', 'last']);
      await expect(runtime.inDirectory(async () => { throw Error('synthetic failure'); })).rejects.toThrow('synthetic failure');
      expect(await readdir(path.join(dir, 'summary-runtime'))).toEqual(['state']);
    } finally { if (path.dirname(dir) !== parent) throw Error('cleanup boundary'); await rm(dir, { recursive: true, force: true }); }
  });
  it('disables each listed MCP only in process flags and fails closed on new or unsafe names', () => {
    const baseline = { 'features.plugins': false };
    const settings = disableListedMcp(baseline, [{ name: 'local_tool', enabled: true, command: 'private' }, { name: 'remote-docs', enabled: false }]);
    expect(settings).toEqual({ ...baseline, 'mcp_servers.local_tool.enabled': false, 'mcp_servers.remote-docs.enabled': false });
    expect(baseline).toEqual({ 'features.plugins': false });
    for (const name of ['a.b', '"quoted"', '', '__proto__.x']) expect(() => disableListedMcp({}, [{ name }])).toThrow();
    expect(() => disableListedMcp({}, {})).toThrow();
    const config = { otel: privateOtel, features: { plugins: false }, mcp_servers: { local_tool: { enabled: false }, 'remote-docs': { enabled: false } } };
    expect(() => assertStartupConfiguration({ config }, settings)).not.toThrow();
    expect(() => assertStartupConfiguration({ config: { ...config, mcp_servers: { ...config.mcp_servers, newly_added: { enabled: true } } } }, settings)).toThrow();
  });
  it('keeps disposable evidence/log paths separate from reusable runtime state', () => {
    const settings = catalogSettings('/private/request-123', '/private/state');
    expect(settings.sqlite_home).toBe('/private/state'); expect(settings.log_dir).toBe('/private/request-123');
    expect(settings['history.persistence']).toBe('none');
  });
  it('classifies safe retry/pause reasons without forwarding upstream text', () => {
    expect(classifyTurnFailure({ codexErrorInfo: 'usageLimitExceeded', message: 'private' })).toBe('quota_exhausted');
    expect(classifyTurnFailure({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } })).toBe('temporary_network_error');
    expect(classifyTurnFailure({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 400 } } })).toBe('turn_failed');
    expect(classifyTurnFailure({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } })).toBe('chatgpt_login_required');
    expect(classifyTurnFailure({ message: 'private' })).toBe('turn_failed');
  });
  it('requires fake auth and genuinely empty outgoing tools, not prompt claims', () => {
    expect(() => assertNoToolsRequest({ model: 'test' }, 'Bearer zz-board-synthetic-probe', 'test')).not.toThrow();
    expect(() => assertNoToolsRequest({ model: 'test', tools: [] }, 'Bearer zz-board-synthetic-probe', 'test')).not.toThrow();
    for (const tools of [[{ name: 'apply_patch' }], null, 'none']) expect(() => assertNoToolsRequest({ model: 'test', tools }, 'Bearer zz-board-synthetic-probe', 'test')).toThrow();
    expect(() => assertNoToolsRequest({ model: 'test' }, 'Bearer real-secret', 'test')).toThrow();
    expect(() => assertNoToolsRequest({ model: 'different' }, 'Bearer zz-board-synthetic-probe', 'test')).toThrow();
  });
  it('requires ephemeral true, no saved path and the requested model', () => {
    expect(assertEphemeralStart({ model: 'test', thread: { id: 'temporary', ephemeral: true, path: null } }, 'test')).toBe('temporary');
    for (const thread of [{ id: 't', ephemeral: false }, { id: 't', ephemeral: true, path: '/saved' }, { id: 't' }]) expect(() => assertEphemeralStart({ model: 'test', thread }, 'test')).toThrow();
  });
  it('verifies effective config plus omitted tool fields via sessionFlags, rejects inherited hooks/providers', () => {
    const response = { config: { features: { shell_tool: false }, hooks: { SessionStart: [] }, otel: privateOtel }, layers: [{ name: { type: 'sessionFlags' }, config: { tools: { update_plan: { enabled: false } } } }] };
    const expected = { 'features.shell_tool': false, 'tools.update_plan.enabled': false };
    expect(() => assertIsolationConfiguration(response, expected)).not.toThrow();
    expect(() => assertIsolationConfiguration({ ...response, layers: [] }, expected)).toThrow();
    expect(() => assertIsolationConfiguration({ ...response, config: { ...response.config, hooks: { SessionStart: [{ command: 'untrusted' }] } } }, expected)).toThrow();
    expect(() => assertIsolationConfiguration({ ...response, config: { ...response.config, model_providers: { openai: { base_url: 'http://other' } } } }, expected)).toThrow();
    expect(() => assertIsolationConfiguration({ ...response, config: { ...response.config, features: { shell_tool: false, unknown_tool: true } } }, expected)).toThrow();
  });
  it('rejects top-level route overrides and any inherited telemetry exporter before releasing evidence', () => {
    const config = { otel: privateOtel, mcp_servers: { disabled: { enabled: false } } };
    expect(() => assertStartupConfiguration({ config }, {})).not.toThrow();
    expect(() => assertStartupConfiguration({ config: { ...config, chatgpt_base_url: 'https://chatgpt.com/backend-api/' }, layers: [] }, {})).not.toThrow();
    expect(() => assertStartupConfiguration({ config: { ...config, chatgpt_base_url: 'https://chatgpt.com/backend-api/' }, layers: [{ config: { chatgpt_base_url: 'https://chatgpt.com/backend-api/' } }] }, {})).toThrow();
    for (const route of ['openai_base_url', 'chatgpt_base_url']) {
      for (const value of ['https://untrusted.invalid', '']) expect(() => assertStartupConfiguration({ config: { ...config, [route]: value } }, {})).toThrow();
    }
    for (const field of ['exporter', 'trace_exporter', 'metrics_exporter']) {
      expect(() => assertStartupConfiguration({ config: { ...config, otel: { ...privateOtel, [field]: { 'otlp-http': { endpoint: 'https://untrusted.invalid' } } } } }, {})).toThrow();
    }
    expect(() => assertStartupConfiguration({ config: { ...config, otel: { ...privateOtel, log_user_prompt: true } } }, {})).toThrow();
    expect(() => assertStartupConfiguration({ config: {} }, {})).toThrow();
    expect(() => assertStartupConfiguration({ config: { ...config, mcp_servers: { inherited: {} } } }, {})).toThrow();
  });
  it('applies a shared privacy baseline to catalog, debug-helper and summary startup settings', () => {
    const baseline = catalogSettings('/private/runtime');
    const summary = isolationSettings('/private/runtime', '/private/runtime/catalog.json', ['shell_tool']);
    for (const settings of [baseline, summary]) {
      expect(settings['otel.exporter']).toBe('none');
      expect(settings['otel.trace_exporter']).toBe('none');
      expect(settings['otel.metrics_exporter']).toBe('none');
      expect(settings['otel.log_user_prompt']).toBe(false);
      expect(settings['hooks.SessionStart']).toEqual([]);
      expect(settings.notify).toEqual([]);
      expect(settings.model_provider).toBe('openai');
    }
  });
  it('removes routing, API-auth and telemetry environment overrides case-insensitively without changing the parent env', () => {
    const source = { CODEX_HOME: '/auth-home', CODEX_THREAD_ID: 'private', OPENAI_BASE_URL: 'https://untrusted.invalid', openai_api_key: 'secret', CHATGPT_BASE_URL: 'https://other.invalid', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.invalid', Otel_Log_Level: 'debug', PATH: '/bin' };
    expect(productionEnvironment(source)).toEqual({ CODEX_HOME: '/auth-home', PATH: '/bin', RUST_LOG: 'off', OTEL_SDK_DISABLED: 'true' });
    expect(source.openai_api_key).toBe('secret');
  });
  it('only reduces selected model tools without changing identity or reasoning metadata', () => {
    const selected = { slug: 'test-model', shell_type: 'unified_exec', apply_patch_tool_type: 'freeform', experimental_supported_tools: ['clock'], default_reasoning_level: 'medium', context_window: 1000 };
    expect(restrictCatalog({ models: [selected, { slug: 'hidden-model' }] }, 'test-model')).toEqual({ models: [{ ...selected, shell_type: 'disabled', apply_patch_tool_type: null, experimental_supported_tools: [] }] });
    expect(selected.apply_patch_tool_type).toBe('freeform');
    expect(() => restrictCatalog({ models: [] }, 'missing')).toThrow();
  });
  it('does not invent model effort support or reveal hidden models', () => {
    const model = { model: 'test', displayName: 'Test', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] };
    expect(parseModelChoices([model, { ...model, hidden: true }, { model: 'unsupported' }])).toEqual([{ id: 'test', displayName: 'Test', efforts: ['medium'], defaultEffort: 'medium' }]);
  });
  it('preserves runtime total and does not double-count reasoning or cache', () => {
    const raw = { inputTokens: 100, cachedInputTokens: 50, outputTokens: 30, reasoningOutputTokens: 20, totalTokens: 130 };
    expect(parseSummaryUsage(raw)).toEqual(raw);
    expect(parseSummaryUsage({ inputTokens: 100 })).toBeNull();
    expect(parseSummaryUsage({ ...raw, outputTokens: -1 })).toBeNull();
    expect(parseSummaryUsage(null)).toBeNull();
  });
  it('aborted input fails before starting a runtime or touching files', async () => {
    const runtime = new CodexSummaryRuntime('does-not-exist', 'unused');
    await expect(runtime.summarize({ model: 'test', effort: 'medium', prompt: 'private payload', outputSchema: {}, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(runtime.status().available).toBe(false);
  });
});
