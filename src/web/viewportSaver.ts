import type { Viewport } from '@xyflow/react';

/** Owns the one pending viewport write; connection changes and gestures cancel it. */
export function createViewportSaver(options: {
  online(): boolean;
  save(viewport: Viewport): Promise<unknown>;
  failed(error: unknown): void;
}, delay = 500) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0, disposed = false;
  function cancel() {
    generation++;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  return {
    cancel,
    dispose() { disposed = true; cancel(); },
    queue(viewport: Viewport) {
      cancel();
      if (disposed || !options.online()) return;
      const id = generation, value = { ...viewport };
      timer = setTimeout(() => {
        timer = null;
        if (disposed || id !== generation || !options.online()) return;
        void (async () => {
          try { await options.save(value); }
          catch (error) { if (!disposed && id === generation && options.online()) options.failed(error); }
        })();
      }, delay);
    },
  };
}
