/* =========================================================================
 * iSmartSchool – service worker
 * -------------------------------------------------------------------------
 * Keeps the app itself (HTML, CSS, JS, icons) on the device so it opens
 * with no connection. School DATA is not handled here: the page saves it
 * in IndexedDB (assets/js/api.js), and API calls to Apps Script pass
 * straight through, untouched.
 *
 * The build step (scripts/build.mjs) replaces BUILD_ID and the precache
 * list with content hashes, so every deploy installs a fresh, consistent
 * copy and old copies are removed. Without a build (local testing) the
 * fallback list below is used.
 * ========================================================================= */
'use strict';

const BUILD_ID = '__BUILD_ID__';
const PRECACHE = /*__PRECACHE_LIST__*/[
  './', 'index.html', 'config.js', 'manifest.webmanifest',
  'assets/css/app.css', 'assets/css/offline.css',
  'assets/js/theme-init.js', 'assets/js/api.js', 'assets/js/app.js', 'assets/js/sync-ui.js', 'assets/js/pwa.js',
  'assets/icons/favicon.svg', 'assets/icons/favicon-32.png', 'assets/icons/icon-192.png', 'assets/icons/icon-512.png',
  'assets/icons/maskable-512.png', 'assets/icons/apple-touch-icon.png'
]/*__END_PRECACHE_LIST__*/;
// Fetched after install, in the background: large and only needed for the
// Excel results template.
const LAZY = ['assets/vendor/exceljs.min.js'];

// Several schools can share one address (…github.io/SchoolA/, …/SchoolB/):
// cache names carry this copy's folder so one school's update never
// removes another school's saved app.
const SCOPE_PATH = new URL(self.registration.scope).pathname;
const NS = SCOPE_PATH === '/' ? '' : ':' + SCOPE_PATH;
const SHELL_PREFIX = 'iss-shell' + NS + '-';
const SHELL_CACHE = SHELL_PREFIX + BUILD_ID;
const RUNTIME_CACHE = 'iss-runtime' + NS + '-v1';
// Names used before per-school caches (shared by every copy).
const LEGACY = (k) => /^iss-shell-[^:]*$/.test(k) && !k.startsWith('iss-shell:') || k === 'iss-runtime-v1';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // cache: 'reload' bypasses the browser's HTTP cache, so a new version
    // never mixes old and new files.
    await Promise.all(PRECACHE.map(async (url) => {
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (!res.ok) throw new Error('Precache failed for ' + url + ' (' + res.status + ')');
      await cache.put(url, res);
    }));
    // First install: take over straight away. Updates wait until the user
    // presses "Update now" (see pwa.js).
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Only this copy's old versions (and the old shared names) are removed.
    await Promise.all(keys.filter((k) => (k.startsWith(SHELL_PREFIX) && k !== SHELL_CACHE) || (NS && LEGACY(k))).map((k) => caches.delete(k)));
    if (self.registration.navigationPreload) { try { await self.registration.navigationPreload.disable(); } catch (e) {} }
    await self.clients.claim();
    // Warm the optional files without delaying activation.
    const rt = await caches.open(RUNTIME_CACHE);
    LAZY.forEach(async (url) => {
      try {
        if (await rt.match(url)) return;
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res.ok) await rt.put(url, res);
      } catch (e) { /* offline during install: fetched on first use instead */ }
    });
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function scopeUrl(path) { return new URL(path, self.registration.scope).href; }

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                       // API POSTs go straight to the network
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // Apps Script and anything off-site: untouched
  if (url.searchParams.has('__probe')) return;            // connectivity check from api.js: network only

  // Page loads: the app is a single page, so always answer with the saved
  // index.html (fast, and works offline); fall back to the network.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match('index.html');
      if (hit) return hit;
      try { return await fetch(req); }
      catch (e) { return new Response('<h1>Offline</h1><p>iSmartSchool has not finished saving itself on this device yet. Connect once and reload.</p>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }
    })());
    return;
  }

  // App files: from the installed copy (query strings ignored).
  event.respondWith((async () => {
    const shell = await caches.open(SHELL_CACHE);
    const hit = await shell.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const rt = await caches.open(RUNTIME_CACHE);
    const rtHit = await rt.match(req, { ignoreSearch: true });
    if (rtHit) return rtHit;
    try {
      const res = await fetch(req);
      // Keep other same-origin static files (e.g. the Excel library) for offline use.
      if (res.ok && res.type === 'basic' && url.href.startsWith(scopeUrl('assets/'))) rt.put(req, res.clone());
      return res;
    } catch (e) {
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});

// Background Sync: ask any open iSmartSchool window to send its outbox.
// (Sending needs the signed-in user's session, which lives in the page.)
self.addEventListener('sync', (event) => {
  if (event.tag !== 'iss-outbox' + NS) return;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then((list) => list.forEach((c) => c.postMessage({ type: 'FLUSH_OUTBOX' }))));
});
