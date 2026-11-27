import type { ConversationColumn } from '../shared/conversationHistory.js';
import { mergeConversationTurns } from './conversationView.js';

type EarlierPage = { status: 'loaded'; page: ConversationColumn } | { status: 'empty' | 'stale' };
const order = (column: ConversationColumn) => column.orderingRevision ?? 0;
const sameSourcePage = (a: ConversationColumn, b: ConversationColumn) => order(a) === order(b)
  && a.nextCursor === b.nextCursor && a.hasEarlier === b.hasEarlier;

/** Stale is deliberately distinct from empty: it must never trigger a model job. */
export async function readEarlierConversationPage(
  current: () => ConversationColumn | undefined,
  read: (beforeTurnId: string) => Promise<ConversationColumn>,
  active: () => boolean,
): Promise<EarlierPage> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!active()) return { status: 'stale' };
    const before = current();
    if (!before?.turns.length) return { status: 'empty' };
    const beforeId = before.turns[0]!.turnId;
    const page = await read(beforeId);
    const now = current();
    if (!active() || !now) return { status: 'stale' };
    if (page.threadKey !== now.threadKey) throw new Error('Conversation page source mismatch.');
    if (!sameSourcePage(page, now) || now.turns[0]?.turnId !== beforeId) continue;
    return page.turns.length ? { status: 'loaded', page } : { status: 'empty' };
  }
  return { status: 'stale' };
}

/** Repeat the revision check at React's state-commit boundary. */
export function mergeEarlierConversationPage(current: ConversationColumn, page: ConversationColumn): ConversationColumn {
  if (current.threadKey !== page.threadKey || !sameSourcePage(current, page)) return current;
  return { ...current, hasEarlier: page.hasEarlier, hasStoredEarlier: page.hasStoredEarlier,
    nextCursor: page.nextCursor, turns: mergeConversationTurns(page.turns, current.turns) };
}
