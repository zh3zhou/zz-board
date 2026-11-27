import type { NoteEdit } from './noteAutosave.js';

export function NoteRecoveryList({ entries, composing, onLocate, onRetry, onResolve, onDiscard }: {
  entries: readonly NoteEdit[]; composing(id: string): boolean;
  onLocate(id: string): void; onRetry(id: string): void; onResolve(id: string, keepLocal: boolean): void; onDiscard(id: string): void;
}) {
  const dirty = entries.filter((entry) => entry.sequence !== entry.savedSequence);
  return <div className="note-recovery-list"><p>这些本机草稿尚未保存，因此暂不能撤销。处理后再按撤销；下方文字可直接选中复制。</p>
    {!dirty.length && <p>没有待处理草稿，可以关闭此窗口并再次撤销。</p>}
    {dirty.map((entry) => <section key={entry.record.id}>
      <h3>{entry.body.slice(0, 32) || '空白便签'}</h3>
      <p role="status">{composing(entry.record.id) ? '仍在中文组字，请先完成输入。' : entry.error || '文字等待保存。'}</p>
      <textarea aria-label="本机恢复草稿" readOnly value={entry.body} />
      <div className="recovery-actions"><button onClick={() => onLocate(entry.record.id)}>定位便签</button>
        <button disabled={entry.status === 'saving' || composing(entry.record.id)} onClick={() => onRetry(entry.record.id)}>重试保存</button>
        {entry.status === 'conflict' && <><button onClick={() => onResolve(entry.record.id, true)}>保留本机文字</button><button onClick={() => onResolve(entry.record.id, false)}>采用服务端文字</button></>}
        <button disabled={entry.status === 'saving' || composing(entry.record.id)} onClick={() => onDiscard(entry.record.id)}>放弃此草稿…</button>
      </div>
    </section>)}
  </div>;
}
