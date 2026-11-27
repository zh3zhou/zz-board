import { z } from 'zod';
import { coverageSchema, evidenceSourceSchema, runtimeStateSchema, snapshotProjectSchema, sourceKindSchema } from './schema.js';

export const SUMMARY_PROMPT_VERSION = 'project-recap-7';
export const MAX_EVIDENCE_BYTES = 8_000_000;
const text = (max: number) => z.string().trim().min(1).max(max);
export const sourceThreadSchema = z.object({
  threadKey: text(700), threadId: text(400), projectKey: text(300), hostId: text(300).nullable(),
  sourceKind: sourceKindSchema, title: text(500), sidebarIndex: z.number().int().nonnegative().optional(),
  sourceUpdatedAt: z.string().datetime(), evidenceCheckedAt: z.string().datetime(),
  runtimeState: runtimeStateSchema, readComplete: z.boolean(), readReason: text(1000),
  requestOnlyTurnId: text(400).optional(),
  evidence: z.array(evidenceSourceSchema.extend({ text: text(16000) }).strict()).min(1).max(60)
}).strict().superRefine((value, ctx) => {
  if (new Set(value.evidence.map(e => e.id)).size !== value.evidence.length) ctx.addIssue({ code: 'custom', message: 'Duplicate evidence id.' });
  if (value.requestOnlyTurnId) {
    const tail = value.evidence.filter(e => e.turnId === value.requestOnlyTurnId);
    if (!tail.length || tail.some(e => e.role !== 'user')) ctx.addIssue({ code: 'custom', message: 'Latest request needs retained user evidence.' });
  }
  if (value.evidence.reduce((n, e) => n + e.text.length, 0) > 60000) ctx.addIssue({ code: 'custom', message: 'Thread evidence exceeds 60000 characters; declare partial coverage.' });
});
export const evidenceBundleSchema = z.object({
  schemaVersion: z.literal(1), generatedAt: z.string().datetime(),
  coverage: coverageSchema, projects: z.array(snapshotProjectSchema).max(500),
  threads: z.array(sourceThreadSchema).max(500)
}).strict().superRefine((value, ctx) => {
  const projects = new Set(value.projects.map(p => p.projectKey));
  if (projects.size !== value.projects.length || new Set(value.threads.map(t => t.threadKey)).size !== value.threads.length) ctx.addIssue({ code: 'custom', message: 'Duplicate project or thread.' });
  const identities = value.threads.map(t => JSON.stringify([t.sourceKind, t.hostId, t.threadId]));
  if (new Set(identities).size !== identities.length) ctx.addIssue({ code: 'custom', message: 'Duplicate source identity.' });
  if (value.threads.some(t => !projects.has(t.projectKey))) ctx.addIssue({ code: 'custom', message: 'Unknown project.' });
});
export const summarySettingsSchema = z.object({ model: text(120), effort: text(40) }).strict();
export const DEFAULT_SUMMARY_SETTINGS = { model: 'gpt-6.2-sol', effort: 'medium' };
export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;
export type SourceThread = z.infer<typeof sourceThreadSchema>;
export type SummarySettings = z.infer<typeof summarySettingsSchema>;
export interface SummaryUsage { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number; totalTokens: number }
export interface SummaryModel { id: string; efforts: string[] }
export interface SyncJob {
  kind?: 'conversations' | 'history';
  id: string; state: 'queued' | 'running' | 'paused' | 'complete' | 'cancelled';
  createdAt: string; updatedAt: string; completed: number; total: number; skipped: number;
  error: string | null; usage: SummaryUsage | null; model: string; effort: string;
  coverage: EvidenceBundle['coverage']; needsResubmit: boolean;
  /** Optional on older saved jobs. Only successfully committed changed summaries. */
  updatedThreadKeys?: string[];
  failures?: Array<{ threadKey: string; code: string }>;
  warnings?: Array<{ threadKey: string; code: 'artifact_omitted'; count: number }>;
}
