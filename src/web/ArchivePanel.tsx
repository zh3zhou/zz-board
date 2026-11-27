import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CanvasNodeRecord } from '../shared/schema.js';
import { noteDisplayText } from './bubblePresentation.js';
import { NoteDocumentView } from './NoteDocumentView.js';
import { NoteMetadata } from './NoteMetadata.js';
import type { ArchivedNoteRelation } from './archiveRelations.js';
import { MenuHeader, type MenuNavigation } from './MenuHeader.js';

export function ArchivePanel({ relations, focusedNoteId, online, readOnly = false, onClose, onBack, backLabel, onRestore, onDelete }: MenuNavigation & {
  relations: ArchivedNoteRelation[];
  focusedNoteId?: string | null;
  online: boolean;
  readOnly?: boolean;
  onRestore(note: CanvasNodeRecord): Promise<void>;
  onDelete(note: CanvasNodeRecord): Promise<void>;
}) {
  const [pendingDelete, setPendingDelete] = useState<CanvasNodeRecord | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const editable = online && !readOnly;
  const pendingRelation = pendingDelete ? relations.find((relation) => relation.note.id === pendingDelete.id) : undefined;
  useEffect(() => {
    if (!focusedNoteId) return;
    window.requestAnimationFrame(() => document.getElementById(`archive-${focusedNoteId}`)?.scrollIntoView({ block: 'center' }));
  }, [focusedNoteId]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busyId || event.isComposing || event.keyCode === 229 || event.repeat || event.defaultPrevented) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (pendingDelete) setPendingDelete(null);
      else (onBack ?? onClose)();
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [pendingDelete, busyId, onClose, onBack]);

  async function restore(note: CanvasNodeRecord) {
    setBusyId(note.id); setError('');
    try { await onRestore(note); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusyId(null); }
  }
  async function permanentlyDelete() {
    if (!pendingDelete) return;
    setBusyId(pendingDelete.id); setError('');
    try { await onDelete(pendingDelete); setPendingDelete(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusyId(null); }
  }

  return <>
    <section className="menu-page panel-shell archive-panel" aria-label="便签归档" inert={Boolean(pendingDelete)}>
      <MenuHeader title="本页便签归档" onClose={onClose} onBack={onBack} backLabel={backLabel} disabled={Boolean(busyId)} />
      <div className="panel-scroll">
      <p className="archive-intro">这里显示当前页归档的便签。恢复后会回到原位置，内容、优先级、批注和连接都会保留。</p>
      {readOnly ? <p className="offline-panel-note">本页已归档。恢复页面后可以整理这些便签。</p>
        : !online && <p className="offline-panel-note">当前离线。重新连接后可以恢复或永久删除便签。</p>}
      {error && !pendingDelete && <p role="alert" className="archive-error">{error}</p>}
      {relations.length ? <div className="archive-list">{relations.map(({ note, related, linkCount }) => <article id={`archive-${note.id}`} className={`archive-card ${focusedNoteId === note.id ? 'is-focused' : ''}`} key={note.id}>
        {related.length > 0 && <strong className="archive-relation-title">{archiveRelationTitle(related)}</strong>}
        <NoteDocumentView body={noteDisplayText(note) || (note.noteDocument ? '' : '（空白便签）')} document={note.noteDocument} />
        <small>归档于 {new Date(note.archivedAt!).toLocaleString('zh-CN')}{linkCount ? ` · 保留 ${linkCount} 条连接` : ''}</small>
        <NoteMetadata note={note} />
        {related.length > 1 && <ul className="archive-related-list">{related.map((target) => <li key={`${target.nodeId}:${target.title}`}>{target.kind === 'task' ? '任务/项目' : '便签'} · {target.title}</li>)}</ul>}
        <div className="archive-actions">
          <button disabled={!editable || Boolean(busyId)} onClick={() => void restore(note)}>恢复到画布</button>
          <button className="archive-delete" disabled={!editable || Boolean(busyId)} onClick={() => { setError(''); setPendingDelete(note); }}>永久删除…</button>
        </div>
      </article>)}</div> : <p className="empty-summary">本页还没有归档的便签。</p>}
      </div>
    </section>
    {pendingDelete && createPortal(<div className="modal-backdrop"><section className="modal archive-confirm" role="alertdialog" aria-modal="true" aria-labelledby="archive-delete-title">
      <h2 id="archive-delete-title">永久删除这张便签？</h2>
      <p className="archive-excerpt">{noteDisplayText(pendingDelete) || '（空白便签）'}</p>
      <p>便签及其本地批注{pendingRelation?.linkCount ? `、${pendingRelation.linkCount} 条连接` : ''}会一并删除。此操作无法撤销。</p>
      {error && <p role="alert" className="archive-error">{error}</p>}
      <div className="modal-actions">
        <button autoFocus disabled={Boolean(busyId)} onClick={() => setPendingDelete(null)}>取消</button>
        <button className="confirm-danger" disabled={!editable || Boolean(busyId)} onClick={() => void permanentlyDelete()}>{busyId ? '正在删除…' : '确认永久删除'}</button>
      </div>
    </section></div>, document.body)}
  </>;
}

function archiveRelationTitle(related: ArchivedNoteRelation['related']): string {
  const tasks = related.filter((target) => target.kind === 'task');
  const targets = tasks.length ? tasks : related;
  return `与「${targets.map((target) => target.title).join('、')}」相连的便签`;
}
