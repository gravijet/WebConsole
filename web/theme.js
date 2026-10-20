// Applies the saved theme before the page paints (loaded as a blocking script from <head>).
(function () {
  var mode = 'light';
  try { mode = localStorage.getItem('sd.theme') || 'light'; } catch (e) {}
  var dark = mode === 'dark' || (mode === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
