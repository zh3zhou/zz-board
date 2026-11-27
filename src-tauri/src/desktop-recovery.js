// Do not unload a working canvas when its local service needs recovery.
(() => {
  if (window.__ZZ_BOARD_READY__) {
    window.dispatchEvent(new Event('zz-board-service-recovering'));
  } else {
    location.replace(__STATUS_URL__);
  }
})();
