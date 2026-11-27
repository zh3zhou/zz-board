import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Handle, NodeResizeControl, Position, type NodeProps } from '@xyflow/react';
import type { BoardThread, CanvasNodeRecord } from '../shared/schema.js';
import { noteDisplayText, taskDisplayTitle } from './bubblePresentation.js';
import { threadSourceTime } from '../shared/projectProgress.js';
import { bubbleMotion } from './motion.js';
import type { ProjectBubbleContext } from './projectCanvas.js';
import { displayedPriority, manualPriorityLabel } from './manualPriority.js';
import type { SkinShapeKind } from '../shared/skin.js';
import { copyCurrentNoteText, copyNoteImage } from './noteClipboard.js';
import './noteTools.css';
import { NoteEditor } from './NoteEditor.js';
import { NoteScrollRail } from './NoteScrollRail.js';
import { NoteDocumentView, NoteImageView } from './NoteDocumentView.js';
import type { NoteDocument } from '../shared/noteDocument.js';
import type { PriorityIcons } from '../shared/priorityIcons.js';
import { NoteActionIcon, PriorityIcon } from './PriorityIcon.js';
import { copyNoteCard } from './noteTransfer.js';

export interface BubbleData extends Record<string, unknown> {
  record: CanvasNodeRecord;
  thread?: BoardThread;
  project?: ProjectBubbleContext;
  annotationCount: number;
  selected: boolean;
  canResize: boolean;
  isDraft?: boolean;
  editing?: boolean;
  onNoteEdit?: (id: string, body: string, document?: NoteDocument | null) => void;
  online?: boolean;
  exportMode?: boolean;
  imageDetail?: boolean;
  transforming?: boolean;
  onNoteBlur?: (id: string, finalBody?: string) => void;
  onNoteComposition?: (id: string, active: boolean) => void;
  onFocusNote?: (id: string, anchor: HTMLElement) => void;
  onNotePanel?: (id: string, panel: 'schedule' | 'details') => void;
  onArchiveNote?: (id: string) => void;
  singleSelection?: boolean;
  priorityIcons?: PriorityIcons;
  dataStoreId?: string;
  unsavedDraft?: boolean;
  onFold?: () => void;
  readOnly?: boolean;
  onFoldAll?: (folded: boolean) => void;
  foldedCount?: number;
  foldAnimation?: { frames: Keyframe[]; opening: boolean };
  onNotice?: (message: string) => void;
  onDraftCommit?: (id: string, body: string) => Promise<boolean>;
  onResizeEnd: (id: string, width: number, height: number, sourceEvent?: unknown) => void;
  onAspectLockChange?: (id: string, locked: boolean) => void;
  aspectLockedDefault?: boolean;
  shape?: SkinShapeKind;
  cornerRadii?: readonly number[];
  altPressed?: boolean;
  skinStyle?: CSSProperties & Record<`--${string}`, string | number>;
}

type MotionStyle = CSSProperties & Record<`--${string}`, string | number>;

export function TaskBubble({ id, data }: Pick<NodeProps, 'id' | 'data'>) {
  const bubble = data as BubbleData;
  const { record, thread, project } = bubble;
  const contentScale = record.contentScale ?? 1;
  const motion = bubbleMotion(id, record.kind);
  const [draftBody, setDraftBody] = useState(record.body);
  const draftBodyRef = useRef(record.body);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const scrollViewport = useRef<HTMLDivElement>(null);
  const viewportId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const firstClick = useRef<{ time: number; x: number; y: number } | null>(null);
  const editing = bubble.editing ?? bubble.isDraft;
  const scrollable = record.kind === 'note' && record.notePresentation !== 'image' && !bubble.exportMode && (bubble.singleSelection || editing);
  const body = bubble.onNoteEdit ? record.body : draftBody;
  const priority = displayedPriority(record);
  const priorityLabel = manualPriorityLabel(priority);
  const displayTitle = taskDisplayTitle(thread, record, project?.project);
  const aspectLocked = resolvedAspectLock(record, bubble.aspectLockedDefault);
  const status = project ? `${project.threads.length} 条对话 · 查看近况` : statusLabel(thread, record);
  const classes = [
    'bubble', record.kind === 'note' ? 'bubble-note' : 'bubble-task',
    record.notePresentation === 'image' ? 'bubble-image' : '',
    record.id.startsWith('offline-note:') ? 'is-queued' : '',
    editing ? 'is-editing' : '',
    bubble.transforming ? 'is-transforming' : '',
    bubble.foldAnimation ? bubble.foldAnimation.opening ? 'is-unfolding' : 'is-folding' : '',
    bubble.selected ? 'is-selected' : ''
  ].filter(Boolean).join(' ');
  const style: MotionStyle = {
    ...bubble.skinStyle,
    '--content-scale': contentScale,
    '--drift-duration': `calc(var(--skin-motion-duration, 16000ms) * ${motion.durationSeconds / 12})`,
    '--drift-delay': `calc(var(--skin-motion-duration, 16000ms) * ${motion.delaySeconds / motion.durationSeconds})`,
    '--drift-x': `calc(var(--skin-motion-amplitude, 6px) * ${motion.xPixels / 10})`,
    '--drift-y': `calc(var(--skin-motion-amplitude, 6px) * ${motion.yPixels / 10})`,
    '--shadow-duration': `calc(var(--skin-motion-duration, 16000ms) * ${motion.shadowSeconds / 10})`
  };

  const animationKey = bubble.foldAnimation ? JSON.stringify(bubble.foldAnimation) : '';
  useLayoutEffect(() => {
    if (!bubble.foldAnimation || !rootRef.current) return;
    const animation = rootRef.current.animate(bubble.foldAnimation.frames, {
      duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 300,
      easing: 'cubic-bezier(.4,0,.2,1)', fill: 'both', direction: bubble.foldAnimation.opening ? 'reverse' : 'normal'
    });
    return () => animation.cancel();
  }, [animationKey]);

  async function commitDraft(finalBody?: string) {
    if (bubble.onNoteBlur) { bubble.onNoteBlur(id, finalBody); return; }
    if (bubble.isDraft && bubble.onDraftCommit) await bubble.onDraftCommit(id, draftBodyRef.current);
  }

  async function copy(kind: 'text' | 'image') {
    try {
      if (kind === 'text') await copyCurrentNoteText(record);
      else if (surfaceRef.current) await copyNoteImage(surfaceRef.current, record);
      else throw new Error('便签尚未显示。');
      if (kind === 'text') bubble.onNotice?.('已复制便签原文。'); // Image receipt reports both outcomes independently.
    } catch (error) { bubble.onNotice?.(`复制失败：${error instanceof Error ? error.message : String(error)}`); }
  }

  function focusNote() {
    const anchor = rootRef.current?.closest<HTMLElement>('.react-flow__node');
    if (anchor) bubble.onFocusNote?.(id, anchor);
  }

  async function copyCard() {
    try { await copyNoteCard(record, bubble.dataStoreId); bubble.onNotice?.('已复制整张便签，在画布空白处粘贴即可。'); }
    catch (error) { bubble.onNotice?.(error instanceof Error ? error.message : '复制便签失败。'); }
  }

  return (
    <div ref={rootRef} className={classes} data-priority={priority || 'unset'} data-shape={bubble.shape || (record.kind === 'task' ? 'circle' : 'roundedRect')} style={style} role="group"
      aria-label={[record.kind === 'task' ? `${project ? '项目' : '对话'}：${displayTitle}` : `便签：${noteDisplayText(record) || '空白'}`, priorityLabel, record.kind === 'task' ? status : ''].filter(Boolean).join('，')}>
      {!bubble.exportMode && priority && <span className="bubble-priority-badge" data-export-exclude aria-label={`优先级 ${priorityLabel}`}>{record.kind === 'note' ? <PriorityIcon icons={bubble.priorityIcons} level={priority} /> : priorityLabel}</span>}
      {bubble.canResize && bubble.selected && !bubble.isDraft && <><NodeResizeControl
        position="bottom-right" className="bubble-resize-control nodrag"
        keepAspectRatio={resizeKeepsAspect(record, bubble.aspectLockedDefault, Boolean(bubble.altPressed))}
        minWidth={96 * contentScale} minHeight={72 * contentScale} maxWidth={520 * contentScale} maxHeight={520 * contentScale}
        onResizeEnd={(event, params) => bubble.onResizeEnd(id, params.width, params.height, event.sourceEvent)}
      ><span aria-hidden="true">⌟</span></NodeResizeControl>
        <button className={`bubble-aspect-lock nodrag nopan${aspectLocked ? ' is-locked' : ''}`} type="button"
          aria-pressed={aspectLocked} aria-label={aspectLocked ? '解除比例锁' : '锁定比例'} title={aspectLocked ? '比例已锁定；拖动时按 Alt 临时解除' : '锁定当前比例'}
          onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); bubble.onAspectLockChange?.(id, !aspectLocked); }}>
          <span aria-hidden="true">{aspectLocked ? '◆' : '◇'}</span>
        </button></>}
      {!bubble.exportMode && <><Handle type="target" position={Position.Left} className="bubble-handle" />
      <Handle type="source" position={Position.Right} className="bubble-handle" /></>}
      {record.kind === 'task' && bubble.onFoldAll && !bubble.exportMode && <div className="project-fold-tools nodrag nopan" data-export-exclude onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => event.stopPropagation()}>
        <button disabled={!bubble.online || bubble.readOnly} onClick={() => bubble.onFoldAll?.(true)}>全部折叠</button>
        <button disabled={!bubble.online || bubble.readOnly || !bubble.foldedCount} onClick={() => bubble.onFoldAll?.(false)}>展开全部</button>
      </div>}
      {record.kind === 'note' && !bubble.exportMode && (bubble.singleSelection || !bubble.readOnly) && <div className="note-tools nodrag nopan" role="group" aria-label="便签操作" data-export-exclude onPointerDown={(event) => { event.stopPropagation(); event.preventDefault(); }} onClick={(event) => event.stopPropagation()}>
        {bubble.singleSelection && <div className="note-tool-row">
          <button type="button" aria-label={`安排 · ${priorityLabel || '未设优先级'}`} title={`安排 · ${priorityLabel || '未设优先级'}`} disabled={!bubble.online || bubble.readOnly || bubble.unsavedDraft}
            onClick={() => bubble.onNotePanel?.(id, 'schedule')}><PriorityIcon level={priority} icons={bubble.priorityIcons} /></button>
          <button type="button" aria-label="便签详情" title="详情" onClick={() => bubble.onNotePanel?.(id, 'details')}><NoteActionIcon kind="details" /></button>
          <button type="button" aria-label="复制整张便签" title="复制整张便签" onClick={() => void copyCard()}><NoteActionIcon kind="copy" /></button>
          <button type="button" aria-label="专注读写" title="专注读写（双击便签）" onClick={focusNote}><NoteActionIcon kind="focus" /></button>
        </div>}
        <div className="note-tool-row">
          {record.notePresentation !== 'image' && <button type="button" aria-label="复制原文" title="复制原文" onClick={() => void copy('text')}><NoteIcon kind="copy" /></button>}
          {bubble.onFold && !bubble.readOnly && <button type="button" aria-label="收进上游" title="折叠到相连的上游气泡" disabled={!bubble.online} onClick={bubble.onFold}><NoteIcon kind="fold" /></button>}
          <button type="button" aria-label="保存并复制便签图片" title="保存并复制完整便签图片" onClick={() => void copy('image')}><NoteIcon kind="image" /></button>
          {!bubble.readOnly && <button type="button" className="note-archive-action" aria-label="归档便签" title="移入便签归档，可恢复" disabled={!bubble.online || bubble.unsavedDraft}
            onClick={() => bubble.onArchiveNote?.(id)}>归档</button>}
        </div>
      </div>}
      <div className="bubble-scale"><div className="bubble-drift">
        <div className="bubble-surface" ref={surfaceRef} onClickCapture={event => {
          if (record.kind !== 'note' || record.notePresentation === 'image' || event.shiftKey || event.button !== 0 || (event.target as Element).closest('button,img')) return;
          // Mounting the inline editor changes the second click's target. Chromium may restart its click count.
          const first = firstClick.current;
          if (editing && first && event.detail === 1 && event.timeStamp - first.time < 440 && Math.hypot(event.clientX - first.x, event.clientY - first.y) < 5) {
            firstClick.current = null; event.stopPropagation(); focusNote();
          } else firstClick.current = editing ? null : { time: event.timeStamp, x: event.clientX, y: event.clientY };
        }} onDoubleClick={event => {
          if (record.kind !== 'note' || record.notePresentation === 'image' || (event.target as Element).closest('button,img')) return;
          event.stopPropagation(); firstClick.current = null; focusNote();
        }}>
          {record.kind === 'task'
            ? <span className="bubble-title">{displayTitle}</span>
            : record.notePresentation === 'image' && record.noteDocument?.content[0]?.type === 'image'
              ? <NoteImageView id={record.noteDocument.content[0].assetId} original={bubble.exportMode} detail={bubble.imageDetail} />
              : <div id={viewportId} ref={scrollViewport} className={`note-scroll-viewport${scrollable ? ' is-scrollable nowheel' : ''}`}>
                <div className="note-scroll-content">{editing && !bubble.exportMode
                  ? <NoteEditor noteId={id} body={body} document={record.noteDocument} online={bubble.online ?? false} autoFocus initialPoint={firstClick.current ?? undefined} dataStoreId={bubble.dataStoreId} label="便签内容"
                    onChange={(text, document) => { draftBodyRef.current = text; setDraftBody(text); bubble.onNoteEdit?.(id, text, document); }}
                    onComposition={active => bubble.onNoteComposition?.(id, active)} onFinish={() => void commitDraft()} onNotice={bubble.onNotice} />
                  : <NoteDocumentView body={noteDisplayText(record)} document={record.noteDocument} original={bubble.exportMode} />}</div>
              </div>}
        </div>
        {scrollable && <NoteScrollRail viewport={scrollViewport} viewportId={viewportId} />}
      </div></div>
    </div>
  );
}

function NoteIcon({ kind }: { kind: 'copy' | 'image' | 'fold' }) {
  return <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'copy' ? <><rect x="6" y="6" width="10" height="11" rx="2" /><path d="M12 6V3H3v10h3" /></> : kind === 'image' ? <><rect x="2.5" y="3" width="15" height="14" rx="2" /><circle cx="7" cy="7" r="1.3" /><path d="m3 14 4-4 3 3 3-5 4 6" /></> : <><path d="M3 7v9h14V7M2 4h16v3H2zM7 11l3 3 3-3M10 9v5" /></>}
  </svg>;
}

export function resolvedAspectLock(record: Pick<CanvasNodeRecord, 'kind' | 'aspectLocked'>, skinDefault: boolean | undefined): boolean {
  return record.aspectLocked ?? skinDefault ?? record.kind === 'task';
}

export function resizeKeepsAspect(record: Pick<CanvasNodeRecord, 'kind' | 'aspectLocked'>, skinDefault: boolean | undefined, altPressed: boolean): boolean {
  return resolvedAspectLock(record, skinDefault) && !altPressed;
}

function statusLabel(thread: BoardThread | undefined, record: CanvasNodeRecord): string {
  if (record.kind === 'note') return record.id.startsWith('offline-note:') ? '离线待同步' : '本地便签';
  if (!thread) return '尚无对话内容';
  const updatedAt = threadSourceTime(thread);
  return updatedAt ? `对话更新于 ${new Date(updatedAt).toLocaleDateString('zh-CN')}` : '对话更新时间未知';
}
