/* =========================================================================
 * iSmartSchool – API client with offline support                (ISSApi)
 * -------------------------------------------------------------------------
 * Every server call from the app goes through ISSApi.call(fn, params).
 *
 *  Transport   Hosted on GitHub Pages → HTTPS POST to the Apps Script web
 *              app (Api.gs → doPost). Hosted by Apps Script itself →
 *              google.script.run. Same app code either way.
 *
 *  Reads       get… / search… calls are network-first. Every successful
 *              answer is saved on this device (IndexedDB, per user). When
 *              the server can't be reached, the saved answer is used and
 *              the app shows when it was saved.
 *
 *  Writes      The everyday writes that are safe to repeat (fee & canteen
 *              payments, expenses, attendance, canteen register, scores,
 *              conduct) are put in an OUTBOX on this device when offline
 *              and sent automatically, in order, when the connection
 *              returns. Each carries an idempotency key or is a natural
 *              upsert on the server, so a retry can never double-charge.
 *              Anything else (rollover, user admin, deletions…) needs a
 *              live connection and says so.
 *
 *  Safety      Outbox items belong to the user who made them and are only
 *              sent with that user's own session. One tab sends at a time
 *              (Web Locks). Items the server rejects are kept for review in
 *              the Sync Center — never silently dropped.
 * ========================================================================= */
(function (global) {
  'use strict';

  var CFG = global.ISS_CONFIG || {};
  var API_URL = String(CFG.apiUrl || '').trim();
  var CACHE_DAYS = Math.max(1, Number(CFG.offlineCacheDays) || 30);
  var PREFETCH_MIN = CFG.prefetchEveryMinutes === 0 ? 0 : Math.max(2, Number(CFG.prefetchEveryMinutes) || 10);
  var PROTOCOL_VERSION = 1;
  // Several schools can be hosted under one address
  // (ismartschool.github.io/SchoolA/, …/SchoolB/). Browsers treat those as ONE
  // site, so every name stored on the device carries this copy's folder:
  // each school gets its own sign-in, saved screens and outbox.
  var APP_PATH = location.pathname.replace(/[^/]*$/, '') || '/';
  var NS = APP_PATH === '/' ? '' : ':' + APP_PATH;

  /* ---------------------------------------------------------------- policy */
  // Answers that are the same for everyone (shown before sign-in).
  var PUBLIC_READS = { getPublicConfig: 1, needsFirstTimeSetup: 1, getSchoolName: 1, getSchoolCrest: 1 };
  // Reads that are not worth keeping offline (large, admin-only or live-only).
  var NO_CACHE = { generateReportCardsBatch: 1, getDataHealth: 1, getArchiveStatus: 1, getRolePermissions: 1, getAllUsers: 1, getRoleNames: 1 };
  // Calls that must never wait for the outbox to be sent first.
  var NO_FLUSH_FIRST = { loginUser: 1, logoutUser: 1, validateSession: 1, registerFirstAdmin: 1, changePassword: 1, apiPing: 1 };
  // Long-running server jobs (Apps Script allows up to 6 minutes).
  var LONG = { processRollover: 1, promoteAllClasses: 1, archiveClosedTerms: 1, compactSheets: 1, bulkUploadStudents: 1, bulkDeleteStudents: 1,
               generateReportCardsBatch: 1, uploadClassResults: 1, payPayrollRun: 1, reversePayrollRun: 1, createDatabaseSchema: 1, updateClass: 1, updateSubject: 1 };
  // Writes that may be stored offline and sent later. `stamp` records facts
  // that belong to the moment the user acted (e.g. the date of a payment).
  var QUEUE = {
    recordFeePayment: {
      label: function (p) { return 'Fee payment · ' + money(p.amountPaid) + ' · ' + who(p.studentID); },
      idem: true, result: function () { return { receiptNumber: '', transactionID: null }; },
      stamp: function (p) { if (!p.paymentDate) p.paymentDate = today(); }
    },
    recordExpense: {
      label: function (p) { return 'Expense · ' + (p.description || '') + ' · ' + money(p.amount); },
      idem: true, result: function () { return { voucherNumber: '' }; },
      stamp: function (p) { if (!p.date) p.date = today(); }
    },
    recordCanteenPayment: {
      label: function (p) { return 'Canteen payment · ' + (p.mode === 'debt' ? 'full debt' : money(p.amount)) + ' · ' + who(p.studentID); },
      idem: true, result: function (p) { return { amount: round2(p.amount), receiptNumber: '', txId: null, summary: '' }; },
      stamp: function (p) { if (!p.date) p.date = today(); }
    },
    recordCanteenExpense: {
      label: function (p) { return 'Canteen expense · ' + (p.description || '') + ' · ' + money(p.amount); },
      idem: true, result: function () { return { voucherNumber: '' }; },
      stamp: function (p) { if (!p.date) p.date = today(); }
    },
    markAttendanceBatch: {
      label: function (p) { return 'Attendance · ' + niceDate(p.date) + ' · ' + count(p.records, 'student'); }
    },
    saveCanteenRegister: {
      label: function (p) { return 'Canteen register · ' + niceDate(p.date) + ' · ' + count(p.entries, 'student'); },
      result: function () { return { blocked: [], tally: null }; }
    },
    recordSubjectScoreBatch: {
      label: function (p) { return 'Scores · ' + who(p.studentID) + ' · ' + count(p.scores, 'subject'); },
      result: function () { return { saved: 0, rejected: [] }; }
    },
    saveStudentConduct: {
      label: function (p) { return 'Conduct · ' + who(p.sid) + ' · ' + (p.conduct || ''); }
    }
  };
  var OFFLINE_MSG = {
    loginUser: "You're offline. Signing in needs an internet connection.",
    registerFirstAdmin: "You're offline. Setting up the first account needs an internet connection.",
    _default: "You're offline. This action needs a connection to the school server — please try again when you're back online."
  };
  var QUEUED_MSG = "Saved on this device. It will be sent to the server automatically when you're back online.";

  function isRead(fn) { return /^(get|search)/.test(fn) || !!PUBLIC_READS[fn]; }
  function timeoutFor(fn) { return LONG[fn] ? 330000 : isRead(fn) ? 45000 : 90000; }

  /* --------------------------------------------------------------- helpers */
  function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }
  function money(v) { return 'GH₵ ' + round2(v).toFixed(2); }
  function count(list, noun) { var n = Array.isArray(list) ? list.length : 0; return n + ' ' + noun + (n === 1 ? '' : 's'); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function niceDate(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : String(ymd || '');
  }
  function who(sid) {
    try { var n = api.describeStudent && api.describeStudent(sid); if (n) return n; } catch (e) {}
    return String(sid || '');
  }
  function uid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  function clone(v) {
    if (v === undefined || v === null) return v;
    try { return global.structuredClone ? structuredClone(v) : JSON.parse(JSON.stringify(v)); } catch (e) { return JSON.parse(JSON.stringify(v)); }
  }
  function withoutToken(params) {
    var out = {}; Object.keys(params || {}).forEach(function (k) { if (k !== 'token') out[k] = params[k]; }); return out;
  }
  function stable(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; }).map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
  }
  function makeError(message, props) { var e = new Error(message); Object.keys(props || {}).forEach(function (k) { e[k] = props[k]; }); return e; }
  function offlineError(fn, kind) {
    return makeError(OFFLINE_MSG[fn] || OFFLINE_MSG._default, { name: 'OfflineError', offline: true, kind: kind || 'network' });
  }

  /* ---------------------------------------------------------------- events */
  var listeners = {};
  function on(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); return function () { listeners[ev] = (listeners[ev] || []).filter(function (x) { return x !== cb; }); }; }
  function emit(ev, data) { (listeners[ev] || []).slice().forEach(function (cb) { try { cb(data); } catch (e) { console.error(e); } }); }

  /* ----------------------------------------------------------------- store */
  // IndexedDB with an in-memory fallback (private browsing / blocked storage).
  var store = (function () {
    var DB_NAME = 'iss-offline' + NS, VERSION = 1, dbp = null, mem = null;
    function memStore() {
      var m = { cache: new Map(), outbox: new Map(), meta: new Map() };
      return {
        persistent: false,
        get: function (s, k) { return Promise.resolve(clone(m[s].get(k))); },
        put: function (s, v) { m[s].set(v.key || v.id, clone(v)); return Promise.resolve(); },
        del: function (s, k) { m[s].delete(k); return Promise.resolve(); },
        all: function (s) { return Promise.resolve(Array.from(m[s].values()).map(clone)); },
        delWhere: function (s, pred) { Array.from(m[s].values()).forEach(function (v) { if (pred(v)) m[s].delete(v.key || v.id); }); return Promise.resolve(); }
      };
    }
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        if (!global.indexedDB) return reject(new Error('no indexedDB'));
        var req;
        try { req = indexedDB.open(DB_NAME, VERSION); } catch (e) { return reject(e); }
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'key' }).createIndex('user', 'user');
          if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        };
        req.onsuccess = function () {
          var db = req.result;
          db.onversionchange = function () { db.close(); };
          resolve(db);
        };
        req.onerror = function () { reject(req.error); };
        req.onblocked = function () { reject(new Error('IndexedDB blocked')); };
      });
      return dbp;
    }
    function tx(s, mode, work) {
      if (mem) return work(null);
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction(s, mode), os = t.objectStore(s), out;
          Promise.resolve(work(os)).then(function (v) { out = v; });
          t.oncomplete = function () { resolve(out); };
          t.onerror = function () { reject(t.error); };
          t.onabort = function () { reject(t.error || new Error('transaction aborted')); };
        });
      });
    }
    function req2p(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
    var api = {
      persistent: true,
      ready: function () {
        return open().then(function () { return api; }, function (e) {
          console.warn('[ISSApi] Offline storage unavailable, using memory only:', e && e.message);
          mem = memStore(); api.persistent = false;
          ['get', 'put', 'del', 'all', 'delWhere'].forEach(function (k) { api[k] = mem[k]; });
          return api;
        });
      },
      get: function (s, k) { return tx(s, 'readonly', function (os) { return req2p(os.get(k)); }); },
      put: function (s, v) { return tx(s, 'readwrite', function (os) { os.put(v); }); },
      del: function (s, k) { return tx(s, 'readwrite', function (os) { os.delete(k); }); },
      all: function (s) { return tx(s, 'readonly', function (os) { return req2p(os.getAll()); }); },
      delWhere: function (s, pred) {
        return tx(s, 'readwrite', function (os) {
          return new Promise(function (resolve) {
            var c = os.openCursor();
            c.onsuccess = function () { var cur = c.result; if (!cur) return resolve(); if (pred(cur.value)) cur.delete(); cur.continue(); };
            c.onerror = function () { resolve(); };
          });
        });
      }
    };
    return api;
  })();
  var ready = store.ready();

  /* -------------------------------------------------------------- session */
  var session = null;            // { email, token }
  function scopeFor(fn) { return PUBLIC_READS[fn] ? '__public__' : (session ? session.email : null); }

  /* ------------------------------------------------------------ transport */
  function hasGsr() { return !!(global.google && google.script && google.script.run); }
  function remote(fn, params, timeoutMs) {
    if (hasGsr()) {
      return new Promise(function (resolve, reject) {
        google.script.run.withSuccessHandler(resolve).withFailureHandler(function (err) {
          var msg = err && err.message ? err.message : String(err);
          if (/NetworkError|network connection|failed to fetch/i.test(msg)) reject(makeError(OFFLINE_MSG._default, { offline: true, kind: 'network', name: 'OfflineError' }));
          else reject(err instanceof Error ? err : new Error(msg));
        })[fn](params);
      });
    }
    if (!API_URL) {
      return Promise.reject(makeError("This app isn't connected to its server yet. Set the Apps Script web app URL in config.js (see README).", { code: 'NOT_CONFIGURED' }));
    }
    var ctrl = global.AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 60000) : null;
    return fetch(API_URL, {
      method: 'POST',
      // text/plain keeps this a "simple" request: no CORS preflight, which
      // Apps Script cannot answer.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn: fn, params: params || {}, v: PROTOCOL_VERSION }),
      redirect: 'follow', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        try { body = JSON.parse(text); } catch (e) {}
        if (!body || typeof body !== 'object' || !('ok' in body)) {
          if (res.status === 429 || res.status >= 500) throw makeError('The school server is busy. Please try again in a moment.', { offline: true, kind: 'unavailable', name: 'OfflineError' });
          var title = (/<title>([^<]*)<\/title>/i.exec(text) || [])[1];
          throw makeError('The server sent an unexpected reply' + (title ? ' (' + title.trim() + ')' : '') +
            '. Check that the Apps Script deployment includes Api.gs and is set to "Anyone" (see README).', { code: 'BAD_RESPONSE', transient: true });
        }
        if (!body.ok) throw makeError(body.error || 'The server could not complete the request.', { code: body.code || 'SERVER' });
        return body.result === undefined ? null : body.result;
      });
    }, function (err) {
      if (err && err.name === 'AbortError') throw makeError('The server took too long to answer.', { offline: true, kind: 'timeout', name: 'OfflineError' });
      throw makeError(OFFLINE_MSG._default, { offline: true, kind: 'network', name: 'OfflineError' });
    }).finally(function () { if (timer) clearTimeout(timer); });
  }

  /* --------------------------------------------------------- connectivity */
  var state = { network: global.navigator && navigator.onLine === false ? 'offline' : 'unknown', syncing: false, pending: 0, failed: 0, attention: 0,
                lastSync: null, stale: null, persistent: true };
  function setState(patch) {
    var changed = false;
    Object.keys(patch).forEach(function (k) { if (state[k] !== patch[k]) { state[k] = patch[k]; changed = true; } });
    if (changed) emit('status', clone(state));
  }
  function markOnline() {
    var was = state.network;
    setState({ network: 'online', stale: null });
    if (was !== 'online') { emit('reconnected', was); scheduleFlush(300); }
    stopRetryLoop();
  }
  // A failed call: tell "no internet" apart from "internet fine, but the
  // school server can't be reached" (wrong URL, deployment not public…).
  function markUnreachable(kind) {
    if (global.navigator && navigator.onLine === false) { setState({ network: 'offline' }); startRetryLoop(); return; }
    if (kind === 'unavailable' || kind === 'timeout') { setState({ network: 'unreachable' }); startRetryLoop(); return; }
    fetch('manifest.webmanifest?__probe=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { setState({ network: r.ok ? 'unreachable' : 'offline' }); }, function () { setState({ network: 'offline' }); })
      .then(startRetryLoop);
  }
  var retryTimer = null, retryDelay = 15000;
  function startRetryLoop() {
    if (retryTimer) return;
    var tick = function () {
      retryTimer = setTimeout(function () {
        retryTimer = null;
        ping().then(function (ok) { if (!ok) { retryDelay = Math.min(retryDelay * 1.6, 120000); tick(); } });
      }, retryDelay);
    };
    tick();
  }
  function stopRetryLoop() { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } retryDelay = 15000; }
  function ping() {
    if (global.navigator && navigator.onLine === false) { setState({ network: 'offline' }); return Promise.resolve(false); }
    return remote('apiPing', {}, 12000).then(function () { markOnline(); return true; }, function (e) {
      if (e && e.offline) { markUnreachable(e.kind); return false; }
      // Reached the server but it answered with an error → it is up.
      markOnline(); return true;
    });
  }
  if (global.addEventListener) {
    global.addEventListener('online', function () { ping(); });
    global.addEventListener('offline', function () { setState({ network: 'offline' }); startRetryLoop(); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (state.network !== 'online') ping(); else if (state.pending) scheduleFlush(500);
    });
  }

  /* ----------------------------------------------------------- read cache */
  function cacheKey(scope, fn, params) { return scope + '|' + fn + '|' + stable(withoutToken(params)); }
  function cachePut(fn, params, data) {
    var scope = scopeFor(fn);
    if (!scope || NO_CACHE[fn] || data === undefined) return Promise.resolve();
    var entry = { key: cacheKey(scope, fn, params), user: scope, fn: fn, params: withoutToken(params), data: data, savedAt: Date.now() };
    return ready.then(function () { return store.put('cache', entry); }).catch(function (e) { console.warn('[ISSApi] cache write failed', e); });
  }
  function cacheGet(fn, params) {
    var scope = scopeFor(fn);
    if (!scope) return Promise.resolve(null);
    return ready.then(function () { return store.get('cache', cacheKey(scope, fn, params)); }).catch(function () { return null; });
  }
  // Answers that can be worked out from another saved answer when the exact
  // one was never saved (e.g. one class's canteen register from "All").
  var DERIVE = {
    getCanteenRegister: function (params) {
      if (!params.classCode || params.classCode === 'All') return Promise.resolve(null);
      return cacheGet('getCanteenRegister', { date: params.date, classCode: 'All' }).then(function (e) {
        if (!e || !e.data || !e.data.rows) return null;
        var d = clone(e.data);
        d.rows = d.rows.filter(function (r) { return r.cls === params.classCode; });
        d.anySaved = d.rows.some(function (r) { return r.present; });
        return { data: d, savedAt: e.savedAt };
      });
    },
    getAttendanceForDate: function () { return Promise.resolve({ data: {}, savedAt: null, assumed: true }); },
    getAllStudents: function (params) {
      if (!params.classFilter || params.classFilter === 'All') return Promise.resolve(null);
      return cacheGet('getAllStudents', {}).then(function (e) {
        return e ? { data: (e.data || []).filter(function (s) { return s.Class === params.classFilter; }), savedAt: e.savedAt } : null;
      });
    }
  };
  function fromCache(fn, params, cause) {
    return cacheGet(fn, params).then(function (e) {
      if (e) return e;
      return DERIVE[fn] ? DERIVE[fn](withoutToken(params)) : null;
    }).then(function (e) {
      if (!e) {
        throw makeError(cause && cause.kind === 'unreachable'
          ? "The school server can't be reached, and this screen hasn't been saved on this device yet."
          : "You're offline, and this screen hasn't been opened on this device while online yet, so there is no saved copy.",
          { offline: true, kind: 'nocache', name: 'OfflineError' });
      }
      if (e.savedAt) setState({ stale: { savedAt: e.savedAt, fn: fn } });
      return overlay(fn, params, clone(e.data));
    });
  }
  function purgeOldCache() {
    var limit = Date.now() - CACHE_DAYS * 86400000;
    return ready.then(function () { return store.delWhere('cache', function (v) { return !v.savedAt || v.savedAt < limit; }); }).catch(function () {});
  }
  function clearUserCache(email) {
    return ready.then(function () { return store.delWhere('cache', function (v) { return v.user === email; }); })
      .then(function () { return store.del('meta', 'prefetch:' + email); }).catch(function () {});
  }
  function clearAllCache() {
    return ready.then(function () { return store.delWhere('cache', function () { return true; }); }).catch(function () {});
  }

  /* -------------------------------------------------------------- overlay */
  // Changes waiting in the outbox are shown on the screens they affect, so
  // a teacher who saved attendance offline sees it when reopening the day.
  function pendingFor(fn) {
    if (!session) return [];
    return outboxMem.filter(function (i) { return i.user === session.email && i.status === 'pending' && i.fn === fn; })
      .sort(function (a, b) { return a.createdAt - b.createdAt; });
  }
  var OVERLAY = {
    getAttendanceForDate: function (r, p) {
      r = r || {};
      pendingFor('markAttendanceBatch').forEach(function (i) {
        if (i.params.date !== p.date) return;
        (i.params.records || []).forEach(function (x) { r[x.studentID] = x.status; });
      });
      return r;
    },
    getCanteenRegister: function (r, p) {
      if (!r || !Array.isArray(r.rows)) return r;
      var m = {};
      pendingFor('saveCanteenRegister').forEach(function (i) {
        if (i.params.date !== p.date) return;
        (i.params.entries || []).forEach(function (e) { m[e.studentID] = e; });
      });
      if (!Object.keys(m).length) return r;
      r.rows.forEach(function (row) { var e = m[row.studentID]; if (e) { row.present = !!e.present; row.credit = !!e.credit; } });
      r.anySaved = true; r.pendingSync = true;
      return r;
    },
    getStudentResults: function (r, p) {
      var rows = Array.isArray(r) ? r : [];
      pendingFor('recordSubjectScoreBatch').forEach(function (i) {
        if (String(i.params.studentID) !== String(p.sid)) return;
        (i.params.scores || []).forEach(function (sc) {
          var row = rows.filter(function (x) { return x.subject === sc.subject; })[0];
          if (!row) { row = { subject: sc.subject }; rows.push(row); }
          row.rawClass = sc.classScore; row.rawExam = sc.examScore; row.total = 'not yet synced';
        });
      });
      return rows;
    },
    getStudentConduct: function (r, p) {
      var last = pendingFor('saveStudentConduct').filter(function (i) { return String(i.params.sid) === String(p.sid); }).pop();
      return last ? { success: true, conduct: last.params.conduct, pendingSync: true } : r;
    }
  };
  function overlay(fn, params, data) {
    try { return OVERLAY[fn] ? OVERLAY[fn](data, withoutToken(params)) : data; } catch (e) { console.warn(e); return data; }
  }

  /* --------------------------------------------------------------- outbox */
  var outboxMem = [];
  var channel = global.BroadcastChannel ? new BroadcastChannel('iss-sync' + NS) : null;
  if (channel) channel.onmessage = function (ev) { if (ev.data === 'outbox-changed') loadOutbox(); };
  function loadOutbox() {
    return ready.then(function () { return store.all('outbox'); }).then(function (all) {
      outboxMem = (all || []).sort(function (a, b) { return a.createdAt - b.createdAt; });
      recount();
      return outboxMem;
    }).catch(function () { return outboxMem; });
  }
  function recount() {
    var mine = session ? outboxMem.filter(function (i) { return i.user === session.email; }) : [];
    setState({
      pending: mine.filter(function (i) { return i.status === 'pending'; }).length,
      failed: mine.filter(function (i) { return i.status === 'failed'; }).length,
      attention: mine.filter(function (i) { return i.status === 'attention'; }).length
    });
  }
  function saveItem(item) {
    return store.put('outbox', item).then(function () {
      var i = outboxMem.findIndex(function (x) { return x.id === item.id; });
      if (i >= 0) outboxMem[i] = item; else outboxMem.push(item);
      recount(); if (channel) channel.postMessage('outbox-changed');
    });
  }
  function removeItem(id) {
    return store.del('outbox', id).then(function () {
      outboxMem = outboxMem.filter(function (x) { return x.id !== id; });
      recount(); if (channel) channel.postMessage('outbox-changed');
    });
  }
  function enqueue(fn, params) {
    if (!session) return Promise.reject(offlineError(fn));
    var rule = QUEUE[fn], clean = withoutToken(params);
    var item = { id: uid(), user: session.email, fn: fn, params: clean, label: rule.label(clean), createdAt: Date.now(),
                 status: 'pending', attempts: 0, lastError: '', lastTriedAt: null };
    return ready.then(function () { return saveItem(item); }).then(function () {
      registerBackgroundSync();
      emit('queued', item);
      var res = { success: true, queued: true, offline: true, outboxId: item.id, message: QUEUED_MSG };
      if (rule.result) Object.assign(res, rule.result(clean));
      if (!store.persistent) res.message += ' (This browser is not letting the app save data permanently — keep this tab open until it is sent.)';
      return res;
    });
  }
  function registerBackgroundSync() {
    try {
      if (global.navigator && navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then(function (reg) { if (reg.sync) return reg.sync.register('iss-outbox' + NS); }).catch(function () {});
      }
    } catch (e) {}
  }
  function withSendLock(work) {
    if (global.navigator && navigator.locks && navigator.locks.request) {
      return navigator.locks.request('iss-outbox' + NS, { ifAvailable: true }, function (lock) { return lock ? work() : null; });
    }
    return work();
  }
  var flushing = null, flushTimer = null;
  function scheduleFlush(ms) {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(function () { flushTimer = null; flush(); }, ms || 0);
  }
  function flush() {
    if (flushing) return flushing;
    if (!session || !session.token) return Promise.resolve({ sent: 0, failed: 0, remaining: state.pending });
    flushing = withSendLock(sendAll).then(function (r) { return r || { sent: 0, failed: 0, remaining: state.pending, busy: true }; })
      .catch(function (e) { console.warn('[ISSApi] sync failed', e); return { sent: 0, failed: 0, remaining: state.pending, error: e.message }; })
      .finally(function () { flushing = null; setState({ syncing: false }); });
    return flushing;
  }
  function sendAll() {
    return loadOutbox().then(function () {
      var me = session && session.email, token = session && session.token;
      var items = outboxMem.filter(function (i) { return i.user === me && i.status === 'pending'; });
      var summary = { sent: 0, failed: 0, attention: 0, remaining: 0, results: [] };
      if (!items.length) return summary;
      setState({ syncing: true });
      var idx = 0;
      function next() {
        if (idx >= items.length || !session || session.email !== me) return finish();
        var item = items[idx++];
        item.attempts = (item.attempts || 0) + 1; item.lastTriedAt = Date.now();
        var params = Object.assign({}, item.params, { token: token });
        return remote(item.fn, params, timeoutFor(item.fn)).then(function (result) {
          markOnline();
          if (result && result.success === false) {
            item.status = 'failed'; item.lastError = result.message || 'The server did not accept this change.';
            summary.failed++;
            return saveItem(item).then(next);
          }
          var blocked = result && Array.isArray(result.blocked) ? result.blocked : [];
          if (blocked.length) {
            item.status = 'attention';
            item.lastError = (result.message || 'Saved with warnings.') + ' — ' + blocked.map(function (b) { return b.name + ': ' + b.reason; }).join('; ');
            summary.attention++;
            return saveItem(item).then(function () { return remember(item, result); }).then(next);
          }
          summary.sent++; summary.results.push({ label: item.label, result: result });
          return removeItem(item.id).then(function () { return remember(item, result); }).then(next);
        }, function (err) {
          if (err && (err.offline || err.transient)) {          // connection lost or server hiccup: keep it, stop for now
            item.lastError = err.message; markUnreachable(err.kind);
            return saveItem(item).then(finish);
          }
          if (/Session expired|Not authenticated/i.test(err && err.message)) {
            item.lastError = 'Waiting for you to sign in again.';
            return saveItem(item).then(function () { emit('auth-required'); return finish(); });
          }
          item.status = 'failed'; item.lastError = (err && err.message) || 'The server did not accept this change.';
          summary.failed++;
          return saveItem(item).then(next);
        });
      }
      function finish() {
        summary.remaining = outboxMem.filter(function (i) { return i.user === me && i.status === 'pending'; }).length;
        if (summary.sent || summary.attention) {
          state.lastSync = Date.now();
          store.put('meta', { key: 'lastSync:' + me, value: state.lastSync }).catch(function () {});
        }
        emit('synced', summary);
        return summary;
      }
      return next();
    });
  }
  function remember(item, result) {
    var key = 'history:' + item.user;
    return store.get('meta', key).then(function (row) {
      var list = (row && row.value) || [];
      list.unshift({ label: item.label, fn: item.fn, at: Date.now(), message: (result && result.message) || 'Sent',
                     ref: result && (result.receiptNumber || result.voucherNumber) || '' });
      return store.put('meta', { key: key, value: list.slice(0, 40) });
    }).catch(function () {});
  }

  /* ------------------------------------------------------------- the call */
  function call(fn, params) {
    params = params || {};
    var rule = QUEUE[fn];
    if (rule && rule.idem && !params.idempotencyKey) params.idempotencyKey = 'idem_' + uid();
    if (rule && rule.stamp) rule.stamp(params);
    var read = isRead(fn);
    var knownOffline = global.navigator && navigator.onLine === false;

    function onNetworkFailure(err) {
      markUnreachable(err.kind);
      if (read && !NO_CACHE[fn]) return fromCache(fn, params, { kind: state.network });
      if (rule) return enqueue(fn, params);
      if (err.kind === 'timeout' && !read) {
        throw makeError('The server took too long to answer. The change may still have been saved — please check before trying again.', { offline: true, kind: 'timeout' });
      }
      throw offlineError(fn, err.kind);
    }

    if (knownOffline) return ready.then(function () { return onNetworkFailure({ kind: 'network' }); });

    // Older changes waiting in the outbox go first, so a newer change made
    // online can never be overwritten by an older one sent later.
    var before = (!read && !NO_FLUSH_FIRST[fn] && state.pending > 0) ? flush() : Promise.resolve();
    return before.then(function () {
      return remote(fn, params, timeoutFor(fn));
    }).then(function (result) {
      if (fn !== 'logoutUser') markOnline();
      if (read) { cachePut(fn, params, result); return overlay(fn, params, clone(result)); }
      return result;
    }, function (err) {
      if (err && err.offline) return onNetworkFailure(err);
      throw err;
    });
  }

  /* ------------------------------------------------------------- prefetch */
  // Keeps an up-to-date offline copy of the screens people use every day.
  function prefetch(list, force) {
    if (!session || state.network !== 'online' || !PREFETCH_MIN) return Promise.resolve(false);
    var conn = global.navigator && navigator.connection;
    if (conn && conn.saveData && !force) return Promise.resolve(false);
    var me = session.email, key = 'prefetch:' + me;
    return store.get('meta', key).then(function (row) {
      if (!force && row && Date.now() - row.value < PREFETCH_MIN * 60000) return false;
      return store.put('meta', { key: key, value: Date.now() }).then(function () {
        var i = 0;
        function step() {
          if (i >= list.length || !session || session.email !== me || state.network !== 'online') return true;
          var job = list[i++];
          return call(job[0], Object.assign({ token: session.token }, job[1] || {})).then(step, step);
        }
        return step();
      });
    }).catch(function () { return false; });
  }

  /* ----------------------------------------------------------- public API */
  var api = {
    call: call,
    on: on,
    flush: flush,
    ping: ping,
    prefetch: prefetch,
    status: function () { return clone(state); },
    isConfigured: function () { return hasGsr() || !!API_URL; },
    isQueueable: function (fn) { return !!QUEUE[fn]; },
    pendingCount: function () { return state.pending; },
    describeStudent: null,
    nsSuffix: NS,          // appended to every name this copy stores on the device
    setSession: function (s) {
      session = s && s.email && s.token ? { email: String(s.email).toLowerCase(), token: s.token } : null;
      recount();
      if (session) {
        store.get('meta', 'lastSync:' + session.email).then(function (r) { if (r) setState({ lastSync: r.value }); }).catch(function () {});
        if (state.pending) scheduleFlush(800);
      }
    },
    outbox: function () {
      return loadOutbox().then(function (all) { return session ? all.filter(function (i) { return i.user === session.email; }) : []; });
    },
    otherUsersPending: function () {
      return outboxMem.filter(function (i) { return (!session || i.user !== session.email) && i.status === 'pending'; }).length;
    },
    history: function () {
      if (!session) return Promise.resolve([]);
      return store.get('meta', 'history:' + session.email).then(function (r) { return (r && r.value) || []; }).catch(function () { return []; });
    },
    retry: function (id) {
      var it = outboxMem.filter(function (x) { return x.id === id; })[0];
      if (!it) return Promise.resolve();
      it.status = 'pending'; it.lastError = '';
      return saveItem(it).then(function () { return flush(); });
    },
    discard: function (id) { return removeItem(id); },
    exportOutbox: function () {
      return api.outbox().then(function (items) {
        return JSON.stringify({ exportedAt: new Date().toISOString(), user: session && session.email, app: 'iSmartSchool', items: items }, null, 2);
      });
    },
    clearUserCache: clearUserCache,
    clearAllCache: clearAllCache,
    storageInfo: function () {
      var est = global.navigator && navigator.storage && navigator.storage.estimate ? navigator.storage.estimate() : Promise.resolve(null);
      var per = global.navigator && navigator.storage && navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(false);
      return Promise.all([est, per, ready.then(function () { return store.all('cache'); }).catch(function () { return []; })]).then(function (r) {
        var mine = session ? r[2].filter(function (e) { return e.user === session.email; }) : [];
        var oldest = mine.reduce(function (m, e) { return Math.min(m, e.savedAt || Infinity); }, Infinity);
        return { usage: r[0] && r[0].usage, quota: r[0] && r[0].quota, persisted: !!r[1], savedScreens: mine.length,
                 oldest: isFinite(oldest) ? oldest : null, deviceStorage: store.persistent };
      });
    },
    requestPersistentStorage: function () {
      try { if (navigator.storage && navigator.storage.persist) return navigator.storage.persist(); } catch (e) {}
      return Promise.resolve(false);
    }
  };

  ready.then(function () { setState({ persistent: store.persistent }); loadOutbox(); purgeOldCache();
    // After every script on the page has run, so it can see which app.js is loaded.
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', removeSharedLegacyData); else removeSharedLegacyData();
  });

  // Versions before per-school storage kept everything in one shared
  // database and one shared sign-in slot. Remove them so no school's data
  // lingers where another school's copy could read it. A database that
  // still holds unsent changes is kept (and reported) rather than lost.
  function removeSharedLegacyData() {
    if (!NS) return;
    // An older app.js (uploaded without the matching api.js) still keeps its
    // sign-in here: leave it alone rather than sign the user out on every load.
    if (global.App && App._SESSION_KEY === 'iss-session') { console.warn('[ISSApi] app.js is older than api.js — upload the matching app.js.'); return; }
    try { localStorage.removeItem('iss-session'); sessionStorage.removeItem('iss-session'); } catch (e) {}
    if (!global.indexedDB || !indexedDB.databases) return;
    indexedDB.databases().then(function (list) {
      if (!list.some(function (d) { return d.name === 'iss-offline'; })) return;
      var req = indexedDB.open('iss-offline');
      req.onsuccess = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('outbox')) { db.close(); indexedDB.deleteDatabase('iss-offline'); return; }
        var c = db.transaction('outbox', 'readonly').objectStore('outbox').count();
        c.onsuccess = function () {
          db.close();
          if (c.result === 0) indexedDB.deleteDatabase('iss-offline');
          else console.warn('[ISSApi] An older shared offline database still holds ' + c.result + ' unsent change(s); it was kept.');
        };
      };
    }).catch(function () {});
  }
  if (state.network === 'offline') startRetryLoop();

  // The service worker asks open pages to send the outbox (Background Sync).
  if (global.navigator && navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', function (ev) {
      if (ev.data && ev.data.type === 'FLUSH_OUTBOX') { if (state.network === 'online') flush(); else ping(); }
    });
  }
  // Retry pending changes every minute while online (covers brief server hiccups).
  setInterval(function () { if (state.network === 'online' && state.pending && !flushing) flush(); }, 60000);

  global.ISSApi = api;
})(window);
