import type { CanvasNodeRecord } from '../shared/schema.js';

export function FoldedNoteSection({ notes, online, onUnfold }: {
  notes: readonly CanvasNodeRecord[]; online: boolean; onUnfold(id: string): void;
}) {
  if (!notes.length) return null;
  return <section className="folded-note-section"><h3>收纳便签 · {notes.length}</h3>
    {notes.map((note) => <div className="relation-row" key={note.id}>
      <p>{note.body.slice(0, 120) || '空白便签'}</p>
      <button disabled={!online} onClick={() => onUnfold(note.id)} title="回到原来的画布位置">展开</button>
    </div>)}
  </section>;
}
