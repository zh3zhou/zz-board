import { z } from 'zod';

const id = (max: number) => z.string().min(1).max(max).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));

/** UUID text is case-insensitive. Other provider IDs are opaque and must compare exactly. */
export function codexThreadUuid(value: string): string | null {
  return /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value) ? value.toLowerCase() : null;
}

/** The origin belongs to the note even if the user moves it or edits its text. */
export const conversationNoteSourceSchema = z.object({
  projectKey: id(300), sourceKind: z.enum(['codex', 'remote']), hostId: id(300),
  threadId: id(400), threadKey: id(700).nullable()
}).strict();
export type ConversationNoteSource = z.infer<typeof conversationNoteSourceSchema>;

export const captureConversationNoteSchema = z.object({
  mode: z.enum(['preview', 'apply']), expectedDataStoreId: z.string().regex(/^[0-9a-f]{16}$/),
  clientRequestId: z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  project: z.union([z.object({ directory: id(1500) }).strict(), z.object({ projectKey: id(300) }).strict()]),
  expectedProjectKey: id(300).optional(),
  source: z.object({ hostId: id(300), threadId: id(400), threadKey: id(700).optional() }).strict(),
  title: z.string().trim().min(1).max(500), body: z.string().min(1).max(20_000).refine(text => text.trim().length > 0)
}).strict().refine(input => input.mode !== 'apply' || input.expectedProjectKey !== undefined, {
  message: 'Apply requires the previewed project key.', path: ['expectedProjectKey']
});
export type CaptureConversationNoteInput = z.infer<typeof captureConversationNoteSchema>;

export interface ConversationNoteReceipt {
  status: 'preview' | 'created' | 'existing';
  noteId: string;
  projectKey: string;
  projectName: string;
  projectNodeId: string;
  pageId: string;
  pageName: string;
  source: ConversationNoteSource;
  /** On replay only: the explicit key independently resolved for a note saved before first sync. */
  resolvedThreadKey?: string;
}
