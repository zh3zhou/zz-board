import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
export const milestoneDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:\d{2}))?$/).refine(value => Number.isFinite(Date.parse(value))).nullable();
export const milestoneSchema = z.object({
  id: text(120), kind: z.enum(['achievement', 'decision', 'discussion', 'version']), title: text(180),
  occurredAt: milestoneDateSchema,
  problem: text(700).nullable(), options: z.array(text(400)).max(6), decision: text(700).nullable(), result: text(700).nullable(),
  resolution: z.enum(['open', 'decided', 'delivered', 'verified', 'withdrawn']),
  sourceRefs: z.array(text(700)).min(1).max(12),
  version: z.object({ product: text(180).nullable(), number: text(80), stage: z.enum(['source', 'built', 'running']) }).strict().nullable()
}).strict().superRefine((value, ctx) => {
  if ((value.kind === 'version') !== Boolean(value.version)) ctx.addIssue({ code: 'custom', message: 'Version milestones require version identity.' });
  if (value.resolution === 'decided' && !value.decision) ctx.addIssue({ code: 'custom', message: 'Decision requires an explicit decision.' });
  if (['delivered', 'verified'].includes(value.resolution) && !value.result) ctx.addIssue({ code: 'custom', message: 'Delivery requires a result.' });
});
export const milestoneOutputSchema = z.object({ milestones: z.array(milestoneSchema).max(24) }).strict();
export type Milestone = z.infer<typeof milestoneSchema>;
export interface MilestoneSource { id: string; role: 'user' | 'assistant' | 'file'; occurredAt: string; turnId: string | null; path: string | null; heading?: string; fingerprint?: string }
export interface ProjectMilestone {
  key: string; projectKey: string; sourceKey: string; sourceLabel: string; sourceKind: 'thread' | 'file'; threadKey: string | null;
  value: Milestone; sources: MilestoneSource[]; sourceUpdatedAt: string; checkedAt: string; summarizedAt: string;
  revision: number; changeSequence: number; unread: boolean;
}
export interface TimelinePage { items: ProjectMilestone[]; total: number; unread: number; nextOffset: number | null; throughSequence: number }
export function milestoneGroupKey(item: Pick<ProjectMilestone, 'key' | 'projectKey' | 'sourceKey' | 'value'>): string {
  const version = item.value.version;
  return version ? JSON.stringify([item.projectKey, version.product ?? item.sourceKey, version.number]) : item.key;
}
export interface FileEvidence {
  fileKey: string; projectKey: string; projectName: string; label: string; path: string; heading: string;
  fingerprint: string; fileFingerprint: string; sourceUpdatedAt: string; checkedAt: string;
  evidence: Array<MilestoneSource & { text: string }>;
}
export interface HistoryPreview {
  projectKey: string; fingerprint: string; files: Array<{ name: string; bytes: number; blocks: number; pending: number }>;
  blocks: number; pending: number; characters: number; estimatedInputTokens: [number, number]; gaps: string[];
}
export interface AutoCheckState {
  enabled: boolean; intervalHours: 24; state: 'idle' | 'running' | 'paused'; lastStartedAt: string | null; lastCompletedAt: string | null;
  nextCheckAt: string | null; completedProjects: number; totalProjects: number; updatedThreads: number; message: string; jobId: string | null;
  /** Present only while a previous daily preference awaits a confirmed manual check. */
  recoveryToken?: string | null;
  failureCode?: string | null;
  transientFailures?: number;
}
export const initialAutoCheck = (): AutoCheckState => ({ enabled: false, intervalHours: 24, state: 'idle', lastStartedAt: null,
  lastCompletedAt: null, nextCheckAt: null, completedProjects: 0, totalProjects: 0, updatedThreads: 0, message: '自动检查默认关闭；确认 Codex 读取和模型用量后可开启。', jobId: null });
