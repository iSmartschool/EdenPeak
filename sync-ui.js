/* =========================================================================
 * iSmartSchool – connection status, Sync Center and notices      (ISSSync)
 * -------------------------------------------------------------------------
 * Shows people, in plain words, whether they are online, what is waiting to
 * be sent, and anything the server did not accept. Uses App.modal for the
 * Sync Center so it looks like the rest of the app.
 * ========================================================================= */
(function (global) {
  'use strict';
  var A = global.App, API = global.ISSApi;
  var E = function (v) { return A.escapeHtml(v === undefined || v === null ? '' : v); };

  /* ------------------------------------------------------------- helpers */
  function when(ts) {
    if (!ts) return '';
    var s = Math.round((Date.now() - ts) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    var d = new Date(ts), t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    if (new Date().toDateString() === d.toDateString()) return 'today at ' + t;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' at ' + t;
  }
  function bytes(n) {
    if (!n && n !== 0) return '—';
    var u = ['B', 'KB', 'MB', 'GB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(1) : n) + ' ' + u[i];
  }
  function today() { return A.todayYMD(); }

  /* ------------------------------------------------------------- toasts */
  // `key`: a newer notice with the same key replaces the older one (e.g.
  // "Back online" replaces "You're offline"). At most 3 are shown at once.
  function toast(message, kind, action, ms, key) {
    var host = document.getElementById('toastHost'); if (!host) return;
    if (key) host.querySelectorAll('[data-key="' + key + '"]').forEach(function (old) { old.remove(); });
    while (host.children.length >= 3) host.firstElementChild.remove();
    var el = document.createElement('div');
    if (key) el.setAttribute('data-key', key);
    el.className = 'toast toast-' + (kind || 'info');
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    var txt = document.createElement('span'); txt.textContent = message; el.appendChild(txt);
    if (action) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'toast-action'; b.textContent = action.label;
      b.onclick = function () { close(); action.fn(); }; el.appendChild(b);
    }
    var x = document.createElement('button'); x.type = 'button'; x.className = 'toast-close'; x.setAttribute('aria-label', 'Dismiss'); x.textContent = '×';
    x.onclick = close; el.appendChild(x);
    host.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    var timer = ms === 0 ? null : setTimeout(close, ms || 5000);
    function close() { if (timer) clearTimeout(timer); el.classList.remove('show'); setTimeout(function () { el.remove(); }, 250); }
    return close;
  }

  /* ------------------------------------------------ pill, banner, login */
  function render(st) {
    st = st || API.status();
    var problems = st.failed + st.attention;
    var cls, text, title;
    if (st.syncing) { cls = 'syncing'; text = 'Sending…'; title = 'Sending changes saved on this device'; }
    else if (st.network === 'offline') { cls = 'offline'; text = 'Offline' + (st.pending ? ' · ' + st.pending : ''); title = "You're offline" + (st.pending ? ' — ' + st.pending + ' change(s) waiting to be sent' : ''); }
    else if (st.network === 'unreachable') { cls = 'offline'; text = 'No server' + (st.pending ? ' · ' + st.pending : ''); title = "The school server can't be reached"; }
    else if (problems) { cls = 'warn'; text = problems + ' to review'; title = problems + ' change(s) need your attention'; }
    else if (st.pending) { cls = 'syncing'; text = st.pending + ' to send'; title = st.pending + ' change(s) waiting to be sent'; }
    else { cls = 'online'; text = 'Online'; title = 'Connected' + (st.lastSync ? ' · last sync ' + when(st.lastSync) : ''); }
    document.querySelectorAll('[data-sync-pill]').forEach(function (p) {
      p.className = 'sync-pill is-' + cls; p.title = title; p.setAttribute('aria-label', title);
      p.querySelector('.txt').textContent = text;
    });

    var banner = document.getElementById('connBanner');
    if (banner) {
      var html = '';
      if (st.network === 'offline' || st.network === 'unreachable') {
        html = (st.network === 'offline'
          ? "<b>You're offline.</b> "
          : "<b>The school server can't be reached.</b> ") +
          (st.stale ? 'Showing information saved on this device ' + E(when(st.stale.savedAt)) + '. ' : '') +
          'Attendance, canteen, payments, expenses, scores and conduct you record are kept on this device and sent automatically when the connection returns.' +
          (st.pending ? ' <button type="button" class="link-btn" data-open-sync>' + st.pending + ' waiting</button>' : '');
        banner.className = 'conn-banner is-offline';
      } else if (problems) {
        html = '<b>' + problems + ' change' + (problems === 1 ? '' : 's') + ' made offline need' + (problems === 1 ? 's' : '') + ' your attention.</b> <button type="button" class="link-btn" data-open-sync>Review</button>';
        banner.className = 'conn-banner is-warn';
      }
      if (html) { banner.innerHTML = html; banner.classList.remove('hidden'); }
      else { banner.innerHTML = ''; banner.classList.add('hidden'); }
      banner.querySelectorAll('[data-open-sync]').forEach(function (b) { b.onclick = openCenter; });
    }

    var net = document.getElementById('loginNet');
    if (net) {
      var msg = !API.isConfigured() ? "This copy of the app isn't connected to a school server yet (config.js)."
        : st.network === 'offline' ? "You're offline. Signing in needs an internet connection. If you ticked “Keep me signed in” last time, reopen the app and you'll go straight in."
        : st.network === 'unreachable' ? "This device is online, but the school server isn't answering. If this continues, check the Apps Script deployment (Who has access: Anyone)." : '';
      net.textContent = msg; net.classList.toggle('hidden', !msg);
    }
    if (document.getElementById('syncCenterBody')) renderCenter();
  }

  /* --------------------------------------------------------- Sync Center */
  function openCenter() {
    A.modal.show('🔄 Sync &amp; offline data', '<div id="syncCenterBody" class="sync-center">' + A.spinner + '</div>', [
      { text: 'Close', cls: 'btn-secondary' },
      { text: '🔄 Send now', cb: function () { sendNow(); return false; } }
    ]);
    renderCenter();
  }
  function sendNow() {
    var st = API.status();
    if (st.network !== 'online') {
      API.ping().then(function (ok) { if (ok) API.flush(); else toast("Still can't reach the server. Changes stay safely on this device.", 'warn', null, 5000, 'conn'); });
    } else { API.flush().then(function (r) { if (r && !r.sent && !r.failed && !r.attention && !st.pending) toast('Everything is up to date.', 'success', null, 2500); }); }
  }
  var centerBusy = false, centerAgain = false;
  function renderCenter() {
    if (centerBusy) { centerAgain = true; return; }
    centerBusy = true;
    Promise.all([API.outbox(), API.history(), API.storageInfo()]).then(function (r) {
      centerBusy = false;
      if (centerAgain) { centerAgain = false; return renderCenter(); }
      var box = document.getElementById('syncCenterBody'); if (!box) return;
      var items = r[0], hist = r[1], info = r[2], st = API.status();
      var pending = items.filter(function (i) { return i.status === 'pending'; });
      var issues = items.filter(function (i) { return i.status !== 'pending'; });
      var conn = st.network === 'online' ? '<span class="dot ok"></span> Connected to the school server'
        : st.network === 'offline' ? '<span class="dot bad"></span> Offline — no internet connection'
        : st.network === 'unreachable' ? "<span class=\"dot bad\"></span> Internet works, but the school server can't be reached"
        : '<span class="dot"></span> Checking connection…';
      var row = function (i, actions) {
        return '<li class="sc-item"><div class="sc-main"><div class="sc-label">' + E(i.label) + '</div>' +
          '<div class="sc-meta">Saved ' + E(when(i.createdAt)) + (i.attempts ? ' · ' + i.attempts + ' attempt' + (i.attempts === 1 ? '' : 's') : '') + '</div>' +
          (i.lastError ? '<div class="sc-err">' + E(i.lastError) + '</div>' : '') + '</div>' + (actions || '') + '</li>';
      };
      var html =
        '<div class="sc-status">' + conn + (st.lastSync ? '<div class="sc-meta">Last sent ' + E(when(st.lastSync)) + '</div>' : '') + '</div>' +
        (!info.deviceStorage ? '<div class="sc-alert">This browser is not letting the app save data on this device (private browsing?). Changes made offline will be lost if this tab is closed.</div>' : '') +
        '<h4>Waiting to send <span class="sc-count">' + pending.length + '</span></h4>' +
        (pending.length ? '<ul class="sc-list">' + pending.map(function (i) { return row(i); }).join('') + '</ul>'
          : '<p class="sc-empty">Nothing waiting — everything recorded on this device has reached the server.</p>') +
        (issues.length ? '<h4>Needs your attention <span class="sc-count warn">' + issues.length + '</span></h4>' +
          '<p class="sc-hint">The server did not fully accept these. Fix the cause (for example, reopen the screen and correct it) and <b>Retry</b>, or <b>Remove</b> the item.</p>' +
          '<ul class="sc-list">' + issues.map(function (i) {
            return row(i, '<div class="sc-actions">' + (i.status === 'failed' ? '<button type="button" class="btn btn-sm" data-retry="' + E(i.id) + '">Retry</button>' : '') +
              '<button type="button" class="btn btn-sm btn-secondary" data-discard="' + E(i.id) + '" data-status="' + E(i.status) + '">' + (i.status === 'attention' ? 'Dismiss' : 'Remove') + '</button></div>');
          }).join('') + '</ul>' : '') +
        (hist.length ? '<details class="sc-hist"><summary>Recently sent (' + hist.length + ')</summary><ul class="sc-list">' + hist.slice(0, 10).map(function (h) {
          return '<li class="sc-item"><div class="sc-main"><div class="sc-label">✓ ' + E(h.label) + '</div><div class="sc-meta">' + E(when(h.at)) + (h.ref ? ' · ' + E(h.ref) : '') + '</div></div></li>';
        }).join('') + '</ul></details>' : '') +
        (API.otherUsersPending() ? '<p class="sc-hint">' + API.otherUsersPending() + ' change(s) by another user of this device are waiting; they are sent when that person signs in here.</p>' : '') +
        '<h4>This device</h4><div class="sc-grid">' +
          '<div><span>Saved screens</span><b>' + info.savedScreens + '</b></div>' +
          '<div><span>Oldest copy</span><b>' + (info.oldest ? E(when(info.oldest)) : '—') + '</b></div>' +
          '<div><span>Storage used</span><b>' + E(bytes(info.usage)) + '</b></div>' +
          '<div><span>Protected from clean-up</span><b>' + (info.persisted ? 'Yes' : 'No') + '</b></div></div>' +
        '<div class="sc-buttons">' +
          '<button type="button" class="btn btn-sm btn-secondary" id="scRefresh"' + (st.network === 'online' ? '' : ' disabled') + '>⬇️ Refresh offline copy</button>' +
          (items.length ? '<button type="button" class="btn btn-sm btn-secondary" id="scExport">💾 Download unsent changes</button>' : '') +
          '<button type="button" class="btn btn-sm btn-secondary" id="scClear">🧹 Remove saved screens</button></div>';
      box.innerHTML = html;
      box.querySelectorAll('[data-retry]').forEach(function (b) { b.onclick = function () { b.disabled = true; API.retry(b.getAttribute('data-retry')); }; });
      box.querySelectorAll('[data-discard]').forEach(function (b) {
        b.onclick = function () {
          var id = b.getAttribute('data-discard');
          if (b.getAttribute('data-status') === 'attention') { API.discard(id); return; }
          if (b.dataset.armed) { API.discard(id); return; }
          b.dataset.armed = '1'; b.textContent = 'Tap again to remove'; b.classList.add('btn-danger');
        };
      });
      var rf = document.getElementById('scRefresh');
      if (rf) rf.onclick = function () { rf.disabled = true; rf.textContent = '⏳ Saving screens…'; warm(true).then(function () { toast('Offline copy refreshed.', 'success', null, 2500); renderCenter(); }); };
      var ex = document.getElementById('scExport');
      if (ex) ex.onclick = function () {
        API.exportOutbox().then(function (json) {
          var url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
          var a = document.createElement('a'); a.href = url; a.download = 'iSmartSchool-unsent-' + today() + '.json';
          document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
        });
      };
      var cl = document.getElementById('scClear');
      if (cl) cl.onclick = function () {
        if (!cl.dataset.armed) { cl.dataset.armed = '1'; cl.textContent = 'Tap again — screens will need internet until reopened'; cl.classList.add('btn-danger'); return; }
        API.clearUserCache(A.user && A.user.email).then(function () { toast('Saved screens removed from this device. Unsent changes were kept.', 'success'); renderCenter(); });
      };
    }).catch(function (e) { centerBusy = false; var box = document.getElementById('syncCenterBody'); if (box) box.innerHTML = A.errHtml(e); });
  }

  /* -------------------------------------------- offline copy of screens */
  function warm(force) {
    var u = A.user; if (!u) return Promise.resolve(false);
    var has = function (p) { return A.hasPage(p); }, d = today();
    var jobs = [['getPublicConfig'], ['getSchoolCrest'], ['getClasses'], ['getAllStudents'], ['getSchoolConfig']];
    if (has('dashboard')) jobs.push(['getDashboardStats']);
    if (has('attendance')) jobs.push(['getAttendanceForDate', { date: d }]);
    if (has('canteen')) jobs.push(['getCanteenSettings'], ['getCanteenRegister', { date: d, classCode: 'All' }], ['getCanteenBalances', { classCode: 'All' }]);
    if (has('fees') || has('finances')) jobs.push(['getAllFeeOverview']);
    if (has('results')) jobs.push(['getConductOptions'], ['getScoreWeights']);
    if (has('expenses')) jobs.push(['getExpenses'], ['getExpenseCategories']);
    if (has('payroll')) jobs.push(['getPayrollSettings'], ['getPayrollStaff']);
    if (has('finances')) jobs.push(['getFinancialSummary']);
    return API.prefetch(jobs, !!force);
  }

  /* ------------------------------------------------------- app wiring */
  API.describeStudent = function (sid) {
    var st = A._cache && A._cache.studentIdx && A._cache.studentIdx[sid];
    return st ? st.FullName + ' (' + sid + ')' : '';
  };
  API.on('status', render);
  API.on('reconnected', function (prev) {
    if (!A.user) return;
    if (prev === 'offline' || prev === 'unreachable') toast('Back online.' + (API.pendingCount() ? ' Sending changes saved on this device…' : ''), 'success', null, 3000, 'conn');
    if (A._offlineStart) {
      // The app was opened offline with the saved profile: confirm it now.
      A.call('validateSession', {}, 'validateSession').then(function (r) {
        if (r && r.valid) { A._offlineStart = false; A.user = Object.assign(A.user, r); A._saveSession(); }
        else A._handleExpiredSession();
      }).catch(function () {});
    }
    warm();
  });
  API.on('synced', function (s) {
    if (s.sent) {
      toast('✅ ' + s.sent + ' change' + (s.sent === 1 ? '' : 's') + ' made offline ' + (s.sent === 1 ? 'was' : 'were') + ' sent to the server.', 'success', null, 5000, 'conn');
      A._feeOvData = []; A._cache.expenses = null;
    }
    var n = s.failed + s.attention;
    if (n) toast(n + ' change' + (n === 1 ? '' : 's') + ' made offline need' + (n === 1 ? 's' : '') + ' your attention.', 'warn', { label: 'Review', fn: openCenter }, 10000, 'attn');
  });
  API.on('auth-required', function () {
    if (A.user && !A._expiredHandled) A._handleExpiredSession();
  });

  var api = {
    toast: toast,
    open: openCenter,
    onSessionStart: function (offline) {
      render();
      // Offline start: the banner above the page already explains it.
      if (!offline) setTimeout(function () { warm(); }, 2500);   // after the first screen has loaded
      if (!API.status().persistent) toast("This browser isn't letting the app save data on this device, so offline use won't work here.", 'warn', null, 8000);
    },
    onSessionEnd: function () { render(); }
  };
  global.ISSSync = api;

  document.addEventListener('DOMContentLoaded', function () {
    var b = document.getElementById('syncCenterBtn'); if (b) b.onclick = function () { A.toggleNav(false); openCenter(); };
    document.querySelectorAll('[data-sync-pill]').forEach(function (p) { p.onclick = openCenter; });
    render();
  });
})(window);
