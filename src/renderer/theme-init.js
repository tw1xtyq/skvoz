(function () {
  try {
    var theme = localStorage.getItem('zapret-theme');
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  } catch (_err) {
    /* ignore */
  }
})();
