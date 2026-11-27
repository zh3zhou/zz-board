// Runs before even a cached page's scripts. Keep IndexedDB/recovery drafts intact.
(() => {
  if (window.top !== window) return;
  window.__ZZ_BOARD_DESKTOP__ = true;
  if (location.origin !== 'http://127.0.0.1:4318' || !navigator.serviceWorker) return;
  const isBoardWorker = (worker) => {
    if (!worker) return false;
    const url = new URL(worker.scriptURL, location.href);
    return url.origin === location.origin && url.pathname === '/sw.js';
  };
  void (async () => {
    const controlled = isBoardWorker(navigator.serviceWorker.controller);
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      if ([registration.active, registration.waiting, registration.installing].some(isBoardWorker)) {
        if (!await registration.unregister()) throw new Error('Unable to unregister the old board worker');
      }
    }
    // Unregister does not detach the current document: replace it once afterwards.
    if (controlled) location.replace('/?desktop-recovery=1');
  })().catch(() => console.warn('ZZ Board desktop cache recovery did not complete'));
})();
