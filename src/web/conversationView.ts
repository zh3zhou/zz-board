import type { ConversationTurn } from '../shared/conversationHistory.js';
export { groupConversationTurns as conversationGroups } from '../shared/conversationHistory.js';

export interface FloatingBounds { x: number; y: number; width: number; height: number }
export function floatingBounds(width: number, height: number, previous?: FloatingBounds): FloatingBounds {
  const margin = Math.min(24, Math.max(8, width * .03));
  const w = Math.max(1, Math.min(previous?.width ?? 1080, width - margin * 2));
  const h = Math.max(1, Math.min(previous?.height ?? height * .8, height - margin * 2));
  return { width: w, height: h, x: Math.max(margin, Math.min(previous?.x ?? (width - w) / 2, width - margin - w)), y: Math.max(margin, Math.min(previous?.y ?? (height - h) / 2, height - margin - h)) };
}
export function mergeConversationTurns(old: ConversationTurn[], fresh: ConversationTurn[]): ConversationTurn[] {
  const map = new Map(old.map(turn => [turn.turnId, turn]));
  for (const turn of fresh) {
    const previous = map.get(turn.turnId);
    if (!previous || turn.revision >= previous.revision) map.set(turn.turnId, turn);
  }
  return [...map.values()].sort((a, b) => a.ordinal - b.ordinal || a.turnId.localeCompare(b.turnId));
}
