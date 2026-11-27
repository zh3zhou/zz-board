(() => {
  if (!window.__ZZ_BOARD_READY__ && !document.getElementById('root')) {
    location.replace('http://127.0.0.1:4318');
  }
})();
