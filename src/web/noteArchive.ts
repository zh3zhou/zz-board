import type { CanvasNodeRecord } from '../shared/schema.js';

type ArchiveKey = Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'repeat' | 'isComposing' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

/** Only the unmodified canvas shortcut archives; text editing and dialogs own their keys. */
export function shouldArchiveNote(event: ArchiveKey, selected: CanvasNodeRecord | null | undefined, editing: boolean, overlayOpen: boolean): boolean {
  return (event.key === 'Backspace' || event.key === 'Delete') && !event.defaultPrevented && !event.repeat && !event.isComposing &&
    !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !editing && !overlayOpen &&
    selected?.kind === 'note' && !selected.archivedAt && !selected.id.startsWith('draft-note:');
}

export function archivedNotes(nodes: CanvasNodeRecord[]): CanvasNodeRecord[] {
  return nodes.filter((node) => node.kind === 'note' && Boolean(node.archivedAt))
    .sort((a, b) => (b.archivedAt || '').localeCompare(a.archivedAt || '') || a.id.localeCompare(b.id));
}
