import { describe, expect, it } from 'vitest';
import { calendarDateSchema, defaultNoteThresholds, noteScheduleSchema, priorityOnDate, type NoteSchedule } from '../../src/shared/notePriority.js';

const schedule: NoteSchedule = { dueDate: '2028-03-01', autoPromote: true, ...defaultNoteThresholds, completed: false };
describe('note priority at a local calendar date', () => {
  it('uses inclusive thresholds across a leap day and keeps overdue notes high', () => {
    const on = (date: string) => priorityOnDate({ noteSchedule: schedule }, date);
    expect(on('2028-02-22')).toEqual({ effectivePriority: null, prioritySource: null });
    expect(on('2028-02-23')).toEqual({ effectivePriority: 'p2', prioritySource: 'date' });
    expect(on('2028-02-29')).toEqual({ effectivePriority: 'p1', prioritySource: 'date' });
    expect(on('2028-03-14')).toEqual({ effectivePriority: 'p1', prioritySource: 'date' });
    expect(priorityOnDate({ noteSchedule: { ...schedule, attentionDays: 0, priorityDays: 0 } }, '2028-03-01').effectivePriority).toBe('p1');
  });

  it('takes the stronger source, keeps legacy raw levels compatible, and can record a date only', () => {
    expect(priorityOnDate({ manualPriority: 'p1', noteSchedule: schedule }, '2028-02-23')).toEqual({ effectivePriority: 'p1', prioritySource: 'manual' });
    expect(priorityOnDate({ manualPriority: 'p3', noteSchedule: schedule }, '2028-02-23')).toEqual({ effectivePriority: 'p2', prioritySource: 'both' });
    expect(priorityOnDate({ manualPriority: 'p2', noteSchedule: schedule }, '2028-03-01')).toEqual({ effectivePriority: 'p1', prioritySource: 'date' });
    for (const option of [{ completed: true }, { autoPromote: false }]) {
      expect(priorityOnDate({ manualPriority: 'p3', noteSchedule: { ...schedule, ...option } }, '2028-03-02')).toEqual({ effectivePriority: 'p2', prioritySource: 'manual' });
      expect(priorityOnDate({ noteSchedule: { ...schedule, ...option } }, '2028-03-02').effectivePriority).toBeNull();
    }
  });

  it('rejects nonexistent dates and reversed, fractional or negative thresholds', () => {
    expect(calendarDateSchema.safeParse('2026-02-29').success).toBe(false);
    expect(calendarDateSchema.safeParse('2028-02-29').success).toBe(true);
    for (const change of [{ priorityDays: 8 }, { priorityDays: .5 }, { priorityDays: -1 }])
      expect(noteScheduleSchema.safeParse({ ...schedule, ...change }).success).toBe(false);
  });
});
