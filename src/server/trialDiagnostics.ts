import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { APP_VERSION } from '../shared/version.js';
import { TRIAL_LOG_BYTES, trialDiagnosticsMarker, trialEventSchema, trialWebEventSchema, type TrialRoute, type TrialServerEvent, type TrialWebEvent } from '../shared/trialDiagnostics.js';
import type { SyncJob } from '../shared/summarySync.js';
import type { SummaryRunner } from './summaryJobs.js';

export function isPackagedTrial(env: NodeJS.ProcessEnv, entry = process.argv[1]): boolean {
  // A runtime variable never opts in. The executable selects a SHA-bound
  // manifest; also verify it here before trusting the packaged server's marker.
  if (!entry || path.basename(entry) !== 'server.cjs' || env.ZZ_BOARD_RUNTIME !== 'desktop-sidecar') return false;
  try {
    const file = path.join(path.dirname(entry), 'manifest.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 2_000_000) return false;
    const bytes = fs.readFileSync(file);
    if ('zzb-runtime-' + createHash('sha256').update(bytes).digest('hex') !== env.ZZ_BOARD_PACKAGED_RUNTIME) return false;
    const manifest = JSON.parse(bytes.toString('utf8'));
    return manifest.schemaVersion === 2 && manifest.appVersion === APP_VERSION && trialDiagnosticsMarker.safeParse(manifest.trialDiagnostics).success;
  } catch {
    return false;
  }
}

function noLink(target: string) {
  const entry = fs.lstatSync(target, { throwIfNoEntry: false });
  if (entry?.isSymbolicLink()) throw Error('invalid trial log path');
  return entry;
}

const routeGroups: ReadonlyArray<readonly [string, TrialRoute]> = [
  ['/api/health', 'health'], ['/api/board', 'board'], ['/api/pages', 'pages'],
  ['/api/notes', 'notes'], ['/api/nodes', 'notes'], ['/api/ink', 'ink'],
  ['/api/links', 'links'], ['/api/media', 'media'], ['/api/image-exports', 'exports'],
  ['/api/skins', 'skins'], ['/api/settings', 'settings'], ['/api/history', 'history'],
  ['/api/snapshots', 'snapshots'], ['/api/snapshot', 'snapshots'],
  ['/api/codex/access', 'codex_access'], ['/api/codex', 'codex_prepare'],
  ['/api/sync', 'sync'], ['/api/summary', 'models'], ['/api/feedback', 'feedback'],
  ['/api/curator', 'curator']
];

export function normalizeTrialRoute(template?: string): TrialRoute | undefined {
  if (!template?.startsWith('/api/') || template.startsWith('/api/trial/')) return;
  if (template.startsWith('/api/projects/')) {
    if (template.endsWith('/source-excerpt')) return 'project_excerpts';
    if (template.includes('/history') || template.includes('/conversations')) return 'project_history';
    return 'project_refresh';
  }
  return routeGroups.find(([prefix]) => template === prefix || template.startsWith(prefix + '/') || template.startsWith(prefix + '-'))?.[1] ?? 'other_api';
}

export class TrialDiagnostics {
  private writeFailed = false;

  constructor(private readonly dataDir: string) {}

  status(): 'active' | 'write_failed' { return this.writeFailed ? 'write_failed' : 'active'; }

  private append(layer: 'server' | 'web', event: TrialServerEvent | TrialWebEvent) {
    const validated = trialEventSchema.safeParse({ schemaVersion: 1, at: new Date().toISOString(), layer, ...event });
    if (!validated.success) return false;
    try {
      const logs = path.join(this.dataDir, 'logs');
      const directory = path.join(logs, 'trial');
      const file = path.join(directory, layer + '.jsonl');
      for (let parent = directory; ; parent = path.dirname(parent)) {
        const entry = noLink(parent);
        if (entry && !entry.isDirectory()) throw Error('invalid trial log directory');
        if (path.dirname(parent) === parent) break;
      }
      fs.mkdirSync(directory, { recursive: true });
      const entry = noLink(file);
      const text = JSON.stringify(validated.data) + '\n';
      if (entry && (!entry.isFile() || entry.nlink !== 1 || entry.size + Buffer.byteLength(text) > TRIAL_LOG_BYTES)) throw Error('trial log unavailable');
      fs.appendFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch {
      this.writeFailed = true;
      return false;
    }
  }

  record(event: TrialServerEvent) { this.append('server', event); }

  observeSyncJob(job: Readonly<SyncJob>) {
    const outcome = { queued: 'start', running: 'start', paused: 'blocked', complete: 'ok', cancelled: 'blocked' } as const;
    const failed = job.failures?.length ?? 0;
    this.record({ event: 'sync_job', jobState: job.state, outcome: outcome[job.state],
      completed: job.completed, skipped: job.skipped, failed,
      ...(job.state === 'paused' ? { code: failed ? 'partial' : 'paused' } : {}),
      ...(job.state === 'cancelled' ? { code: 'cancelled' } : {}) });
  }

  register(app: FastifyInstance) {
    app.post('/api/trial/diagnostics/events', { bodyLimit: 256, logLevel: 'silent' }, async (request, reply) => {
      const parsed = trialWebEventSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ code: 'invalid_trial_event' });
      return this.append('web', parsed.data)
        ? reply.code(204).send()
        : reply.code(503).send({ code: 'trial_diagnostics_unavailable' });
    });
    app.addHook('onResponse', (request, reply, done) => {
      const route = normalizeTrialRoute(request.routeOptions.url);
      if (route && request.method !== 'OPTIONS') {
        const method = request.method as TrialServerEvent['method'];
        this.record({ event: 'api', outcome: reply.statusCode < 400 ? 'ok' : reply.statusCode < 500 ? 'blocked' : 'failed',
          route, method, status: reply.statusCode, elapsedMs: Math.round(reply.elapsedTime) });
      }
      done();
    });
    app.addHook('onRequestAbort', (request, done) => {
      const route = normalizeTrialRoute(request.routeOptions.url);
      if (route) this.record({ event: 'api', route, outcome: 'failed', code: 'aborted' });
      done();
    });
  }

  wrapModel(runner: SummaryRunner): SummaryRunner {
    return {
      summarize: async input => {
        const started = performance.now();
        this.record({ event: 'model', outcome: 'start' });
        try {
          const response = await runner.summarize(input);
          this.record({ event: 'model', outcome: 'ok', elapsedMs: Math.round(performance.now() - started),
            ...(response.usage ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens } : { code: 'usage_unavailable' }) });
          return response;
        } catch (error) {
          this.record({ event: 'model', outcome: 'failed', code: input.signal?.aborted ? 'aborted' : 'model_error', elapsedMs: Math.round(performance.now() - started) });
          throw error;
        }
      }
    };
  }
}
