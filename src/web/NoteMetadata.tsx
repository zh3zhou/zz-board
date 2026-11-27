import { localCalendarDate } from '../shared/notePriority.js';
import type { CanvasNodeRecord } from '../shared/schema.js';

export function formatSavedTime(value: string): string {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间未知';
}

export function hoverSavedTime(value: string, now = new Date()): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  const day = localCalendarDate(date);
  const distance = (Date.parse(localCalendarDate(now)) - Date.parse(day)) / 86_400_000;
  const prefix = distance === 0 ? '今天' : distance === 1 ? '昨天' : day;
  return `${prefix} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function SavedTime({ value }: { value: string }) {
  return Number.isFinite(Date.parse(value))
    ? <time dateTime={value}>{formatSavedTime(value)}</time>
    : <span>时间未知</span>;
}

export function NoteMetadata({ note, pending = false }: { note: Pick<CanvasNodeRecord, 'createdAt' | 'updatedAt' | 'contentEditedAt'>; pending?: boolean }) {
  return <section className="note-metadata" aria-label="便签时间">
    <dl><div><dt>创建时间</dt><dd><SavedTime value={note.createdAt} /></dd></div>
      {note.contentEditedAt && <div><dt>最近内容修改</dt><dd><SavedTime value={note.contentEditedAt} /></dd></div>}
      <div><dt>最近节点变动</dt><dd><SavedTime value={note.updatedAt} /></dd></div></dl>
    {pending && <small>有本机内容待保存。</small>}
  </section>;
}
