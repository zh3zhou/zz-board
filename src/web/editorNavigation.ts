import type { NoteContent } from '../shared/noteDocument.js';

type EditorExit = () => Promise<boolean>;
const editors = new Set<EditorExit>();
const clipboardReaders = new Map<string, () => NoteContent>();

/** ClipboardData and clipboard user activation are synchronous. Read the mounted editor before React state catches up. */
export function registerNoteClipboardReader(noteId: string | undefined, read: () => NoteContent): () => void {
  if (!noteId) return () => {};
  clipboardReaders.set(noteId, read);
  return () => { if (clipboardReaders.get(noteId) === read) clipboardReaders.delete(noteId); };
}

export function noteForClipboard<T extends NoteContent & { id?: string }>(note: T): T {
  const read = note.id && clipboardReaders.get(note.id);
  return read ? { ...note, ...read() } : note;
}

/** Mounted editors retain ownership of pending DOM input and inline uploads. */
export function registerEditorExit(exit: EditorExit): () => void {
  editors.add(exit);
  return () => { editors.delete(exit); };
}

export async function finishCanvasEditors(): Promise<boolean> {
  for (const exit of [...editors]) if (!await exit()) return false;
  return true;
}
