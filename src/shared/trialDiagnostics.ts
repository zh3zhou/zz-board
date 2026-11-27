import { z } from 'zod';

export const trialDiagnosticsMarker = z.object({ schemaVersion: z.literal(1) }).strict();
export const TRIAL_LOG_BYTES = 8 * 1024 * 1024;
const outcome = z.enum(['start', 'ok', 'blocked', 'failed']);
const boundedNumber = z.number().int().min(0).max(1_000_000_000);
const optionalCount = boundedNumber.optional();
const isoTime = z.string().max(32).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/)
  .refine(value => Number.isFinite(Date.parse(value)));
const base = z.object({
  schemaVersion: z.literal(1),
  at: isoTime,
  outcome,
  elapsedMs: optionalCount
});
const setup = base.extend({
  layer: z.literal('setup'),
  event: z.enum(['preflight', 'build', 'install', 'start', 'bind', 'verify']),
  code: z.enum(['prerequisite_missing', 'existing_installation', 'port_conflict', 'build_failed', 'install_failed', 'start_failed', 'bind_failed', 'verify_failed']).optional()
}).strict();
const desktop = base.extend({
  layer: z.literal('desktop'),
  at: z.number().int().min(0).max(8_640_000_000_000_000),
  event: z.enum(['app_start', 'window_ready', 'window_show', 'window_hide', 'tray_open', 'tray_restart', 'tray_quit', 'sidecar_spawn', 'sidecar_ready', 'sidecar_stop', 'sidecar_exit', 'health_conflict', 'health_unavailable'])
}).strict();
const route = z.enum([
  'health', 'board', 'pages', 'notes', 'ink', 'links', 'media', 'exports', 'skins', 'settings', 'history',
  'snapshots', 'codex_access', 'codex_prepare', 'project_excerpts', 'project_refresh', 'project_history',
  'sync', 'models', 'feedback', 'curator', 'other_api'
]);
export type TrialRoute = z.infer<typeof route>;

const server = base.extend({
  layer: z.literal('server'),
  event: z.enum(['api', 'service', 'codex_access', 'codex_read', 'model', 'sync_job']),
  route: route.optional(),
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']).optional(),
  status: z.number().int().min(100).max(599).optional(),
  code: z.enum(['aborted', 'authorization_required', 'read_error', 'model_error', 'usage_unavailable', 'paused', 'cancelled', 'partial', 'stopped']).optional(),
  jobState: z.enum(['queued', 'running', 'paused', 'complete', 'cancelled']).optional(),
  localRead: z.boolean().optional(),
  modelUse: z.boolean().optional(),
  completed: optionalCount,
  skipped: optionalCount,
  failed: optionalCount,
  inputTokens: optionalCount,
  outputTokens: optionalCount
}).strict();
export type TrialServerEvent = Omit<z.infer<typeof server>, 'schemaVersion' | 'layer' | 'at'>;

export const trialWebEventSchema = z.object({
  event: z.enum(['window_loaded', 'render_error', 'request_failure', 'feedback_preview', 'feedback_copy', 'feedback_save']),
  outcome
}).strict();
export type TrialWebEvent = z.infer<typeof trialWebEventSchema>;
const web = base.merge(trialWebEventSchema).extend({ layer: z.literal('web') }).strict();
export const trialEventSchema = z.discriminatedUnion('layer', [setup, desktop, server, web]);
export type TrialEvent = z.infer<typeof trialEventSchema>;
