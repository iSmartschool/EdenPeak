/* Applies the saved (or the device's) colour theme before anything is drawn, so there is no flash.
   Loaded synchronously in <head>; kept out of index.html so the Content Security Policy needs no inline scripts. */
(function () {
  var t = null;
  try { t = localStorage.getItem('iss-theme'); } catch (e) {}
  if (t !== 'light' && t !== 'dark') t = (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
})();
