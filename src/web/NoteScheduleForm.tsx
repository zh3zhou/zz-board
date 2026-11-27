import { useState, type FormEvent } from 'react';
import type { CanvasNodeRecord, ManualPriority } from '../shared/schema.js';
import { defaultNoteThresholds, manualLevel, noteScheduleSchema, priorityOnDate, type NoteSchedule } from '../shared/notePriority.js';
import { manualPriorityLabel } from './manualPriority.js';

export type SaveNoteArrangement = (original: CanvasNodeRecord, manual: ManualPriority | null, schedule: NoteSchedule | null) => Promise<void>;

export function NoteScheduleForm({ note, today, disabled, onSave, onClose, onBusy }: {
  note: CanvasNodeRecord; today: string; disabled: boolean; onSave: SaveNoteArrangement; onClose(): void; onBusy(value: boolean): void;
}) {
  const [original] = useState(note);
  const schedule = original.noteSchedule;
  const [manual, setManual] = useState(manualLevel(original.manualPriority));
  const [date, setDate] = useState(schedule?.dueDate ?? '');
  const [auto, setAuto] = useState(schedule?.autoPromote ?? true);
  const [attention, setAttention] = useState(String(schedule?.attentionDays ?? defaultNoteThresholds.attentionDays));
  const [high, setHigh] = useState(String(schedule?.priorityDays ?? defaultNoteThresholds.priorityDays));
  const [completed, setCompleted] = useState(schedule?.completed ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const proposal = { dueDate: date, autoPromote: auto, attentionDays: attention === '' ? NaN : Number(attention),
    priorityDays: high === '' ? NaN : Number(high), completed };
  const thresholdsValid = Number.isSafeInteger(proposal.attentionDays) && Number.isSafeInteger(proposal.priorityDays) &&
    proposal.priorityDays >= 0 && proposal.attentionDays >= proposal.priorityDays;
  const parsed = noteScheduleSchema.safeParse(!auto && !thresholdsValid ? { ...proposal, ...defaultNoteThresholds } : proposal);
  const valid = !date || parsed.success;
  const priority = valid ? priorityOnDate({ manualPriority: manual, noteSchedule: date && parsed.success ? parsed.data : null }, today) : null;
  const source = priority?.prioritySource;
  function changeDate(value: string) { setDate(value); setCompleted(false); setError(''); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || saving || !valid) return;
    setError(''); setSaving(true); onBusy(true);
    try {
      // Changing only the schedule preserves a legacy p3 value in storage.
      const raw = manual === manualLevel(original.manualPriority) ? original.manualPriority ?? null : manual;
      await onSave(original, raw, date && parsed.success ? parsed.data : null);
      onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '安排保存失败。'); }
    finally { setSaving(false); onBusy(false); }
  }
  return <form className="note-schedule" aria-label="便签安排" onSubmit={submit}>
    <fieldset disabled={disabled || saving}>
      <label>手动标记<select autoFocus value={manual ?? ''} onChange={event => setManual(event.target.value === 'p1' ? 'p1' : event.target.value === 'p2' ? 'p2' : null)}>
        <option value="">无</option><option value="p2">关注</option><option value="p1">优先</option></select></label>
      <label>预期完成日期<input type="date" value={date} onChange={event => changeDate(event.target.value)} /></label>
      {date && <>
        <label><input type="checkbox" checked={auto} onChange={event => setAuto(event.target.checked)} />按日期自动提升</label>
        {auto && <div className="note-schedule-days">
          <label>提前多少天关注<input type="number" min="0" step="1" required value={attention} onChange={event => setAttention(event.target.value)} /></label>
          <label>提前多少天优先<input type="number" min="0" step="1" required value={high} onChange={event => setHigh(event.target.value)} /></label>
        </div>}
        <label><input type="checkbox" checked={completed} onChange={event => setCompleted(event.target.checked)} />本次期限已完成</label>
        <button type="button" onClick={() => changeDate('')}>清除日期</button>
      </>}
      {priority?.effectivePriority && <p>当前为{manualPriorityLabel(priority.effectivePriority)}（{source === 'both' ? '手动和日期' : source === 'date' ? '日期' : '手动'}）</p>}
      {!valid && <p role="alert">请填写有效日期和非负整数天数，关注须至少和优先一样早。</p>}
      {error && <p role="alert">{error}</p>}
      <div className="note-schedule-actions"><button type="submit" disabled={!valid}>保存安排</button><button type="button" onClick={onClose}>取消</button></div>
    </fieldset>
  </form>;
}
