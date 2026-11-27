import { z } from 'zod';
import type { SourceThread, SyncJob } from './summarySync.js';

export const conversationTurnSummarySchema = z.object({
  turnId: z.string().min(1).max(400), title: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(1000), continuesPrevious: z.boolean(),
  reference: z.object({ turnId: z.string().min(1).max(400), label: z.string().min(1).max(120) }).strict().nullable(),
  sourceRefs: z.array(z.string().min(1).max(900)).min(1).max(20)
}).strict();
export const conversationOutputSchema = z.object({ turns: z.array(conversationTurnSummarySchema).max(20) }).strict();
export type ConversationSummary = z.infer<typeof conversationTurnSummarySchema>;
export interface ConversationTurn extends ConversationSummary {
  occurredAt: string | null; previousTurnId: string | null; revision: number; unread: boolean;
  sequence: number; sourceFingerprint: string; ordinal: number;
}
export interface ConversationColumn {
  threadKey: string; title: string; sourceUpdatedAt: string | null; turns: ConversationTurn[];
  hasEarlier: boolean; hasStoredEarlier?: boolean; nextCursor: string | null; coverage: string[]; checkedAt: string | null;
  cursorBeforeTurnId?: string | null; orderingRevision?: number;
  knownTurns?: number; pendingTurns?: number;
}
export interface ConversationHistory {
  projectKey: string; enabled: boolean; order: 'sidebar' | 'recent'; threads: ConversationColumn[]; gaps: string[];
}
export type ProjectConversationHistory = ConversationHistory;
export interface ConversationRefreshResult { projectKey: string; job: SyncJob | null; gaps: string[] }
export interface ConversationEvidence {
  turnId: string; occurredAt: string | null; fingerprint: string; ordinal: number; previousTurnId: string | null;
  previousFingerprint?: string | null;
  evidence: Array<{ id: string; role: 'user' | 'assistant'; text: string; occurredAt: string | null }>;
  gaps: string[];
  recordedTurnNotice?: string;
}
export interface ConversationBatch {
  conversationKey: string; projectKey: string; threadKey: string; title: string;
  sourceUpdatedAt: string | null; checkedAt: string; fingerprint: string;
  turns: ConversationEvidence[]; context: ConversationTurn[];
  recapSource?: SourceThread;
  olderPage?: { cursor: string; nextCursor: string | null; beforeTurnId: string | null; turns: Array<{turnId:string;fingerprint:string}> };
}

/** A model's relation never overrides source order or crosses an intervening turn. */
export function groupConversationTurns(turns: ConversationTurn[]): ConversationTurn[][] {
  const groups: ConversationTurn[][] = [];
  for (const turn of [...turns].sort((a,b)=>a.ordinal-b.ordinal || a.turnId.localeCompare(b.turnId))) {
    const last = groups.at(-1)?.at(-1);
    if (last && turn.continuesPrevious && turn.previousTurnId === last.turnId && turn.ordinal === last.ordinal + 1) groups.at(-1)!.push(turn);
    else groups.push([turn]);
  }
  return groups;
}
