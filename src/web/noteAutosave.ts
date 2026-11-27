import { canvasNodeSchema, type CanvasNodeRecord } from '../shared/schema.js';
import { noteDocumentSchema, sameNoteContent, type NoteDocument, type NoteContent } from '../shared/noteDocument.js';

export interface NoteEdit {
  record: CanvasNodeRecord;
  body: string;
  noteDocument?: NoteDocument | null;
  clientRequestId?: string;
  sessionId: string;
  sequence: number;
  savedSequence: number;
  status: 'pending' | 'saving' | 'saved' | 'error' | 'conflict';
  error?: string;
}
interface Dependencies {
  create(input: NoteContent & { pageId?: string; notePresentation?: 'note' | 'image'; clientRequestId: string; title: string; x: number; y: number; width: number; height: number }): Promise<CanvasNodeRecord>;
  update(id: string, input: Record<string, unknown>): Promise<CanvasNodeRecord>;
  persist(entries: NoteEdit[]): Promise<void>;
  changed(): void;
  accepted(record: CanvasNodeRecord): void;
  online(): boolean;
  storageError(error: unknown): void;
  failed?(message: string): void;
}

/** One serialized writer per note. Remote refreshes never replace a local edit. */
export class NoteAutosave {
  readonly entries = new Map<string, NoteEdit>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Map<string, Promise<boolean>>();
  private composing = new Set<string>();
  private storage = Promise.resolve();
  constructor(private deps: Dependencies) {}

  restore(values: unknown[]) {
    for (const value of values) {
      const e = value as NoteEdit;
      if (!e?.record || e.record.kind !== 'note' || typeof e.record.id !== 'string' || typeof e.body !== 'string' || !Number.isInteger(e.record.revision)) continue;
      if (e.noteDocument && !noteDocumentSchema.safeParse(e.noteDocument).success) continue;
      if (!this.entries.has(e.record.id)) this.entries.set(e.record.id, { ...e, noteDocument: e.noteDocument === undefined ? e.record.noteDocument ?? null : e.noteDocument, status: e.status === 'conflict' ? 'conflict' : 'pending' });
    }
    this.deps.changed();
  }

  edit(record: CanvasNodeRecord, body: string, clientRequestId?: string, noteDocument?: NoteDocument | null) {
    let e = this.entries.get(record.id);
    const document = noteDocument === undefined ? e?.noteDocument === undefined ? record.noteDocument ?? null : e.noteDocument : noteDocument;
    if (!e) {
      e = { record, body, noteDocument: document, clientRequestId, sessionId: crypto.randomUUID(), sequence: 0, savedSequence: -1, status: 'pending' };
      this.entries.set(record.id, e);
    } else {
      if (e.sequence === e.savedSequence) e.record = record;
      e.body = body;
      e.noteDocument = document;
      e.sequence++;
      if (e.status !== 'conflict') e.status = 'pending';
    }
    this.checkpoint();
    this.deps.changed();
    this.schedule(record.id);
  }

  composition(id: string, active: boolean) {
    if (active) { this.composing.add(id); this.cancelTimer(id); }
    else { this.composing.delete(id); this.schedule(id); }
  }
  private schedule(id: string) {
    this.cancelTimer(id);
    if (!this.composing.has(id)) this.timers.set(id, setTimeout(() => { void this.flush(id); }, 600));
  }
  private cancelTimer(id: string) { clearTimeout(this.timers.get(id)); this.timers.delete(id); }

  async flush(id: string): Promise<boolean> {
    this.cancelTimer(id);
    const e = this.entries.get(id);
    if (!e || e.savedSequence === e.sequence) return true;
    if (this.composing.has(id)) return false;
    const active = this.running.get(id);
    if (active) { await active; return this.flush(id); }
    if (e.status === 'conflict') return false;
    // Native text undo and blur can report the original body again. A no-op
    // PATCH would create a history entry and destroy the existing redo branch.
    // Check only after any in-flight save: it may have changed our text base.
    if (!e.clientRequestId && sameNoteContent(e, e.record)) {
      e.savedSequence = e.sequence; e.status = 'saved'; e.error = undefined;
      this.checkpoint(); this.deps.changed(); return true;
    }
    if (!this.deps.online()) {
      e.status = 'error'; e.error = '尚未同步到服务；文字已保留在本机恢复草稿。'; this.checkpoint(); this.deps.changed(); this.deps.failed?.(e.error); return false;
    }
    const sequence = e.sequence;
    const body = e.body;
    const noteDocument = e.noteDocument ?? null;
    const content = { body, noteDocument };
    e.status = 'saving'; this.deps.changed();
    const task = (async () => {
      try {
        // A durable recovery copy precedes the remote mutation.
        await this.storage;
        let record: CanvasNodeRecord;
        if (e.clientRequestId) {
          const { title, x, y, width, height } = e.record;
          record = await this.deps.create({ title, x, y, width, height, pageId: e.record.pageId, clientRequestId: e.clientRequestId, ...content, notePresentation: e.record.notePresentation });
          e.record = record;
          e.clientRequestId = undefined;
          // Idempotent retry may return an earlier body after a lost response.
          if (!sameNoteContent(record, content)) record = await this.deps.update(record.id, { ...content, revision: record.revision, editSessionId: e.sessionId });
        } else {
          try { record = await this.deps.update(id, { ...content, revision: e.record.revision, editSessionId: e.sessionId }); }
          catch (error) {
            const parsed = canvasNodeSchema.safeParse(error && typeof error === 'object' && 'status' in error && error.status === 409 && 'current' in error ? error.current : undefined);
            const remote = parsed.success ? parsed.data : undefined;
            if (!remote || remote.id !== id || remote.kind !== 'note' || remote.archivedAt || remote.revision <= e.record.revision) throw error;
            // The original save may have committed even if its response was
            // lost. Exact text equality is an acknowledgement, not a new edit.
            if (sameNoteContent(remote, content)) record = remote;
            else {
              // Only retry a proven non-text change, once. Never rebase a competing body.
              if (!sameNoteContent(remote, e.record)) throw error;
              e.record = remote;
              this.checkpoint(); await this.storage;
              record = await this.deps.update(id, { ...content, revision: remote.revision, editSessionId: e.sessionId });
            }
          }
        }
        e.record = record; e.savedSequence = sequence; e.error = undefined;
        e.status = e.sequence === sequence ? 'saved' : 'pending';
        this.deps.accepted(record);
        this.checkpoint();
        return true;
      } catch (error) {
        e.status = error && typeof error === 'object' && 'status' in error && error.status === 409 ? 'conflict' : 'error';
        e.error = e.status === 'conflict' ? '服务端已有其他修改；本机文字已保留，请选择保留哪一版。' : `保存未完成：${error instanceof Error ? error.message : String(error)}`;
        this.deps.failed?.(e.error);
        this.checkpoint();
        return false;
      } finally { this.deps.changed(); }
    })();
    this.running.set(id, task);
    const success = await task;
    this.running.delete(id);
    if (success && e.sequence !== e.savedSequence) return this.flush(id);
    return success;
  }

  async finish(id: string) {
    const ok = await this.flush(id);
    const e = this.entries.get(id);
    if (ok && e) { e.sessionId = crypto.randomUUID(); }
    return ok;
  }
  /** Only call at an actual editor exit, not for background/global flushes. */
  async finishEditing(id: string, finalBody?: string) {
    const e = this.entries.get(id);
    if (e && finalBody !== undefined && e.body !== finalBody) this.edit(e.record, finalBody);
    this.composing.delete(id);
    return this.finish(id);
  }
  async flushAll() { return Promise.all([...this.entries.keys()].map((id) => this.flush(id))); }
  async durable() { await this.storage; }
  /** Fresh board metadata can safely advance a draft's base only if its source text is unchanged. */
  reconcile(records: readonly CanvasNodeRecord[]) {
    let changed = false;
    for (const remote of records) {
      const e = this.entries.get(remote.id);
      if (!e || e.clientRequestId || this.running.has(remote.id) || remote.archivedAt || remote.kind !== 'note' || remote.revision <= e.record.revision) continue;
      if (sameNoteContent(remote, e)) {
        e.record = remote; e.savedSequence = e.sequence; e.status = 'saved'; e.error = undefined;
        this.cancelTimer(remote.id); changed = true; continue;
      }
      if (e.sequence !== e.savedSequence && !sameNoteContent(remote, e.record)) continue;
      e.record = remote;
      if (e.status === 'conflict') { e.status = 'pending'; e.error = undefined; this.schedule(remote.id); }
      changed = true;
    }
    if (changed) { this.checkpoint(); this.deps.changed(); }
  }
  isComposing(id: string) { return this.composing.has(id); }
  discard(id: string) { this.cancelTimer(id); this.composing.delete(id); this.entries.delete(id); this.checkpoint(); this.deps.changed(); }
  resolve(id: string, remote: CanvasNodeRecord, keepLocal: boolean) {
    const e = this.entries.get(id);
    if (!e) return;
    if (!keepLocal) { this.discard(id); this.deps.accepted(remote); return; }
    e.record = remote; e.status = 'pending'; e.sessionId = crypto.randomUUID();
    this.checkpoint(); void this.flush(id);
  }
  overlay(record: CanvasNodeRecord): CanvasNodeRecord {
    const e = this.entries.get(record.id);
    return e && e.sequence !== e.savedSequence ? { ...record, body: e.body, noteDocument: e.noteDocument } : record;
  }
  dirty(id: string) { const e = this.entries.get(id); return Boolean(e && e.sequence !== e.savedSequence); }
  private checkpoint() {
    const entries = structuredClone([...this.entries.values()].filter((e) => e.sequence !== e.savedSequence));
    this.storage = this.storage.catch(() => undefined).then(() => this.deps.persist(entries));
    void this.storage.catch(this.deps.storageError);
  }
}

export async function noteRequestNodeId(requestId: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(requestId)));
  return `note:request:${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)}`;
}
