/* =========================================================================
 * iSmartSchool – installable app & updates
 * -------------------------------------------------------------------------
 * • Registers the service worker (sw.js) that keeps the app itself on the
 *   device, so it opens with no connection.
 * • When a new version is published, offers "Update now" instead of
 *   swapping code under someone in the middle of their work.
 * • Shows an "Install app" button where the browser supports it (and
 *   Add-to-Home-Screen steps on iPhone/iPad).
 * ========================================================================= */
(function (global) {
  'use strict';
  var nav = global.navigator;
  var secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  var toast = function (m, k, a, ms, key) { return global.ISSSync ? ISSSync.toast(m, k, a, ms, key) : null; };

  /* ------------------------------------------------------- service worker */
  var updateRequested = false, updateToastShown = false;
  function offerUpdate(reg) {
    if (updateToastShown || !reg.waiting) return;
    updateToastShown = true;
    toast('A new version of iSmartSchool is ready.', 'info', {
      label: 'Update now',
      fn: function () {
        updateRequested = true;
        if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      }
    }, 0, 'update');
  }
  if ('serviceWorker' in nav && secure) {
    global.addEventListener('load', function () {
      nav.serviceWorker.register('sw.js', { scope: './' }).then(function (reg) {
        if (reg.waiting && nav.serviceWorker.controller) offerUpdate(reg);
        reg.addEventListener('updatefound', function () {
          var w = reg.installing; if (!w) return;
          w.addEventListener('statechange', function () {
            if (w.state === 'installed' && nav.serviceWorker.controller) offerUpdate(reg);
          });
        });
        var check = function () { reg.update().catch(function () {}); };
        setInterval(check, 30 * 60 * 1000);
        document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') check(); });
      }).catch(function (e) { console.warn('[pwa] service worker registration failed:', e); });

      var reloading = false;
      nav.serviceWorker.addEventListener('controllerchange', function () {
        if (!updateRequested || reloading) return;
        reloading = true; location.reload();
      });
    });
  }

  /* -------------------------------------------------------------- install */
  var deferred = null;
  var standalone = (global.matchMedia && matchMedia('(display-mode: standalone)').matches) || nav.standalone === true;
  var iOS = /iphone|ipad|ipod/i.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  function showInstall(on) {
    document.querySelectorAll('.install-btn').forEach(function (b) { b.classList.toggle('hidden', !on); });
  }
  function install() {
    if (deferred) {
      deferred.prompt();
      deferred.userChoice.then(function () { deferred = null; showInstall(false); });
      return;
    }
    if (iOS && global.App) {
      App.modal.show('⬇️ Install on iPhone / iPad',
        '<ol style="text-align:left;line-height:1.9;padding-left:20px;">' +
        '<li>Open this page in <b>Safari</b>.</li><li>Tap the <b>Share</b> button (square with an arrow).</li>' +
        '<li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li></ol>' +
        '<p style="font-size:12px;color:var(--text-muted);">Then open iSmartSchool from its icon. Tick “Keep me signed in” to use it offline.</p>',
        [{ text: 'OK' }]);
    }
  }
  global.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; if (!standalone) showInstall(true); });
  global.addEventListener('appinstalled', function () { deferred = null; showInstall(false); toast('iSmartSchool was installed on this device.', 'success', null, 4000, 'install'); });
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.install-btn').forEach(function (b) { b.addEventListener('click', install); });
    if (iOS && !standalone) showInstall(true);
  });
})(window);
