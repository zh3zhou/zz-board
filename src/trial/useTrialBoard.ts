import { useCallback, useEffect, useRef, useState } from 'react';
import { seedTrialBoard, type MediaChanges, type TrialBoard } from './model.js';
import { openTrialStore, TrialConflictError, type TrialStore } from './store.js';

export type SaveStatus = 'loading' | 'saved' | 'saving' | 'unavailable' | 'failed' | 'conflict';

export function useTrialBoard() {
  const [board, setBoard] = useState<TrialBoard | null>(null);
  const [status, setStatus] = useState<SaveStatus>('loading');
  const current = useRef<TrialBoard | null>(null);
  const store = useRef<TrialStore | null>(null);
  const generation = useRef(0);
  const committed = useRef(0);
  const saving = useRef(false);
  const conflicted = useRef(false);
  const media = useRef(new Map<string, Blob | null>());

  useEffect(() => {
    let cancelled = false;
    let opened: TrialStore | undefined;
    async function start() {
      try {
        opened = await openTrialStore();
        if (cancelled) { opened.close(); return; }
        const loaded = await opened.load();
        if (cancelled) return;
        store.current = opened;
        current.current = loaded;
        setBoard(loaded);
        setStatus('saved');
      } catch {
        opened?.close();
        if (cancelled) return;
        const temporary = seedTrialBoard();
        current.current = temporary;
        setBoard(temporary);
        setStatus('unavailable');
      }
    }
    void start();
    function preventLostChanges(event: BeforeUnloadEvent) {
      if (generation.current === committed.current) return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', preventLostChanges);
    return () => {
      cancelled = true;
      opened?.close();
      if (store.current === opened) store.current = null;
      window.removeEventListener('beforeunload', preventLostChanges);
    };
  }, []);

  const save = useCallback(async () => {
    const destination = store.current;
    if (!destination || saving.current || conflicted.current || generation.current === committed.current) return;
    saving.current = true;
    setStatus('saving');
    try {
      while (committed.current !== generation.current) {
        const draft = current.current!;
        const snapshotGeneration = generation.current;
        const imageChanges = new Map(media.current);
        const revision = await destination.save(draft, imageChanges);
        current.current = { ...current.current!, revision };
        for (const [id, change] of imageChanges) if (media.current.get(id) === change) media.current.delete(id);
        committed.current = snapshotGeneration;
      }
      setStatus('saved');
    } catch (error) {
      conflicted.current = error instanceof TrialConflictError;
      setStatus(conflicted.current ? 'conflict' : 'failed');
    } finally { saving.current = false; }
  }, []);

  const update = useCallback((edit: (board: TrialBoard) => TrialBoard, images?: MediaChanges) => {
    const previous = current.current;
    if (!previous) return;
    const next = edit(previous);
    if (next === previous) return;
    for (const [id, blob] of images ?? []) media.current.set(id, blob);
    generation.current++;
    current.current = next;
    setBoard(next);
    void save();
  }, [save]);

  const readImage = useCallback(async (id: string): Promise<Blob | undefined> => {
    if (media.current.has(id)) return media.current.get(id) ?? undefined;
    return store.current?.readImage(id);
  }, []);

  return { board, status, update, readImage, retry: save };
}
