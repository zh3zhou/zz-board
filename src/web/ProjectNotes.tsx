import { useMemo, useState } from 'react';
import { noteChecklist, projectNoteScope } from '../../skills/read-zz-board-project/scripts/note-view.mjs';
import type { BoardState, CanvasNodeRecord } from '../shared/schema.js';
import type { NoteContent } from '../shared/noteDocument.js';
import { pageId } from '../shared/pages.js';
import { NoteDocumentView } from './NoteDocumentView.js';
import { formatSavedTime } from './NoteMetadata.js';
import { shortRecordDate } from './projectContextReading.js';
import { manualPriorityLabel } from './manualPriority.js';
import { priorityOnDate } from '../shared/notePriority.js';
import './projectNotes.css';

export function ProjectNotes({board, projectKey, priorityDate, onLocate, onShowAll}: {
  board: BoardState; projectKey: string; priorityDate: string; onLocate(note: CanvasNodeRecord): void;
  onShowAll?: () => void;
}) {
  const [opened, setOpened] = useState<string | null>(null);
  const {items, relation} = useMemo(() => {
    const scope = projectNoteScope(board, projectKey);
    const saved = (note: CanvasNodeRecord) => Date.parse(note.contentEditedAt ?? note.createdAt);
    const items = scope.visibleNotes.sort((a,b) => saved(b) - saved(a) || a.id.localeCompare(b.id));
    return {items, relation:scope.relation};
  }, [board,projectKey]);
  if (onShowAll && !items.length) return null;
  return <section className="project-notes" aria-label="项目便签">
    {onShowAll && <h3>关联便签</h3>}
    {items.length === 0 && <p>这个项目还没有已连接的活动便签。</p>}
    {(onShowAll ? items.slice(0,2) : items).map(note => {
      const open = opened === note.id, priority = priorityOnDate(note, priorityDate).effectivePriority;
      const firstLine = note.body.trim().split(/\r?\n/, 1)[0];
      const name = note.title.trim() || firstLine || (note.noteDocument?.content.some(part => part.type === 'image') ? '图片便签' : '空白便签');
      const excerpt = onShowAll && note.body.trim().split(/\r?\n/).filter(line => line.trim() && line.trim() !== name).slice(0, 2).join('\n');
      const page = board.pages?.find(p => p.id === pageId(note));
      return <article key={note.id}><button className="project-note-title" type="button" aria-expanded={onShowAll ? undefined : open}
        onClick={() => onShowAll ? onLocate(note) : setOpened(open ? null : note.id)}>{name}</button>
        {excerpt && <p className="project-note-excerpt">{excerpt}</p>}
        <small>{!onShowAll && <>{page?.name ?? 'page 1'} · {relation(note.id) === 'shared-direct' ? '多个项目共享' : relation(note.id) === 'direct' ? '直接关联' : '经便签关联'} · </>}
          {note.noteSource && '来自对话的便签 · '}{priority && manualPriorityLabel(priority) + ' · '}{note.contentEditedAt ? '编辑于' : '创建于'} {onShowAll ? shortRecordDate(note.contentEditedAt ?? note.createdAt) : formatSavedTime(note.contentEditedAt ?? note.createdAt)}</small>
        {!onShowAll && open && <><NoteDocumentView body={note.body} document={note.noteDocument} />
          <button type="button" onClick={() => onLocate(note)}>在画布中定位</button></>}
      </article>;
    })}
    {onShowAll && items.length > 2 && <button type="button" onClick={onShowAll}>查看全部 {items.length} 张便签</button>}
  </section>;
}

/** Only one ASCII marker changes. Keep every intervening image and text-block boundary in place. */
export function setChecklistItem(note: NoteContent, lineNumber: number, completed: boolean): NoteContent | null {
  const item = noteChecklist(note.body).find(entry => entry.line === lineNumber);
  if (!item || item.completed === completed) return null;
  const lines = note.body.split('\n');
  const line = lines[lineNumber - 1]!;
  const start = lines.slice(0,lineNumber - 1).reduce((sum,text) => sum + text.length + 1, 0);
  const at = start + line.indexOf('[') + 1, marker = completed ? 'x' : ' ';
  const replace = (text: string, index: number) => text.slice(0,index) + marker + text.slice(index + 1);
  const body = replace(note.body, at);
  if (!note.noteDocument) return {body, noteDocument:null};
  let offset = 0;
  const content = note.noteDocument.content.map(block => {
    if (block.type === 'image') return block;
    const index = at - offset; offset += block.text.length;
    return index >= 0 && index < block.text.length ? {...block,text:replace(block.text,index)} : block;
  });
  return {body, noteDocument:{version:1,content}};
}

export function NoteChecklist({note, disabled, onChange}: {
  note: NoteContent; disabled: boolean; onChange(value: NoteContent): void;
}) {
  const items = noteChecklist(note.body);
  if (!items.length) return null;
  return <fieldset className="note-checklist" disabled={disabled}><legend>待办</legend>
    {items.map(item => <label key={item.line}><input type="checkbox" checked={item.completed} onChange={event => {
      const value = setChecklistItem(note, item.line, event.target.checked);
      if (value) onChange(value);
    }} />{item.text}</label>)}
  </fieldset>;
}
