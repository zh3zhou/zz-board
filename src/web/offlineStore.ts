import { createNoteInputSchema, type BoardState, type CanvasNodeRecord } from '../shared/schema.js';
import type { NoteDocument } from '../shared/noteDocument.js';
import { boardPages, DEFAULT_PAGE_ID, pageId } from '../shared/pages.js';

const DATABASE_NAME = 'zz-board-client';
const DATABASE_VERSION = 1;
const CACHE_STORE = 'cache';
const OUTBOX_STORE = 'note-outbox';
const BOARD_CACHE_KEY = 'latest-board';
const NOTE_EDITS_KEY = 'pending-note-edits-v1';

// Reuse the existing IndexedDB cache; note recovery is not a second database.
export async function readNoteEdits(): Promise<unknown[]> {
  const value = await get(CACHE_STORE, NOTE_EDITS_KEY) as { entries?: unknown[] } | undefined;
  return value?.entries || [];
}
export async function writeNoteEdits(entries: unknown[]): Promise<void> {
  await put(CACHE_STORE, { key: NOTE_EDITS_KEY, entries });
}
const MAX_QUEUED_NOTES = 200;

export interface NoteDraft {
  pageId?: string;
  noteDocument?: NoteDocument | null;
  notePresentation?: 'note' | 'image';
  clientRequestId?: string;
  title: string;
  body: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export type EditableNoteDraft = Omit<NoteDraft, 'clientRequestId'>;

export interface QueuedNote {
  id: string;
  tempNodeId: string;
  createdAt: string;
  input: NoteDraft;
}

export interface CachedBoard {
  board: BoardState;
  savedAt: string;
}

export async function saveBoardCache(board: BoardState): Promise<string> {
  const savedAt = new Date().toISOString();
  await put(CACHE_STORE, { key: BOARD_CACHE_KEY, board, savedAt });
  return savedAt;
}

export async function readBoardCache(): Promise<CachedBoard | null> {
  const value = await get(CACHE_STORE, BOARD_CACHE_KEY) as (CachedBoard & { key: string }) | undefined;
  return value ? { board: value.board, savedAt: value.savedAt } : null;
}

export async function enqueueNote(input: NoteDraft): Promise<QueuedNote> {
  if ((await listQueuedNotes()).length >= MAX_QUEUED_NOTES) {
    throw new Error(`离线便签已达到 ${MAX_QUEUED_NOTES} 张；请先恢复服务完成同步。`);
  }
  const id = input.clientRequestId || crypto.randomUUID();
  const validated = createNoteInputSchema.parse({ ...input, clientRequestId: id });
  const item: QueuedNote = {
    id,
    tempNodeId: `offline-note:${id}`,
    createdAt: new Date().toISOString(),
    input: validated
  };
  await put(OUTBOX_STORE, item);
  return item;
}

export async function listQueuedNotes(): Promise<QueuedNote[]> {
  const values = await getAll(OUTBOX_STORE) as QueuedNote[];
  return values.map(item => ({ ...item, input: { ...item.input, pageId: pageId(item.input) } })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function updateQueuedNote(tempNodeId: string, patch: Partial<EditableNoteDraft>): Promise<QueuedNote> {
  const items = await listQueuedNotes();
  const current = items.find((item) => item.tempNodeId === tempNodeId);
  if (!current) throw new Error('这张离线便签已经同步或不存在。');
  const next = { ...current, input: createNoteInputSchema.parse({ ...current.input, ...patch }) };
  await put(OUTBOX_STORE, next);
  return next;
}

export async function removeQueuedNote(tempNodeId: string): Promise<void> {
  const items = await listQueuedNotes();
  const current = items.find((item) => item.tempNodeId === tempNodeId);
  if (current) await remove(OUTBOX_STORE, current.id);
}

export async function flushQueuedNotes(
  send: (input: NoteDraft) => Promise<unknown>,
  storage = { list: listQueuedNotes, remove: (id: string) => remove(OUTBOX_STORE, id) }
): Promise<{ sent: number; discarded: number; remaining: number; blockedBy?: string }> {
  const items = await storage.list();
  let sent = 0;
  let discarded = 0;
  let blockedBy: string | undefined;
  for (const item of items) {
    try {
      await send(item.input);
      await storage.remove(item.id);
      sent += 1;
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 410) {
        // Another client permanently deleted this request. A retry must not resurrect it.
        try { await storage.remove(item.id); discarded += 1; continue; }
        catch (storageError) { blockedBy = storageError instanceof Error ? storageError.message : String(storageError); break; }
      }
      blockedBy = error instanceof Error ? error.message : String(error);
      if (error && typeof error === 'object' && 'status' in error && (error.status === 404 || error.status === 409)) {
        // A missing/read-only source page keeps its draft, without starving
        // independent drafts from writable pages later in the same outbox.
        continue;
      }
      break;
    }
  }
  return { sent, discarded, remaining: (await storage.list()).length, blockedBy };
}

export function overlayQueuedNotes(board: BoardState, queued: QueuedNote[]): BoardState {
  const compatibleBoard = board as BoardState & {
    projectBriefs?: BoardState['projectBriefs'];
    todos?: BoardState['todos'];
    inkStrokes?: BoardState['inkStrokes'];
    historyStatus?: BoardState['historyStatus'];
    settings: BoardState['settings'] & {
      activeSkinRef?: string | null;
      skinComponents?: BoardState['settings']['skinComponents'];
      keyBindings?: Record<string, string>;
      drawingPreferences?: BoardState['settings']['drawingPreferences'];
    };
  };
  const queuedIds = new Set(queued.map((item) => item.tempNodeId));
  const retained = compatibleBoard.nodes.filter((node) => !node.id.startsWith('offline-note:') || queuedIds.has(node.id));
  const existing = new Set(retained.map((node) => node.id));
  return {
    ...compatibleBoard,
    pages: boardPages(compatibleBoard),
    projectBriefs: compatibleBoard.projectBriefs || [],
    todos: compatibleBoard.todos || [],
    inkStrokes: compatibleBoard.inkStrokes || [],
    historyStatus: compatibleBoard.historyStatus || { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null },
    settings: {
      ...compatibleBoard.settings,
      activeSkinRef: compatibleBoard.settings.activeSkinRef ?? null,
      skinComponents: compatibleBoard.settings.skinComponents || {},
      keyBindings: compatibleBoard.settings.keyBindings || {},
      drawingPreferences: compatibleBoard.settings.drawingPreferences || {
        penColor: '#243241', penSize: 4, highlighterColor: '#f1c75b', highlighterSize: 18,
        eraserMode: 'whole', lassoMode: 'ink', layer: 'background', paletteCollapsed: true
      }
    },
    nodes: [
      ...retained.map(node => ({ ...node, pageId: pageId(node) })),
      ...queued.filter((item) => !existing.has(item.tempNodeId)).map(queuedNoteToNode)
    ]
  };
}

export function patchQueuedNode(board: BoardState, nodeId: string, patch: Partial<EditableNoteDraft>): BoardState {
  return {
    ...board,
    nodes: board.nodes.map((node) => node.id === nodeId
      ? { ...node, ...patch, revision: node.revision + 1, updatedAt: new Date().toISOString() }
      : node)
  };
}

export function removeQueuedNode(board: BoardState, nodeId: string): BoardState {
  return { ...board, nodes: board.nodes.filter((node) => node.id !== nodeId) };
}

function queuedNoteToNode(item: QueuedNote): CanvasNodeRecord {
  return {
    id: item.tempNodeId,
    kind: 'note',
    pageId: item.input.pageId ?? DEFAULT_PAGE_ID,
    threadKey: null,
    x: item.input.x,
    y: item.input.y,
    width: item.input.width,
    height: item.input.height,
    zIndex: 20,
    title: item.input.title,
    body: item.input.body,
    noteDocument: item.input.noteDocument ?? null,
    notePresentation: item.input.notePresentation || 'note',
    lastViewedAt: null,
    revision: 0,
    createdAt: item.createdAt,
    updatedAt: item.createdAt
  };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    let blocked = false;
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CACHE_STORE)) database.createObjectStore(CACHE_STORE, { keyPath: 'key' });
      if (!database.objectStoreNames.contains(OUTBOX_STORE)) database.createObjectStore(OUTBOX_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(request.error || new Error('无法打开本地离线存储。'));
    request.onblocked = () => {
      blocked = true;
      reject(new Error('本地离线存储正在被旧页面占用。'));
    };
  });
}

async function put(storeName: string, value: unknown): Promise<void> {
  const database = await openDatabase();
  try {
    await transactionRequest(database, storeName, 'readwrite', (store) => store.put(value));
  } finally {
    database.close();
  }
}

async function get(storeName: string, key: IDBValidKey): Promise<unknown> {
  const database = await openDatabase();
  try {
    return await transactionRequest(database, storeName, 'readonly', (store) => store.get(key));
  } finally {
    database.close();
  }
}

async function getAll(storeName: string): Promise<unknown[]> {
  const database = await openDatabase();
  try {
    return await transactionRequest(database, storeName, 'readonly', (store) => store.getAll()) as unknown[];
  } finally {
    database.close();
  }
}

async function remove(storeName: string, key: IDBValidKey): Promise<void> {
  const database = await openDatabase();
  try {
    await transactionRequest(database, storeName, 'readwrite', (store) => store.delete(key));
  } finally {
    database.close();
  }
}

function transactionRequest(
  database: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    let result: unknown;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error || new Error('本地离线存储操作失败。'));
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error('本地离线存储事务失败。'));
    transaction.onabort = () => reject(transaction.error || new Error('本地离线存储事务中断。'));
  });
}
