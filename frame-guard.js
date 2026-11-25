/* iSmartSchool – refuses to run inside another site's frame (clickjacking).
   GitHub Pages cannot send the X-Frame-Options / frame-ancestors headers, and a
   <meta> CSP cannot set frame-ancestors, so this check runs first, in <head>.
   Inside a frame the page stays hidden and only offers a link that opens the
   app in its own window. Set allowFraming: true in config.js only if you embed
   the app on purpose (e.g. Google Sites). Not used by the Apps Script page,
   which Google always serves inside its own frame. */
(function () {
  'use strict';
  var framed;
  try { framed = window.top !== window.self; } catch (e) { framed = true; }
  if (!framed || (window.ISS_CONFIG && window.ISS_CONFIG.allowFraming === true)) return;
  var root = document.documentElement;
  root.style.display = 'none';
  document.addEventListener('DOMContentLoaded', function () {
    var p = document.createElement('p');
    p.style.cssText = 'font:16px system-ui,sans-serif;padding:24px;text-align:center;';
    var a = document.createElement('a');
    a.href = location.href; a.target = '_top'; a.rel = 'noopener';
    a.textContent = 'Open iSmartSchool in its own window';
    p.appendChild(a);
    document.body.innerHTML = '';
    document.body.appendChild(p);
    root.style.display = '';
  });
  // Stop the app scripts from signing anyone in inside the frame.
  window.ISS_FRAMED = true;
})();
