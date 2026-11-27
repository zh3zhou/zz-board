import { displayedPriority } from './manualPriority.js';
import { localCalendarDate } from '../shared/notePriority.js';
import type { BubbleData } from './TaskBubble.js';
import { projectSignals } from './projectCanvas.js';
import { recordedWorkState } from '../shared/projectProgress.js';

export type CanvasLens = 'all' | 'priority' | 'uncertain' | 'notes';

/** View filtering only. A hidden record is never archived or deleted. */
export function matchesCanvasView(data: Pick<BubbleData, 'record' | 'thread' | 'project' | 'isDraft'>, projectKey: string, lens: CanvasLens, now = new Date()): boolean {
  if (data.isDraft) return true;
  // Local notes have no Codex project assignment. These two views are global.
  if (lens === 'notes') return data.record.kind === 'note';
  if (data.record.kind === 'note' && lens === 'priority') return Boolean(displayedPriority(data.record, localCalendarDate(now)));
  if (projectKey !== 'all' && (data.project?.project.projectKey || data.thread?.projectKey) !== projectKey) return false;
  if (lens === 'priority') return Boolean(displayedPriority(data.record, localCalendarDate(now)));
  if (data.record.kind === 'note') return lens === 'all';
  if (lens === 'all') return true;
  const state = data.project && projectSignals(data.project, now);
  const thread = data.thread;
  return state ? state.confidence === 'low' || state.workState === 'insufficient_evidence' :
    Boolean(thread && ((thread.recap?.summary.confidence ?? thread.confidence) === 'low' || recordedWorkState(thread) === 'insufficient_evidence'));
}
