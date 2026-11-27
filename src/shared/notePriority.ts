import { z } from 'zod';
import type { ManualPriority } from './schema.js';

export const calendarDateSchema = z.iso.date();
export const noteScheduleSchema = z.object({
  dueDate: calendarDateSchema,
  autoPromote: z.boolean(),
  attentionDays: z.number().int().nonnegative(),
  priorityDays: z.number().int().nonnegative(),
  completed: z.boolean()
}).strict().refine(value => value.attentionDays >= value.priorityDays, {
  path: ['attentionDays'], message: '关注的提前天数须大于或等于优先的提前天数。'
});
export type NoteSchedule = z.infer<typeof noteScheduleSchema>;
export type EffectivePriority = 'p1' | 'p2' | null;
export type PrioritySource = 'manual' | 'date' | 'both' | null;
export const defaultNoteThresholds = { attentionDays: 7, priorityDays: 1 };

export function localCalendarDate(now = new Date()): string {
  return [String(now.getFullYear()).padStart(4, '0'), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
}

export function manualLevel(priority?: ManualPriority | null): EffectivePriority {
  return priority === 'p1' ? 'p1' : priority ? 'p2' : null;
}

export function priorityOnDate(record: { manualPriority?: ManualPriority | null; noteSchedule?: NoteSchedule | null }, today: string):
  { effectivePriority: EffectivePriority; prioritySource: PrioritySource } {
  const manual = manualLevel(record.manualPriority);
  const schedule = record.noteSchedule;
  let date: EffectivePriority = null;
  if (schedule?.autoPromote && !schedule.completed) {
    // Both operands are calendar dates, never elapsed local hours across a DST boundary.
    const days = (Date.parse(schedule.dueDate) - Date.parse(today)) / 86_400_000;
    date = days <= schedule.priorityDays ? 'p1' : days <= schedule.attentionDays ? 'p2' : null;
  }
  if (manual && manual === date) return { effectivePriority: manual, prioritySource: 'both' };
  if (manual && (!date || manual === 'p1')) return { effectivePriority: manual, prioritySource: 'manual' };
  return { effectivePriority: date, prioritySource: date ? 'date' : null };
}
