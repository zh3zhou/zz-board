import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { CanvasNodeRecord } from '../shared/schema.js';
import type { NoteDocument } from '../shared/noteDocument.js';
import { NoteScheduleForm, type SaveNoteArrangement } from './NoteScheduleForm.js';
import { NoteEditor } from './NoteEditor.js';
import { NoteDocumentView, NoteImageView } from './NoteDocumentView.js';
import { finishCanvasEditors } from './editorNavigation.js';
import type { NoteEdit } from './noteAutosave.js';
import type { PriorityIcons } from '../shared/priorityIcons.js';
import { displayedPriority, manualPriorityLabel } from './manualPriority.js';
import { NoteActionIcon, PriorityIcon } from './PriorityIcon.js';
import './focusedNote.css';

interface FocusedNoteProps {
  note: CanvasNodeRecord;
  anchor: HTMLElement;
  skinStyle?: CSSProperties;
  priorityIcons?: PriorityIcons;
  dataStoreId?: string;
  online: boolean;
  readOnly: boolean;
  covered?: boolean;
  priorityDate?: string;
  onSaveArrangement?: SaveNoteArrangement;
  edit?: NoteEdit;
  details(close: () => void): ReactNode;
  onChange(body: string, document: NoteDocument): void;
  onComposition(active: boolean): void;
  onSave(): void;
  onClose(): Promise<void>;
}

export function FocusedNote({ note, anchor, skinStyle, priorityIcons, dataStoreId, online, readOnly, covered, edit, details, priorityDate, onSaveArrangement, onChange, onComposition, onSave, onClose }: FocusedNoteProps) {
  const [showDetails, setShowDetails] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const scheduleButton = useRef<HTMLButtonElement>(null);
  const [notice, setNotice] = useState('');
  const [source] = useState(() => anchor.getBoundingClientRect());
  const dialog = useRef<HTMLDivElement>(null), paper = useRef<HTMLElement>(null);
  const reading = useRef<HTMLDivElement>(null), sidebar = useRef<HTMLDivElement>(null);
  const detailButton = useRef<HTMLButtonElement>(null);
  const closing = useRef(false), composing = useRef(false);
  const sourceX = source.left + source.width / 2, sourceY = source.top + source.height / 2;

  useLayoutEffect(() => {
    const element = paper.current;
    const dest = element?.getBoundingClientRect();
    const animation = element && dest?.width && dest.height && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? element.animate?.([
          { transform: `translate(${sourceX - dest.left - dest.width / 2}px, ${sourceY - dest.top - dest.height / 2}px) scale(${Math.min(1, source.width / dest.width, source.height / dest.height)})`, opacity: .6 },
          { transform: 'none', opacity: 1 }
        ], { duration: 180, easing: 'cubic-bezier(.2,.75,.2,1)' }) : null;
    return () => {
      if (animation) animation.cancel();
      if (anchor.isConnected && (document.activeElement === document.body || dialog.current?.contains(document.activeElement))) anchor.focus({ preventScroll: true });
    };
  }, [anchor, source, sourceX, sourceY]);
  useLayoutEffect(() => {
    if (covered) return;
    const region = reading.current;
    const target = region?.querySelector<HTMLElement>('[contenteditable="true"]') ?? region;
    if (target && document.activeElement !== target) target.focus({ preventScroll: true });
  }, [covered]);
  useLayoutEffect(() => {
    if (showDetails) sidebar.current?.querySelector<HTMLElement>('[aria-current="true"]')?.focus({ preventScroll: true });
  }, [showDetails]);

  function closeSchedule() { setShowSchedule(false); scheduleButton.current?.focus({ preventScroll: true }); }
  async function close() {
    if (closing.current || scheduleBusy) return;
    if (showSchedule) { closeSchedule(); return; }
    closing.current = true;
    try {
      if (await finishCanvasEditors()) await onClose();
    } catch { setNotice('恢复草稿尚未保存，请先保留这张便签。'); }
    finally { closing.current = false; }
  }
  function closeDetails() { setShowDetails(false); detailButton.current?.focus({ preventScroll: true }); }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (scheduleBusy) return;
      if (showSchedule) closeSchedule(); else if (showDetails) closeDetails(); else void close();
    } else if (event.key === 'Tab') {
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [contenteditable="true"]')).filter(item => item.getClientRects().length);
      const first = items[0], last = items.at(-1);
      const active = document.activeElement;
      const regionFocused = active === dialog.current || active === reading.current;
      if (event.shiftKey && (active === first || regionFocused)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (active === last || regionFocused)) { event.preventDefault(); first?.focus(); }
    }
  }
  const image = note.notePresentation === 'image' && note.noteDocument?.content.find(item => item.type === 'image');
  const priority = displayedPriority(note, priorityDate);
  const status = notice || edit?.error || (readOnly ? '归档页 · 只读' : !online ? '离线 · 文字保存在本机' : '');
  return <div ref={dialog} className="focused-note" role="dialog" aria-modal="true" aria-label="便签读写" tabIndex={-1} inert={covered} onKeyDownCapture={keyDown} onPaste={event => event.stopPropagation()}>
    <div className="focused-note-backdrop" aria-hidden="true" onMouseDown={event => event.preventDefault()} onClick={() => void close()} />
    <div className="focused-note-space" style={{ '--note-anchor-x': `${sourceX * .32}px`, '--note-anchor-y': `${sourceY * .32}px` } as CSSProperties}>
      <div className="focused-note-position">
        <div className="focused-note-tools" role="group" aria-label="便签操作">
          {onSaveArrangement && <button type="button" ref={scheduleButton} aria-label={`安排 · ${manualPriorityLabel(priority) || '未设优先级'}`} title="安排" aria-expanded={showSchedule} disabled={readOnly || !online || scheduleBusy || Boolean(edit?.clientRequestId) || note.id.startsWith('offline-note:')}
            onClick={async () => {
              if (showSchedule) { closeSchedule(); return; }
              if (!composing.current && await finishCanvasEditors()) { setShowDetails(false); setShowSchedule(true); }
            }}><PriorityIcon level={priority} icons={priorityIcons} /></button>}
          <button type="button" ref={detailButton} aria-label="详情" title="详情" disabled={showSchedule} aria-expanded={showDetails} onClick={() => setShowDetails(open => !open)}><NoteActionIcon kind="details" /></button>
          <button type="button" aria-label="收起便签" title="收起便签（Esc）" onMouseDown={event => event.preventDefault()} onClick={() => void close()}><NoteActionIcon kind="close" /></button>
        </div>
        <section ref={paper} className="focused-note-paper" style={skinStyle}>
        {note.title && <h2>{note.title}</h2>}
        {showSchedule && priorityDate && onSaveArrangement && <NoteScheduleForm note={note} today={priorityDate} disabled={readOnly || !online}
          onSave={onSaveArrangement} onClose={closeSchedule} onBusy={setScheduleBusy} />}
        <div ref={reading} hidden={showSchedule} inert={showSchedule} className="focused-note-body" role="region" aria-label="便签正文" tabIndex={-1}>
          {image ? <NoteImageView id={image.assetId} detail /> : readOnly || note.notePresentation === 'image'
            ? <NoteDocumentView body={note.body} document={note.noteDocument} />
            : <NoteEditor noteId={note.id} body={note.body} document={note.noteDocument} dataStoreId={dataStoreId} online={online} autoFocus={!covered && !showDetails && !showSchedule} onChange={(body, document) => { setNotice(''); onChange(body, document); }}
                onComposition={active => { composing.current = active; onComposition(active); }} onFinish={onSave} onNotice={setNotice} />}
        </div>
        {status && <div className="focused-note-status" role="status">{status}</div>}
      </section></div>
    </div>
    {showDetails && <div ref={sidebar} className="focused-note-details">{details(closeDetails)}</div>}
  </div>;
}
