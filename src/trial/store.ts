import { seedTrialBoard, trialBoardSchema, type MediaChanges, type TrialBoard } from './model.js';

const DATABASE_NAME = 'zz-board-trial';
const BOARD_STORE = 'board';
const MEDIA_STORE = 'media';
const BOARD_KEY = 'current';

export class TrialConflictError extends Error {
  constructor() { super('另一标签页已经保存了新改动。'); }
}

export function nextBoardRevision(stored: unknown, draft: TrialBoard): TrialBoard {
  // Read the previous revision inside the same read/write transaction so two tabs
  // cannot both replace the initial snapshot.
  if (!stored || typeof stored !== 'object' || !('revision' in stored) || stored.revision !== draft.revision) {
    throw new TrialConflictError();
  }
  return { ...draft, revision: draft.revision + 1 };
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('浏览器未能保存这次更改。'));
  });
}

export class TrialStore {
  constructor(private readonly database: IDBDatabase) {}

  close(): void { this.database.close(); }

  async load(): Promise<TrialBoard> {
    const transaction = this.database.transaction(BOARD_STORE, 'readwrite');
    const done = completed(transaction);
    const store = transaction.objectStore(BOARD_STORE);
    const request = store.get(BOARD_KEY);
    let loaded: unknown;
    request.onsuccess = () => {
      loaded = request.result;
      if (loaded === undefined) {
        loaded = seedTrialBoard();
        store.put(loaded, BOARD_KEY);
      }
    };
    await done;
    return trialBoardSchema.parse(loaded);
  }

  async save(draft: TrialBoard, changes: MediaChanges): Promise<number> {
    const transaction = this.database.transaction([BOARD_STORE, MEDIA_STORE], 'readwrite');
    const done = completed(transaction);
    const board = transaction.objectStore(BOARD_STORE);
    const media = transaction.objectStore(MEDIA_STORE);
    const current = board.get(BOARD_KEY);
    let abortReason: unknown;
    current.onsuccess = () => {
      try {
        const next = nextBoardRevision(current.result, draft);
        for (const [id, blob] of changes) {
          if (blob) media.put(blob, id);
          else media.delete(id);
        }
        board.put(next, BOARD_KEY);
      } catch (error) {
        abortReason = error;
        transaction.abort();
      }
    };
    try { await done; }
    catch (error) { throw abortReason ?? error; }
    return draft.revision + 1;
  }

  async readImage(id: string): Promise<Blob | undefined> {
    const transaction = this.database.transaction(MEDIA_STORE);
    const done = completed(transaction);
    const request = transaction.objectStore(MEDIA_STORE).get(id);
    await done;
    return request.result instanceof Blob ? request.result : undefined;
  }
}

export function openTrialStore(): Promise<TrialStore> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(BOARD_STORE);
      request.result.createObjectStore(MEDIA_STORE);
    };
    request.onblocked = () => {
      blocked = true;
      reject(new Error('请关闭较早打开的试用页面，再刷新。'));
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      if (blocked) { database.close(); return; }
      database.onversionchange = () => database.close();
      resolve(new TrialStore(database));
    };
  });
}
