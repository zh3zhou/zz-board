import { z } from 'zod';

export const MAX_FEEDBACK_BYTES = 64 * 1024;
export const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
export const FEEDBACK_RETRY_MS = 24 * 60 * 60 * 1000;
export const FEEDBACK_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const FEEDBACK_TOMBSTONE_MS = 25 * 60 * 60 * 1000;
const instant = z.string().datetime({ offset: true });
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/).max(80);
export const feedbackDiagnosticsSchema = z.object({
  schemaVersion: z.literal(1), generatedAt: instant, uiVersion: version,
  service: z.object({ state: z.enum(['connected', 'last-observed', 'unavailable']), version: version.optional() }).strict(),
  runtime: z.object({
    appVersion: version, nodeVersion: z.string().regex(/^v?\d+\.\d+\.\d+$/).max(40),
    platform: z.enum(['win32', 'linux', 'darwin']), arch: z.enum(['x64', 'arm64', 'ia32']),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
    releaseChannel: z.string().regex(/^(alpha|beta|rc)\.\d+$|^stable$|^development$/).optional(),
    declaredBuild: z.enum(['official', 'modified', 'development', 'unknown']).optional(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional()
  }).strict().optional(),
  errors: z.array(z.object({
    module: z.enum(['app', 'service', 'summary', 'feedback']),
    code: z.enum(['unknown', 'unavailable', 'runtime_timeout', 'quota_exhausted', 'chatgpt_login_required', 'feedback_timeout', 'feedback_rejected', 'version_mismatch']),
    httpStatus: z.number().int().min(400).max(599).optional()
  }).strict()).max(5).optional()
}).strict().refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= MAX_DIAGNOSTIC_BYTES, 'Diagnostic package is too large.');

export const feedbackFieldsSchema = z.object({
  kind: z.enum(['problem', 'idea']), goal: z.string().max(4000), actual: z.string().max(8000), expected: z.string().max(4000),
  dataImpact: z.enum(['none', 'possible', 'unknown']), contact: z.string().max(300).optional()
}).strict().refine(value => Boolean(value.actual.trim() || value.goal.trim() || value.expected.trim()), 'Please describe the problem or idea.');

export const feedbackSubmissionSchema = z.object({
  schemaVersion: z.literal(1), reportId: z.string().uuid(), createdAt: instant, retryUntil: instant,
  kind: z.enum(['problem', 'idea']), goal: z.string().max(4000), actual: z.string().max(8000), expected: z.string().max(4000),
  dataImpact: z.enum(['none', 'possible', 'unknown']), contact: z.string().max(300).optional(),
  diagnostics: feedbackDiagnosticsSchema.optional(), deleteTokenHash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict().superRefine((value, ctx) => {
  if (!value.actual.trim() && !value.goal.trim() && !value.expected.trim()) ctx.addIssue({ code: 'custom', message: 'Please describe the problem or idea.' });
  if (Date.parse(value.retryUntil) - Date.parse(value.createdAt) !== FEEDBACK_RETRY_MS) ctx.addIssue({ code: 'custom', message: 'Invalid retry window.' });
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_FEEDBACK_BYTES) ctx.addIssue({ code: 'custom', message: 'Feedback request is too large.' });
});
export const feedbackDeleteSchema = z.object({ schemaVersion: z.literal(1), reportId: z.string().uuid(), deleteToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export const feedbackReceiptSchema = z.object({ schemaVersion: z.literal(1), reportId: z.string().uuid(), acceptedAt: instant, retainedUntil: instant }).strict()
  .refine(value => Date.parse(value.retainedUntil) - Date.parse(value.acceptedAt) === FEEDBACK_RETENTION_MS, 'Invalid retention window.');
export const feedbackDeleteReceiptSchema = z.object({ schemaVersion: z.literal(1), reportId: z.string().uuid(), deleted: z.literal(true) }).strict();

export type FeedbackFields = z.infer<typeof feedbackFieldsSchema>;
export type FeedbackSubmission = z.infer<typeof feedbackSubmissionSchema>;
export type FeedbackDiagnostics = z.infer<typeof feedbackDiagnosticsSchema>;
export type FeedbackReceipt = z.infer<typeof feedbackReceiptSchema>;
export type FeedbackDeleteRequest = z.infer<typeof feedbackDeleteSchema>;

/** Stable content digest input; never include transient transport or IP metadata. */
export function canonicalFeedback(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalFeedback).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, item]) => `${JSON.stringify(key)}:${canonicalFeedback(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
