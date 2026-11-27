import { z } from 'zod';

/** Local consent is separate from Codex account login and never travels in snapshots. */
export const codexAccessInputSchema = z.object({ localRead: z.boolean(), modelUse: z.boolean() }).strict()
  .refine(value => !value.modelUse || value.localRead, { message: '模型调用需要先允许本地来源读取。', path: ['modelUse'] });
export const codexAccessSchema = z.object({
  schemaVersion: z.literal(1), localRead: z.boolean(), modelUse: z.boolean(), decidedAt: z.string().datetime().nullable()
}).strict().refine(value => (!value.modelUse || value.localRead) && (!(value.localRead || value.modelUse) || value.decidedAt !== null));
export type CodexAccess = z.infer<typeof codexAccessSchema>;
export type CodexAccessRequirement = 'localRead' | 'modelUse';
export interface CodexOperationGuard { check(): void; signal?: AbortSignal }
export function checkCodexOperation(operation?: CodexOperationGuard): void {
  operation?.check(); operation?.signal?.throwIfAborted();
}
export const initialCodexAccess = (): CodexAccess => ({ schemaVersion: 1, localRead: false, modelUse: false, decidedAt: null });

export class CodexAccessRequiredError extends Error {
  readonly code = 'CODEX_ACCESS_REQUIRED';
  constructor(readonly required: CodexAccessRequirement) {
    super(required === 'localRead' ? '请先确认允许 ZZ Board 读取本地 Codex 来源；便签和画布仍可使用。' : '请先确认允许模型调用及其用量；已有画布内容保留。');
    this.name = 'CodexAccessRequiredError';
  }
}
export function requireCodexAccess(access: CodexAccess, required: CodexAccessRequirement): void {
  if (!access.localRead || !access.decidedAt) throw new CodexAccessRequiredError('localRead');
  if (required === 'modelUse' && !access.modelUse) throw new CodexAccessRequiredError('modelUse');
}
