// ========================================================================
// iSmartSchool – Backend (Google Apps Script)
// ------------------------------------------------------------------------
// Files in this project:  Code.gs (this file) · CanteenModule.gs · PayrollModule.gs · Api.gs · Maintenance.gs · Index.html
//
// Built to stay fast as data grows:
//  • Student photos are never read except for the report cards being printed
//    (and are cached for 6 hours); every other screen skips that column.
//  • Batch saves grow the sheet first, so they never fail when a sheet runs
//    out of rows; deletes never trip the "all rows" rule.
//  • Attendance reads only the columns it needs and writes only changed rows.
//  • Bulk report cards are fetched one class at a time, with the school
//    crest sent once instead of inside every card.
//  • Settings → Data: capacity check against Google's 10-million-cell
//    limit, Compact (removes empty cells) and Archive (moves closed terms
//    to a separate archive spreadsheet, carrying canteen balances forward).
// ========================================================================
const CONFIG = {
  SPREADSHEET_ID: '',
  SCHOOL_NAME: 'GHANA BASIC SCHOOL',
  SCHOOL_MOTTO: 'Knowledge, Discipline, Excellence',
  SCHOOL_ADDRESS: 'P.O. Box 277, Kpalugu, Binduri, UER-Ghana',
  SCHOOL_EMAIL: 'edenpeakacademy@gmail.com',
  SCHOOL_PHONE: '+233 246 280 377',
  CURRENT_TERM: 3,
  CURRENT_ACADEMIC_YEAR: '2025/2026',
  CLASS_SCORE_WEIGHT: 30,
  EXAM_SCORE_WEIGHT: 70,
  TERM_DAYS: 60,
  TOKEN_EXPIRY_HOURS: 24,          // a session ends after this long WITHOUT use (it renews itself while used)
  REMEMBER_EXPIRY_HOURS: 168,      // "Keep me signed in" devices: 7 days without use, so offline weekends survive
  SESSION_MAX_DAYS: 30,            // every session ends this long after sign-in, however much it is used
  HASH_ITERATIONS: 10000,
  MAX_LOGIN_ATTEMPTS: 5,       // failed logins before a temporary lock
  LOGIN_LOCK_MINUTES: 15,
  MIN_PASSWORD_LENGTH: 8,      // new passwords (existing ones keep working)
  MAX_BACKDATE_DAYS: 60,       // canteen payments synced late may be dated at most this far back
  MAX_REQUEST_CHARS: 8000000,  // largest request body the API will read
  MAX_IMAGE_CHARS: 49000,      // a Sheets cell holds max 50,000 characters
  ALLOW_IFRAME_EMBED: false    // set true ONLY if you embed the app in Google Sites
};
const ATTENDANCE_STATUSES = ['Present', 'Absent'];

// ==================== REQUEST-SCOPED CACHES ====================
let _ssCache = null;
let _tzCache = null;
let _settingsCache = null;
let _studentsCache = null;
let _studentsIndex = null;
let _lockDepth = 0;   // re-entrancy counter for withScriptLock_
let _studentsTable = null;
let _classesCache = null;
let _tokenRenewed = false;   // a session is renewed at most once per request

function clearRequestCache_() {
  _tokenRenewed = false;
  _ssCache = null;
  _tzCache = null;
  _settingsCache = null;
  _studentsCache = null;
  _studentsIndex = null;
  _studentsTable = null;
  _classesCache = null;
}

// ==================== SMALL HELPERS ====================
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;

function getSpreadsheet_() {
  if (_ssCache) return _ssCache;
  if (CONFIG.SPREADSHEET_ID) {
    try { _ssCache = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID); return _ssCache; } catch (e) {}
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('No active spreadsheet');
  CONFIG.SPREADSHEET_ID = ss.getId();
  _ssCache = ss;
  return _ssCache;
}
function getTz_() {
  if (!_tzCache) _tzCache = getSpreadsheet_().getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  return _tzCache;
}
// Formats a sheet Date in the SPREADSHEET's timezone. toISOString() is UTC
// and shifts dates by a day in any timezone ahead of UTC.
function fmtDate_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, getTz_(), 'yyyy-MM-dd');
  return v === null || v === undefined ? '' : v;
}
function todayStr_() { return Utilities.formatDate(new Date(), getTz_(), 'yyyy-MM-dd'); }
// Parses 'YYYY-MM-DD' as a LOCAL date (new Date('YYYY-MM-DD') is UTC midnight).
function parseYMD_(s) {
  if (s instanceof Date) return new Date(s.getTime());
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function parseSheetDate_(val) {
  if (!val && val !== 0) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  if (typeof val === 'number' && val > 0) return new Date((val - 25569) * 86400000);
  if (typeof val === 'string' && val.trim() !== '') return parseYMD_(val.trim());
  return null;
}
// Values like "0244123456" lose their leading zero when written back to a
// sheet unless prefixed with an apostrophe.
function textCell_(v) {
  const s = (v === null || v === undefined) ? '' : String(v).replace(/^'/, '').trim();
  return s ? "'" + s : '';
}
// Strips characters that would break the pipe-delimited user records.
function sanitize_(s) { return String(s === null || s === undefined ? '' : s).replace(/[|\r\n\t]/g, ' ').trim(); }
// A sign-in name: a plain username (3-30 letters, numbers, dot, dash, underscore, starting with a letter or
// number) or, for accounts created earlier, an e-mail address. Always compared in lower case.
function isValidUsername_(u) {
  const t = String(u || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{2,29}$/.test(t) || (t.length <= 80 && isValidEmail_(t));
}
const USERNAME_HELP_ = 'Please enter a username of 3–30 letters, numbers, dots, dashes or underscores (for example kofi.mensah).';
function isValidEmail_(e) { return /^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/.test(String(e || '')); }
function isActiveStatus_(status) {
  const s = String(status || '').trim().toLowerCase();
  return s !== 'inactive' && s !== 'graduated';
}
function numSetting_(key, def) {
  const n = parseFloat(getSetting_(key));
  return isNaN(n) ? def : n;
}
function getWeights_() {
  return { classWeight: numSetting_('ClassScoreWeight', CONFIG.CLASS_SCORE_WEIGHT),
           examWeight:  numSetting_('ExamScoreWeight',  CONFIG.EXAM_SCORE_WEIGHT) };
}
// Deletes 1-based row numbers in as few API calls as possible (contiguous runs).
// Google refuses to delete every non-frozen row of a sheet, so a spare blank
// row is added first when a delete would empty the sheet.
function deleteRowsGrouped_(sh, rowNumbers) {
  if (!rowNumbers || !rowNumbers.length) return 0;
  const rows = Array.from(new Set(rowNumbers)).sort((a, b) => b - a);
  const maxRows = sh.getMaxRows();
  if (maxRows - rows.length <= sh.getFrozenRows()) sh.insertRowsAfter(maxRows, 1);
  let i = 0;
  while (i < rows.length) {
    let end = rows[i], start = end;
    while (i + 1 < rows.length && rows[i + 1] === start - 1) { i++; start = rows[i]; }
    sh.deleteRows(start, end - start + 1);
    i++;
  }
  return rows.length;
}
function deleteRowSafe_(sh, rowNumber) { return deleteRowsGrouped_(sh, [rowNumber]); }
// ---- Reading big sheets without loading them -------------------------------
// 1-based row numbers (sorted) whose cell in column `col` equals `text`,
// found by a server-side text search instead of reading the column.
function findRowNumbers_(sh, col, text) {
  const last = sh ? sh.getLastRow() : 0;
  if (last < 2 || text === '' || text === null || text === undefined) return [];
  return sh.getRange(2, col, last - 1, 1).createTextFinder(String(text)).matchEntireCell(true).findAll()
    .map(r => r.getRow()).sort((a, b) => a - b);
}
// The full rows (first `width` columns) for the given row numbers: contiguous runs are read in
// one call each; if the rows are very scattered, one block covering them is read instead.
function readRowsByNumber_(sh, rowNumbers, width) {
  if (!rowNumbers.length) return [];
  const runs = [];
  let i = 0;
  while (i < rowNumbers.length) {
    let j = i;
    while (j + 1 < rowNumbers.length && rowNumbers[j + 1] === rowNumbers[j] + 1) j++;
    runs.push([rowNumbers[i], rowNumbers[j]]);
    i = j + 1;
  }
  const out = [];
  if (runs.length > 25) {
    const lo = rowNumbers[0], hi = rowNumbers[rowNumbers.length - 1];
    const want = new Set(rowNumbers);
    sh.getRange(lo, 1, hi - lo + 1, width).getValues().forEach((v, k) => { if (want.has(lo + k)) out.push({ row: lo + k, values: v }); });
    return out;
  }
  runs.forEach(([a, b]) => sh.getRange(a, 1, b - a + 1, width).getValues().forEach((v, k) => out.push({ row: a + k, values: v })));
  return out;
}
// Rows (first `width` columns) for which pred(probeValues) is true, where the test only needs a
// few neighbouring columns (firstCol..firstCol+numCols-1): those are read for every row, but the
// other columns only for the rows that match.
function readRowsWhere_(sh, firstCol, numCols, pred, width) {
  const n = sh ? sh.getLastRow() - 1 : 0;
  if (n < 1) return [];
  const probe = sh.getRange(2, firstCol, n, numCols).getValues();
  const rows = [];
  for (let i = 0; i < n; i++) if (pred(probe[i])) rows.push(i + 2);
  return readRowsByNumber_(sh, rows, width).map(x => x.values);
}
// Appends many rows in ONE write. A sheet only has as many rows as it was
// given (1,000 by default); writing past the end can be refused, so the
// sheet is grown first.
// ---- Formula safety -------------------------------------------------------------
// Text people type or upload (names, notes, descriptions) must never be run as a spreadsheet formula
// when it is written to a sheet. Anything starting with =, @ (or +/- followed by more than a number) is
// stored as plain text: a leading apostrophe, which Sheets hides. Phone cells already use this.
function fxCell_(v) {
  if (typeof v !== 'string' || !v) return v;
  const c = v.charAt(0);
  if (c === '=' || c === '@' || ((c === '+' || c === '-') && !/^[+\-]?[\d\s.,()\-+]*$/.test(v))) return "'" + v;
  return v;
}
function fxRows_(rows) { return rows.map(r => Array.isArray(r) ? r.map(fxCell_) : fxCell_(r)); }
function appendRows_(sh, rows) {
  if (!rows || !rows.length) return;
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const data = rows.map(r => r.length === width ? r : r.concat(new Array(width - r.length).fill('')));
  const start = sh.getLastRow() + 1, need = start + data.length - 1, maxRows = sh.getMaxRows();
  if (need > maxRows) sh.insertRowsAfter(maxRows, need - maxRows);
  ensureCols_(sh, width);
  sh.getRange(start, 1, data.length, width).setValues(fxRows_(data));
}
function ensureCols_(sh, n) {
  const maxCols = sh.getMaxColumns();
  if (n > maxCols) sh.insertColumnsAfter(maxCols, n - maxCols);
}
// New sheets come with 26 columns × 1,000 rows. Empty cells still count
// toward Google's 10-million-cell limit per spreadsheet, so unused columns
// are removed.
function trimColumns_(sh, keep) {
  const maxCols = sh.getMaxColumns();
  if (maxCols > keep && keep >= 1) sh.deleteColumns(keep + 1, maxCols - keep);
}
function appendAudit_(action, details, email) {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName('Audit_Log');
  if (!sh) {
    sh = ss.insertSheet('Audit_Log');
    sh.getRange(1, 1, 1, 4).setValues([['Timestamp', 'Action', 'Details', 'User']]).setFontWeight('bold');
  }
  sh.appendRow(fxRows_([[new Date().toISOString(), action, details, email || '']])[0]);
}

// ==================== RE-ENTRANT SCRIPT LOCK ====================
// Apps Script locks are not re-entrant: a helper that locked + released
// inside an already-locked section released the CALLER's lock too. Every
// locked section now goes through this wrapper, which only takes the real
// lock at the outermost level.
function withScriptLock_(timeoutMs, fn) {
  if (_lockDepth > 0) {
    _lockDepth++;
    try { return fn(); } finally { _lockDepth--; }
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(timeoutMs)) throw new Error('The system is busy with another update. Please try again in a moment.');
  _lockDepth = 1;
  try { return fn(); } finally { _lockDepth = 0; lock.releaseLock(); }
}

// ==================== SETTINGS ====================
function loadSettingsCache_() {
  if (_settingsCache) return _settingsCache;
  const sh = getSpreadsheet_().getSheetByName('Settings');
  _settingsCache = {};
  if (!sh) return _settingsCache;
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const key = data[i][0];
    // Dates MUST be strings: google.script.run refuses to return Date objects
    // (the whole response silently becomes null on the client).
    if (key) _settingsCache[key] = data[i][1] instanceof Date ? fmtDate_(data[i][1]) : data[i][1];
  }
  return _settingsCache;
}
function getSetting_(key) {
  const cache = loadSettingsCache_();
  return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
}
function setSetting_(key, value) {
  const sh = getSpreadsheet_().getSheetByName('Settings');
  if (!sh) return;
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      sh.getRange(i + 1, 2).setValue(fxCell_(value));
      if (_settingsCache) _settingsCache[key] = value;
      return;
    }
  }
  sh.appendRow([key, fxCell_(value), '']);
  if (_settingsCache) _settingsCache[key] = value;
}
function incrementSetting_(key) { return incrementSettingBatch_(key, 1); }
// Reserves `count` sequential numbers; returns the FIRST one.
function incrementSettingBatch_(key, count) {
  return withScriptLock_(60000, () => {
    const sh = getSpreadsheet_().getSheetByName('Settings');
    const data = sh.getDataRange().getValues();   // fresh read inside the lock
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === key) {
        const cur = parseInt(data[i][1], 10) || 0;
        sh.getRange(i + 1, 2).setValue(cur + count);
        if (_settingsCache) _settingsCache[key] = cur + count;
        return cur + 1;
      }
    }
    sh.appendRow([key, count, '']);
    if (_settingsCache) _settingsCache[key] = count;
    return 1;
  });
}
function syncConfig_() {
  const term = parseInt(getSetting_('CurrentTerm'), 10);
  if (term >= 1 && term <= 3) CONFIG.CURRENT_TERM = term;
  const year = getSetting_('CurrentAcademicYear');
  if (year !== null && year !== undefined && String(year).trim() !== '') CONFIG.CURRENT_ACADEMIC_YEAR = String(year).trim();
}

// ==================== HASHING ====================
function generateSalt_() { return Utilities.getUuid().replace(/-/g, ''); } // crypto-grade, unlike Math.random
function hashPassword_(password, salt) {
  if (!password || !salt) throw new Error('Password and salt required');
  const hex = bytes => bytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
  let hash = hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password + salt));
  for (let i = 1; i < CONFIG.HASH_ITERATIONS; i++) {
    hash = hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, hash + password));
  }
  return hash;
}
function generatePasswordHash_(password) {
  const salt = generateSalt_();
  return salt + ':' + hashPassword_(password, salt);
}
function verifyPassword_(password, stored) {
  if (!password || !stored || typeof stored !== 'string' || stored.indexOf(':') < 0) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  return hashPassword_(password, salt) === hash;
}

// ==================== AUTH CORE ====================
function getUsers_() {
  const cache = loadSettingsCache_();
  const users = [];
  Object.keys(cache).forEach(key => {
    if (key.startsWith('User_')) {
      const parts = (cache[key] || '').toString().split('|');
      users.push({
        email: key.slice(5),
        role: parts[0] || '',
        name: parts[1] || key.slice(5),
        password: parts[2] || '',
        status: parts[3] || 'active'
      });
    }
  });
  return users;
}
function findUser_(email) {
  const e = String(email || '').toLowerCase().trim();
  // Trim the stored key too: an admin registered with a stray space in the
  // email could otherwise never log in.
  return getUsers_().find(u => u.email.toLowerCase().trim() === e) || null;
}
function writeUserRow_(email, user) {
  const key = 'User_' + email.toLowerCase();
  const val = `${user.role}|${sanitize_(user.name)}|${user.password}|${user.status || 'active'}`;
  setSetting_(key, val);
}
function activeAdminCount_() {
  return getUsers_().filter(u => u.role === 'Admin' && String(u.status).toLowerCase() !== 'inactive').length;
}
// Session tokens are never stored as such: the Settings sheet (visible to anyone
// the spreadsheet is shared with) holds only a SHA-256 of the token, so reading
// the sheet does not let anyone sign in as somebody else.
function sha256Hex_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s))
    .map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}
function tokenKey_(token) { return 'Token_' + sha256Hex_(token); }
// Constant-time string comparison (no early exit on the first different character).
function safeEqual_(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
// CacheService keys are limited to 250 characters, and an e-mail typed into the
// login box can be any length: use a fixed-size fingerprint instead.
function loginFailKey_(email) { return 'loginfail_' + sha256Hex_(String(email || '').toLowerCase().trim()).slice(0, 40); }
// Signs a person out everywhere (all their saved sessions), optionally keeping one.
function revokeUserTokens_(email, exceptToken) {
  const sh = getSpreadsheet_().getSheetByName('Settings');
  if (!sh) return 0;
  const target = String(email || '').toLowerCase().trim();
  const keep = exceptToken ? tokenKey_(exceptToken) : null;
  const data = sh.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const key = String(data[i][0] || '');
    if (!key.startsWith('Token_') || key === keep) continue;
    if (String(data[i][1] || '').split('|')[0].toLowerCase().trim() === target) rows.push(i + 1);
  }
  if (rows.length) { deleteRowsGrouped_(sh, rows); _settingsCache = null; }
  return rows.length;
}
function sessionHours_(remember) { return remember ? CONFIG.REMEMBER_EXPIRY_HOURS : CONFIG.TOKEN_EXPIRY_HOURS; }
// Session record: email|role|expiresISO|issuedISO|r (r = "keep me signed in").
function generateToken_(email, role, remember) {
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');   // 244 random bits
  const now = Date.now();
  const expires = new Date(now + sessionHours_(remember) * 3600 * 1000);
  const sh = getSpreadsheet_().getSheetByName('Settings');
  if (!sh) return null;
  const tokenKey = tokenKey_(token);
  const tokenVal = `${email}|${role}|${expires.toISOString()}|${new Date(now).toISOString()}|${remember ? 'r' : ''}`;
  sh.appendRow([tokenKey, tokenVal, 'Session']);
  if (_settingsCache) _settingsCache[tokenKey] = tokenVal;
  return token;
}
// Tokens were never cleaned up, so Settings grew by one row per login and
// every request slowed down. Expired tokens are now purged at login.
function purgeExpiredTokens_() {
  const sh = getSpreadsheet_().getSheetByName('Settings');
  if (!sh) return;
  const data = sh.getDataRange().getValues();
  const now = new Date();
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const key = String(data[i][0] || '');
    if (!key.startsWith('Token_')) continue;
    const exp = new Date(String(data[i][1] || '').split('|')[2]);
    if (isNaN(exp.getTime()) || exp < now) rows.push(i + 1);
  }
  if (rows.length) { deleteRowsGrouped_(sh, rows); _settingsCache = null; }
}
function _deleteSettingsRow_(key) {
  const sh = getSpreadsheet_().getSheetByName('Settings');
  if (!sh) return;
  const data = sh.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === key) {
      deleteRowSafe_(sh, i + 1);
      if (_settingsCache) delete _settingsCache[key];
      return;
    }
  }
}
// The role is taken from the CURRENT user record, not the token, so a
// demotion, deactivation or deletion takes effect immediately.
function validateToken_(token) {
  if (!token) return null;
  const cache = loadSettingsCache_();
  const tokenKey = tokenKey_(token);
  const raw = cache[tokenKey];
  if (!raw) return null;
  const parts = raw.toString().split('|');
  if (parts.length < 3) return null;
  const expiry = new Date(parts[2]);
  if (isNaN(expiry.getTime()) || new Date() > expiry) { _deleteSettingsRow_(tokenKey); return null; }
  const email = parts[0].toLowerCase();
  const userRaw = cache['User_' + email];
  if (!userRaw) { _deleteSettingsRow_(tokenKey); return null; }               // user deleted
  const u = userRaw.toString().split('|');
  if ((u[3] || 'active').toLowerCase() === 'inactive') { _deleteSettingsRow_(tokenKey); return null; }
  maybeRenewToken_(tokenKey, parts, expiry);
  return { email, role: u[0] || parts[1], name: u[1] || email };
}
// Sliding sessions: a session in use is extended once less than half of its
// window is left, up to SESSION_MAX_DAYS after sign-in. Done at most once per
// request, under a short lock (skipped if the lock is busy: it is retried on a
// later request), re-reading the row so a concurrent delete can never cause a
// write to the wrong row.
function maybeRenewToken_(tokenKey, parts, expiry) {
  if (_tokenRenewed) return;
  const remember = parts[4] === 'r';
  const windowMs = sessionHours_(remember) * 3600 * 1000, now = Date.now();
  if (expiry.getTime() - now > windowMs / 2) return;
  const issuedRaw = Date.parse(parts[3] || '');
  const issued = isNaN(issuedRaw) ? expiry.getTime() - windowMs : issuedRaw;
  const cap = issued + CONFIG.SESSION_MAX_DAYS * 86400000;
  const next = Math.min(now + windowMs, cap);
  if (next <= expiry.getTime() + 60000) return;
  _tokenRenewed = true;
  try {
    withScriptLock_(1500, () => {
      const sh = getSpreadsheet_().getSheetByName('Settings');
      if (!sh || sh.getLastRow() < 2) return;
      const hit = sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(tokenKey).matchEntireCell(true).findNext();
      if (!hit) return;
      const val = [parts[0], parts[1], new Date(next).toISOString(), new Date(issued).toISOString(), remember ? 'r' : ''].join('|');
      sh.getRange(hit.getRow(), 2).setValue(val);
      if (_settingsCache) _settingsCache[tokenKey] = val;
    });
  } catch (e) { /* busy: renewed on a later request */ }
}
function requireRole(token, allowedRoles) {
  if (!token) throw new Error('Not authenticated');
  const user = validateToken_(token);
  if (!user) throw new Error('Session expired');
  if (!allowedRoles.includes(user.role)) throw new Error('Permission denied');
  return user;
}

// ==================== STUDENT DATA ====================
function rowToStudent_(headers, row) {
  const obj = {};
  headers.forEach((h, idx) => {
    let v = row[idx];
    if (v instanceof Date) v = fmtDate_(v);
    obj[h] = (v !== null && v !== undefined) ? v : '';
  });
  if (obj.StudentID !== undefined) obj.StudentID = String(obj.StudentID).trim();
  return obj;
}
// Reads the Students sheet ONCE per request, WITHOUT the PhotoURL column.
// Photos are stored as text of up to ~49,000 characters each; reading them
// on every request made every screen slower as more photos were added.
// The photo cell in the returned rows is always ''. Use getStudentPhotos_()
// when a photo is actually needed (report cards).
function readStudentsTable_() {
  if (_studentsTable) return _studentsTable;
  const sh = getSpreadsheet_().getSheetByName('Students');
  if (!sh) return null;
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return null;
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const p = headers.indexOf('PhotoURL');
  const data = [headers];
  const n = lastRow - 1;
  if (n > 0) {
    if (p < 0) {
      sh.getRange(2, 1, n, lastCol).getValues().forEach(r => data.push(r));
    } else {
      const left = p > 0 ? sh.getRange(2, 1, n, p).getValues() : null;
      const right = p < lastCol - 1 ? sh.getRange(2, p + 2, n, lastCol - p - 1).getValues() : null;
      for (let i = 0; i < n; i++) data.push((left ? left[i] : []).concat([''], right ? right[i] : []));
    }
  }
  _studentsTable = { sh, headers, data, photoIdx: p };
  return _studentsTable;
}
// Writes one full student row back WITHOUT touching the photo cell.
function writeStudentRow_(t, rowIndex, row) {
  row = fxRows_([row])[0];
  const r = rowIndex + 1, p = t.photoIdx;
  if (p < 0) { t.sh.getRange(r, 1, 1, row.length).setValues([row]); return; }
  if (p > 0) t.sh.getRange(r, 1, 1, p).setValues([row.slice(0, p)]);
  if (p < row.length - 1) t.sh.getRange(r, p + 2, 1, row.length - p - 1).setValues([row.slice(p + 1)]);
}
// Photos for the given student IDs only. Reads just the rows needed
// (grouped into contiguous blocks), never the whole photo column.
function getStudentPhotos_(ids) {
  const t = readStudentsTable_();
  const out = {};
  if (!t || t.photoIdx < 0 || !ids || !ids.size) return out;
  let rows = [];
  for (let i = 1; i < t.data.length; i++) {
    const sid = String(t.data[i][0] || '').trim();
    if (ids.has(sid)) rows.push({ row: i + 1, sid });
  }
  if (!rows.length) return out;
  // Photos rarely change: keep them in the script cache for 6 hours so a
  // reprint fetches them in one call instead of one sheet read per student.
  let cache = null, cached = {};
  try { cache = CacheService.getScriptCache(); cached = cache.getAll(rows.map(r => 'photo_' + r.sid)) || {}; } catch (e) { cache = null; }
  rows.forEach(r => { const v = cached['photo_' + r.sid]; if (v && v !== '-') out[r.sid] = v; });
  const missing = rows.filter(r => cached['photo_' + r.sid] === undefined);
  const remember = () => {
    if (!cache) return;
    for (let k = 0; k < missing.length; k += 20) {
      const batch = {};
      missing.slice(k, k + 20).forEach(r => { batch['photo_' + r.sid] = out[r.sid] || '-'; });
      try { cache.putAll(batch, 21600); } catch (e) { /* cache full — fine */ }
    }
  };
  if (!missing.length) return out;
  rows = missing;
  if (rows.length > 150) {           // many students: one column read is cheaper
    const col = t.sh.getRange(2, t.photoIdx + 1, t.data.length - 1, 1).getValues();
    rows.forEach(r => { const v = col[r.row - 2][0]; if (v) out[r.sid] = String(v); });
    remember();
    return out;
  }
  let i = 0;
  while (i < rows.length) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1].row === rows[j].row + 1) j++;
    const vals = t.sh.getRange(rows[i].row, t.photoIdx + 1, j - i + 1, 1).getValues();
    for (let k = i; k <= j; k++) { const v = vals[k - i][0]; if (v) out[rows[k].sid] = String(v); }
    i = j + 1;
  }
  remember();
  return out;
}
// Active students only, cached for the request, O(1) lookup by ID.
function loadStudents_() {
  if (_studentsCache) return _studentsCache;
  _studentsCache = []; _studentsIndex = {};
  const t = readStudentsTable_();
  if (!t) return _studentsCache;
  const statusIdx = t.headers.indexOf('Status');
  for (let i = 1; i < t.data.length; i++) {
    const row = t.data[i];
    if (!row[0] || !row[0].toString().trim()) continue;
    if (statusIdx >= 0 && !isActiveStatus_(row[statusIdx])) continue;
    const obj = rowToStudent_(t.headers, row);
    _studentsCache.push(obj);
    _studentsIndex[obj.StudentID] = obj;
  }
  return _studentsCache;
}
function getStudentByIdDirect_(sid) {
  loadStudents_();
  return _studentsIndex[String(sid || '').trim()] || null;
}
// Finds a student regardless of status (graduates can still pay arrears).
function findStudentRecord_(sid) {
  const t = readStudentsTable_();
  if (!t) return null;
  const target = String(sid || '').trim();
  for (let i = 1; i < t.data.length; i++) {
    if (t.data[i][0] && t.data[i][0].toString().trim() === target) {
      return { sheet: t.sh, table: t, data: t.data, headers: t.headers, rowIndex: i, student: rowToStudent_(t.headers, t.data[i]) };
    }
  }
  return null;
}

// ==================== NEXT IDs ====================
function formatStudentID_(num) {
  // The prefix is a setting (Settings sheet → StudentIdPrefix, letters/digits). 'EPA' is kept
  // as the default so existing numbering continues unchanged.
  const raw = String(getSetting_('StudentIdPrefix') || 'EPA').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return `${raw || 'EPA'}/${CONFIG.CURRENT_ACADEMIC_YEAR.slice(-2)}/${num.toString().padStart(3, '0')}`;
}
function getNextStudentID_() { syncConfig_(); return formatStudentID_(incrementSetting_('LastStudentID')); }
function getNextReceiptNumber_() {
  syncConfig_();
  const num = incrementSetting_('LastReceiptNumber');
  return `RCP/${CONFIG.CURRENT_ACADEMIC_YEAR.replace('/', '')}/${num.toString().padStart(4, '0')}`;
}
function getNextVoucherNumber_() {
  const num = incrementSetting_('LastVoucherNumber');
  return `VCH/${new Date().getFullYear()}/${num.toString().padStart(4, '0')}`;
}

// ==================== DATABASE SCHEMA ====================
function createDatabaseSchema_() {
  const ss = getSpreadsheet_();
  const existing = ss.getSheets().map(s => s.getName());
  const createSheet = (name, headers) => {
    if (existing.includes(name)) return ss.getSheetByName(name);
    const sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#006B3F').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
    trimColumns_(sh, headers.length);
    return sh;
  };
  const students = createSheet('Students', [
    'StudentID','FullName','Gender','DateOfBirth','Class','AdmissionDate',
    'ResidentialAddress','ParentName','ParentMoMo','EmergencyContact',
    'PreviousSchool','MedicalConditions','Status','Scholarship','PhotoURL',
    'RolloverBalance','TotalFeesPaid','CreatedBy','CreatedDate'
  ]);
  // Phone columns as plain text so leading zeros survive any write.
  try { students.getRange('I:J').setNumberFormat('@'); } catch (e) {}
  createSheet('Classes', ['ClassCode','ClassName','Category']);
  createSheet('Subjects', ['ClassCategory','SubjectName']);
  createSheet('Fee_Items', ['ClassCode','Term','AcademicYear','FeeComponent','Amount']);
  createSheet('Fees_Ledger', ['TransactionID','StudentID','StudentName','Class','Term','AcademicYear','FeeType','AmountDue','AmountPaid','Balance','PaymentDate','PaymentMethod','MoMoTransactionID','ReceiptNumber','Status','Notes','IdempotencyKey']);
  createSheet('Results_Entry', ['EntryID','StudentID','StudentName','Class','Term','AcademicYear','Subject','ClassScore','ExamScore','Total','Grade']);
  createSheet('Attendance', ['AttendanceID','StudentID','StudentName','Class','Date','Status','Term','AcademicYear']);
  createSheet('Expenses', ['ExpenseID','Date','Description','Category','Amount(GH₵)','PaidBy','VoucherNumber','RecordedBy','Notes','Term','AcademicYear','IdempotencyKey']);
  createSheet('Conduct_Records', ['StudentID','StudentName','Class','Term','AcademicYear','Conduct','UpdatedBy','UpdatedDate']);
  let sh = ss.getSheetByName('Settings');
  if (!sh) {
    sh = ss.insertSheet('Settings');
    sh.getRange(1, 1, 1, 3).setValues([['Key','Value','Description']])
      .setFontWeight('bold').setBackground('#006B3F').setFontColor('#FFFFFF');
    sh.getRange(2, 1, 13, 3).setValues([
      ['SchoolName', CONFIG.SCHOOL_NAME, ''], ['SchoolMotto', CONFIG.SCHOOL_MOTTO, ''],
      ['SchoolAddress', CONFIG.SCHOOL_ADDRESS, ''], ['SchoolEmail', CONFIG.SCHOOL_EMAIL, ''],
      ['SchoolPhone', CONFIG.SCHOOL_PHONE, ''], ['CurrentTerm', CONFIG.CURRENT_TERM, ''],
      ['CurrentAcademicYear', CONFIG.CURRENT_ACADEMIC_YEAR, ''], ['LastStudentID', 0, ''],
      ['LastReceiptNumber', 0, ''], ['LastVoucherNumber', 0, ''], ['TermDays', CONFIG.TERM_DAYS, ''],
      ['ClassScoreWeight', CONFIG.CLASS_SCORE_WEIGHT, ''], ['ExamScoreWeight', CONFIG.EXAM_SCORE_WEIGHT, '']
    ]);
    // Academic year like 2025/2026 must stay text.
    sh.getRange('B:B').setNumberFormat('@');
  }
  const defaults = {
    SchoolCrest: '', LastStudentID: 0, LastReceiptNumber: 0, LastVoucherNumber: 0,
    TermDays: CONFIG.TERM_DAYS, ClassScoreWeight: CONFIG.CLASS_SCORE_WEIGHT,
    ExamScoreWeight: CONFIG.EXAM_SCORE_WEIGHT, NextTermBegins: ''
  };
  const existingKeys = sh.getDataRange().getValues().slice(1).map(r => r[0]);
  const rows = Object.keys(defaults).filter(k => !existingKeys.includes(k)).map(k => [k, defaults[k], '']);
  if (rows.length) appendRows_(sh, rows);
  _settingsCache = null;
}
// Public: allowed during first-time setup, otherwise Admin only.
function createDatabaseSchema(params) {
  clearRequestCache_();
  try {
    if (!needsFirstTimeSetup()) requireRole((params || {}).token, ['Admin']);
    createDatabaseSchema_();
    const ss = getSpreadsheet_();
    const classesSh = ss.getSheetByName('Classes');
    if (classesSh && classesSh.getLastRow() <= 1) {
      classesSh.getRange(2, 1, 13, 3).setValues([
        ['N1','Nursery 1','Nursery'], ['N2','Nursery 2','Nursery'],
        ['KG1','Kindergarten 1','KG'], ['KG2','Kindergarten 2','KG'],
        ['B1','Basic 1','Lower Primary'], ['B2','Basic 2','Lower Primary'], ['B3','Basic 3','Lower Primary'],
        ['B4','Basic 4','Upper Primary'], ['B5','Basic 5','Upper Primary'], ['B6','Basic 6','Upper Primary'],
        ['B7','Basic 7','JHS'], ['B8','Basic 8','JHS'], ['B9','Basic 9','JHS']
      ]);
    }
    const subjectsSh = ss.getSheetByName('Subjects');
    if (subjectsSh && subjectsSh.getLastRow() <= 1) {
      const subs = [
        ['Nursery','Language & Literacy'],['Nursery','Numeracy'],['Nursery','Creative Arts'],['Nursery','Physical Development'],
        ['KG','Language & Literacy'],['KG','Numeracy'],['KG','Creative Arts'],['KG','Physical Development'],
        ['Lower Primary','Numeracy'],['Lower Primary','Literacy (English)'],['Lower Primary','Literacy (Ghanaian Lang.)'],
        ['Lower Primary','Creative Arts'],['Lower Primary','Our World Our People'],['Lower Primary','RME'],['Lower Primary','PE'],
        ['Upper Primary','English Language'],['Upper Primary','Mathematics'],['Upper Primary','Science'],
        ['Upper Primary','Computing'],['Upper Primary','RME'],['Upper Primary','Creative Arts & Design'],
        ['Upper Primary','Career Technology'],['Upper Primary','Social Studies'],['Upper Primary','Ghanaian Language'],
        ['JHS','English Language'],['JHS','Mathematics'],['JHS','Science'],['JHS','Computing'],
        ['JHS','RME'],['JHS','Creative Arts & Design'],['JHS','Career Technology'],
        ['JHS','Social Studies'],['JHS','Ghanaian Language']
      ];
      subjectsSh.getRange(2, 1, subs.length, 2).setValues(subs);
    }
    return { success: true, message: 'Database created' };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

// ==================== AUTH FUNCTIONS ====================
// ==================== ROLES & PERMISSIONS (Settings → Roles) ====================
// Roles are defined by the Admin, not in code. Each role has a name, the
// pages its users may open and the actions they may perform. "Admin" is the
// one built-in role: it always has full access and cannot be edited or
// deleted, so the school can never be locked out.
// Stored in Settings as JSON under "Roles". The server enforces it on every
// call (requireAccess_ / requireAction_), not just the menu.
const ADMIN_ROLE = 'Admin';
const PERMISSION_PAGES = [
  { key: 'dashboard',  label: 'Dashboard' },
  { key: 'students',   label: 'Students (view list)' },
  { key: 'fees',       label: 'Fees — record payments & payment history' },
  { key: 'canteen',    label: 'Canteen — register, payments, debtors, reports' },
  { key: 'finances',   label: 'Finances — reports & statements' },
  { key: 'expenses',   label: 'Expenses — record & edit' },
  { key: 'payroll',    label: 'Payroll — staff, monthly payroll & payslips' },
  { key: 'results',    label: 'Results — score entry & broadsheet' },
  { key: 'report',     label: 'Report cards' },
  { key: 'attendance', label: 'Attendance' },
  { key: 'curriculum', label: 'Curriculum (grading scale)' },
  { key: 'promotion',  label: 'Promotion & term rollover', adminOnly: true },
  { key: 'settings',   label: 'Settings (school, users, roles, data)', adminOnly: true }
];
const PERMISSION_ACTIONS = [
  { key: 'students.edit',   label: 'Add & edit students (incl. photos, CSV upload)' },
  { key: 'students.delete', label: 'Deactivate, reactivate & delete students' },
  { key: 'fees.adjust',     label: "Change an individual student's fees" },
  { key: 'fees.reverse',    label: 'Reverse a fee payment entered by mistake' },
  { key: 'expenses.delete', label: 'Delete expenses' },
  { key: 'canteen.reverse', label: 'Canteen — reverse payments & remove meals entered by mistake' },
  { key: 'canteen.expenses.delete', label: 'Canteen — delete canteen expenses' },
  { key: 'canteen.settings', label: 'Canteen — change daily rates & credit rules (Settings tab)' },
  { key: 'payroll.pay',     label: 'Approve & pay payroll (posts to Expenses), reverse a payroll, payroll settings' }
];
const DEFAULT_ROLES = {
  Accountant: { pages: ['dashboard', 'students', 'fees', 'canteen'], actions: ['students.edit', 'fees.adjust'] },
  Teacher:    { pages: ['students', 'results', 'report', 'attendance'], actions: [] }
};
const ROLE_NAME_MAX = 30;

// Older permission keys that were split into finer ones. A role saved before the
// split keeps exactly what it could do; the old key disappears the next time
// the role is saved in Settings → Roles.
const LEGACY_ACTIONS_ = { 'canteen.void': ['canteen.reverse', 'canteen.expenses.delete'] };
function cleanRoleConfig_(cfg) {
  const pageKeys = new Set(PERMISSION_PAGES.filter(p => !p.adminOnly).map(p => p.key));
  const actionKeys = new Set(PERMISSION_ACTIONS.map(a => a.key));
  const wanted = [];
  (cfg.actions || []).forEach(k => { wanted.push(k); (LEGACY_ACTIONS_[k] || []).forEach(n => wanted.push(n)); });
  return {
    pages: PERMISSION_PAGES.map(p => p.key).filter(k => pageKeys.has(k) && (cfg.pages || []).includes(k)),
    actions: PERMISSION_ACTIONS.map(a => a.key).filter(k => actionKeys.has(k) && wanted.includes(k))
  };
}
// All non-Admin roles. Older installs had fixed Accountant/Teacher roles,
// possibly customised under "RolePermissions": those are carried over.
function getRolesMap_() {
  let roles = null;
  try { roles = JSON.parse(getSetting_('Roles') || 'null'); } catch (e) { roles = null; }
  if (roles && typeof roles === 'object' && !Array.isArray(roles)) return roles;
  roles = JSON.parse(JSON.stringify(DEFAULT_ROLES));
  try {
    const old = JSON.parse(getSetting_('RolePermissions') || '{}') || {};
    Object.keys(old).forEach(r => {
      if (!roles[r]) return;
      const pages = Array.isArray(old[r].pages) ? old[r].pages : roles[r].pages;
      const actions = Array.isArray(old[r].actions) ? old[r].actions.slice() : roles[r].actions.slice();
      if (pages.includes('fees') && !actions.includes('fees.adjust')) actions.push('fees.adjust');   // they could before
      roles[r] = { pages, actions };
    });
  } catch (e) { /* keep defaults */ }
  return roles;
}
function saveRolesMap_(roles) { setSetting_('Roles', JSON.stringify(roles)); }
function roleNames_() { return [ADMIN_ROLE].concat(Object.keys(getRolesMap_()).sort()); }
function isKnownRole_(role) { return role === ADMIN_ROLE || Object.prototype.hasOwnProperty.call(getRolesMap_(), role); }
function getRoleAccess_(role) {
  if (role === ADMIN_ROLE) return { pages: PERMISSION_PAGES.map(p => p.key), actions: PERMISSION_ACTIONS.map(a => a.key) };
  const cfg = getRolesMap_()[role];
  return cfg ? cleanRoleConfig_(cfg) : { pages: [], actions: [] };     // deleted role → no access
}
// Any signed-in user, whatever their role.
function requireUser_(token) {
  if (!token) throw new Error('Not authenticated');
  const user = validateToken_(token);
  if (!user) throw new Error('Session expired');
  return user;
}
// Allows the call if the user's role may open ANY of the given pages.
function requireAccess_(token, pages) {
  const u = requireUser_(token);
  if (u.role === ADMIN_ROLE) return u;
  const list = Array.isArray(pages) ? pages : [pages];
  if (!list.some(p => getRoleAccess_(u.role).pages.includes(p))) throw new Error('Permission denied');
  return u;
}
function requireAction_(token, action) {
  const u = requireUser_(token);
  if (u.role === ADMIN_ROLE) return u;
  if (!getRoleAccess_(u.role).actions.includes(action)) throw new Error('Permission denied');
  return u;
}
function userPayload_(u) {
  const acc = getRoleAccess_(u.role);
  return { email: u.email, role: u.role, name: u.name, allowedPages: acc.pages, permissions: acc.actions };
}
function getRolePermissions(params) {
  clearRequestCache_();
  requireRole((params || {}).token, [ADMIN_ROLE]);
  const counts = {};
  getUsers_().forEach(u => { counts[u.role] = (counts[u.role] || 0) + 1; });
  const map = getRolesMap_();
  return {
    pages: PERMISSION_PAGES, actions: PERMISSION_ACTIONS, adminUsers: counts[ADMIN_ROLE] || 0,
    roles: Object.keys(map).sort().map(name => Object.assign({ name, users: counts[name] || 0 }, cleanRoleConfig_(map[name])))
  };
}
function getRoleNames(params) {
  clearRequestCache_();
  requireRole((params || {}).token, [ADMIN_ROLE]);
  return roleNames_();
}
// Creates a role, or updates one (renaming it when `originalName` differs;
// users holding the old name move to the new one).
function saveRole(params) {
  clearRequestCache_();
  const { token, name, originalName, pages, actions } = params || {};
  const admin = requireRole(token, [ADMIN_ROLE]);
  if (/[|\r\n\t]/.test(String(name || ''))) return { success: false, message: 'Use letters, numbers, spaces and - & ( ) . only.' };
  const clean = sanitize_(name).replace(/\s+/g, ' ');
  if (!clean) return { success: false, message: 'Please give the role a name.' };
  if (clean.length > ROLE_NAME_MAX) return { success: false, message: `Role names can be at most ${ROLE_NAME_MAX} characters.` };
  if (!/^[A-Za-z0-9][A-Za-z0-9 &()'.\-]*$/.test(clean)) return { success: false, message: 'Use letters, numbers, spaces and - & ( ) . only.' };
  if (clean.toLowerCase() === ADMIN_ROLE.toLowerCase()) return { success: false, message: '"Admin" is the built-in full-access role and cannot be edited.' };
  const cfg = cleanRoleConfig_({ pages, actions });
  if (!cfg.pages.length) return { success: false, message: 'Give the role at least one page, otherwise its users cannot use the app.' };
  return withScriptLock_(30000, () => {
    const roles = getRolesMap_();
    const from = originalName ? String(originalName) : null;
    if (from && !roles[from]) return { success: false, message: 'That role no longer exists. Refresh the page.' };
    const clash = Object.keys(roles).find(r => r.toLowerCase() === clean.toLowerCase() && r !== from);
    if (clash) return { success: false, message: `A role called "${clash}" already exists.` };
    let moved = 0;
    if (from && from !== clean) {
      delete roles[from];
      getUsers_().filter(u => u.role === from).forEach(u => { u.role = clean; writeUserRow_(u.email, u); moved++; });
    }
    roles[clean] = cfg;
    saveRolesMap_(roles);
    appendAudit_('ROLE_SAVE', `${from && from !== clean ? from + ' → ' : ''}${clean}: ${JSON.stringify(cfg)}`, admin.email);
    return { success: true, name: clean, message: (from ? 'Role saved.' : `Role "${clean}" created.`) +
             (moved ? ` ${moved} user(s) moved to the new name.` : '') + ' Users see changes the next time they refresh or log in.' };
  });
}
function deleteRole(params) {
  clearRequestCache_();
  const { token, name } = params || {};
  const admin = requireRole(token, [ADMIN_ROLE]);
  return withScriptLock_(30000, () => {
    const roles = getRolesMap_();
    if (!roles[name]) return { success: false, message: 'Role not found.' };
    const users = getUsers_().filter(u => u.role === name).length;
    if (users) return { success: false, message: `${users} user(s) still have the "${name}" role. Give them another role first.` };
    delete roles[name];
    saveRolesMap_(roles);
    appendAudit_('ROLE_DELETE', name, admin.email);
    return { success: true, message: `Role "${name}" deleted.` };
  });
}
function needsFirstTimeSetup() {
  clearRequestCache_();
  return !getUsers_().some(u => u.role === 'Admin');
}
function registerFirstAdmin(params) {
  clearRequestCache_();
  const { email, password, name } = params || {};
  if (!email || !password || !name) return { success: false, message: 'Missing fields' };
  if (!isValidUsername_(email)) return { success: false, message: USERNAME_HELP_ };
  if (String(password).length < CONFIG.MIN_PASSWORD_LENGTH) return { success: false, message: `Password must be at least ${CONFIG.MIN_PASSWORD_LENGTH} characters` };
  try {
    return withScriptLock_(30000, () => {
      if (!needsFirstTimeSetup()) return { success: false, message: 'Admin already exists' };   // re-checked inside lock
      if (!getSpreadsheet_().getSheetByName('Settings')) createDatabaseSchema_();
      writeUserRow_(String(email).trim().toLowerCase(), { role: 'Admin', name, password: generatePasswordHash_(password), status: 'active' });
      return { success: true, message: 'Admin created' };
    });
  } catch (e) { return { success: false, message: e.toString() }; }
}
function loginUser(params) {
  clearRequestCache_();
  const { email, password } = params || {};
  const remember = params && (params.remember === true || params.remember === 'true');
  if (!email || !password) return { success: false, message: 'Missing credentials' };
  if (String(email).length > 120 || String(password).length > 200) return { success: false, message: 'Invalid credentials' };
  const cache = CacheService.getScriptCache();
  const failKey = loginFailKey_(email);
  const fails = parseInt(cache.get(failKey) || '0', 10);
  if (fails >= CONFIG.MAX_LOGIN_ATTEMPTS)
    return { success: false, message: `Too many failed attempts. Try again in ${CONFIG.LOGIN_LOCK_MINUTES} minutes.` };
  const fail = () => {
    cache.put(failKey, String(fails + 1), CONFIG.LOGIN_LOCK_MINUTES * 60);
    // Each further failed try for the same address waits a little longer, which makes guessing slow.
    try { Utilities.sleep(Math.min(2000, 300 * (fails + 1))); } catch (e) { /* no delay available */ }
    return { success: false, message: 'Invalid credentials' };
  };
  const user = findUser_(email);
  // The user only ever sees "Invalid credentials"; the real reason goes to
  // the Apps Script Executions log for the admin.
  if (!user) { console.warn('Login failed: no user record for ' + email); return fail(); }
  if ((user.status || '').toLowerCase() === 'inactive')
    return { success: false, message: 'Account is deactivated. Contact Admin.' };
  if (!verifyPassword_(password, user.password)) { console.warn('Login failed: wrong password for ' + email); return fail(); }
  cache.remove(failKey);
  try { purgeExpiredTokens_(); } catch (e) { console.error('Token purge failed', e); }
  const token = generateToken_(user.email, user.role, remember);
  return { success: true, token, user: userPayload_(user), sessionHours: sessionHours_(remember) };
}
function logoutUser(params) {
  clearRequestCache_();
  const { token } = params || {};
  if (token) _deleteSettingsRow_(tokenKey_(token));
  return { success: true };
}
function changePassword(params) {
  clearRequestCache_();
  const { token, currentPassword, newPassword } = params || {};
  if (!currentPassword || !newPassword) return { success: false, message: 'Missing required fields' };
  if (String(newPassword).length < CONFIG.MIN_PASSWORD_LENGTH) return { success: false, message: `Password must be at least ${CONFIG.MIN_PASSWORD_LENGTH} characters` };
  const u = requireUser_(token);
  const user = findUser_(u.email);
  if (!user) return { success: false, message: 'User not found' };
  if (!verifyPassword_(currentPassword, user.password)) return { success: false, message: 'Current password is incorrect' };
  user.password = generatePasswordHash_(newPassword);
  writeUserRow_(user.email, user);
  revokeUserTokens_(user.email, (params || {}).token);   // other devices must sign in again
  appendAudit_('PASSWORD_CHANGE', 'Password changed by the user', user.email);
  return { success: true, message: 'Password changed successfully' };
}
function addUser(params) {
  clearRequestCache_();
  const { token, email, role, name, password } = params || {};
  requireRole(token, ['Admin']);
  if (!isValidUsername_(email)) return { success: false, message: USERNAME_HELP_ };
  if (!isKnownRole_(role)) return { success: false, message: 'Please choose a valid role.' };
  if (!sanitize_(name)) return { success: false, message: 'Name is required.' };
  if (!password || String(password).length < CONFIG.MIN_PASSWORD_LENGTH) return { success: false, message: `Initial password must be at least ${CONFIG.MIN_PASSWORD_LENGTH} characters.` };
  return withScriptLock_(30000, () => {
    clearRequestCache_();
    if (findUser_(email)) return { success: false, message: 'A user with that email already exists.' };
    writeUserRow_(email.toLowerCase().trim(), { role, name, password: generatePasswordHash_(password), status: 'active' });
    return { success: true, message: 'User added' };
  });
}
function removeUser(params) {
  clearRequestCache_();
  const { token, email } = params || {};
  const admin = requireRole(token, ['Admin']);
  const user = findUser_(email);
  if (!user) return { success: false, message: 'User not found' };
  if (user.role === 'Admin') return { success: false, message: 'Cannot delete an Admin user. Change their role first.' };
  _deleteSettingsRow_('User_' + user.email.toLowerCase());
  revokeUserTokens_(user.email);
  appendAudit_('REMOVE_USER', user.email, admin.email);
  return { success: true, message: 'User removed' };
}
function updateUser(params) {
  clearRequestCache_();
  const { token, email, name, role, password } = params || {};
  const admin = requireRole(token, ['Admin']);
  const user = findUser_(email);
  if (!user) return { success: false, message: 'User not found' };
  if (role && !isKnownRole_(role)) return { success: false, message: 'Please choose a valid role.' };
  if (password && String(password).length < CONFIG.MIN_PASSWORD_LENGTH) return { success: false, message: `Password must be at least ${CONFIG.MIN_PASSWORD_LENGTH} characters.` };
  if (user.role === 'Admin' && role && role !== 'Admin' && activeAdminCount_() <= 1)
    return { success: false, message: 'You cannot demote the last active Admin.' };
  if (user.email === admin.email && role && role !== 'Admin')
    return { success: false, message: 'You cannot remove your own Admin role.' };
  writeUserRow_(user.email, {
    role: role || user.role, name: sanitize_(name) || user.name,
    password: password ? generatePasswordHash_(password) : user.password, status: user.status
  });
  if (password) { revokeUserTokens_(user.email); appendAudit_('PASSWORD_RESET', 'Password reset by an administrator for ' + user.email, admin.email); }
  return { success: true, message: 'User updated' };
}
function setUserStatus(params) {
  clearRequestCache_();
  const { token, email, status } = params || {};
  const admin = requireRole(token, ['Admin']);
  const st = String(status || '').toLowerCase();
  if (st !== 'active' && st !== 'inactive') return { success: false, message: 'Invalid status.' };
  const user = findUser_(email);
  if (!user) return { success: false, message: 'User not found' };
  if (st === 'inactive') {
    if (user.email === admin.email) return { success: false, message: 'You cannot deactivate your own account.' };
    if (user.role === 'Admin' && activeAdminCount_() <= 1) return { success: false, message: 'You cannot deactivate the last active Admin.' };
  }
  user.status = st;
  writeUserRow_(user.email, user);
  if (st === 'inactive') revokeUserTokens_(user.email);
  appendAudit_('USER_STATUS', user.email + ' → ' + st, admin.email);
  return { success: true, message: st === 'active' ? 'User activated' : 'User deactivated' };
}
function getAllUsers(params) {
  clearRequestCache_();
  requireRole((params || {}).token, ['Admin']);
  return getUsers_().map(u => ({ email: u.email, role: u.role, name: u.name, status: u.status || 'active' }));
}
function getPublicConfig(params) {
  clearRequestCache_();
  syncConfig_();
  return {
    schoolName: getSetting_('SchoolName') || CONFIG.SCHOOL_NAME,
    schoolMotto: getSetting_('SchoolMotto') || CONFIG.SCHOOL_MOTTO,
    schoolCrest: getSetting_('SchoolCrest') || '',
    needsSetup: needsFirstTimeSetup()
  };
}
// Returns the server-side truth for name/role/pages so the client no longer
// relies on values cached in sessionStorage.
function validateSession(params) {
  clearRequestCache_();
  const { token } = params || {};
  if (!token) return { valid: false };
  try {
    const u = validateToken_(token);
    if (!u) return { valid: false };
    return Object.assign({ valid: true }, userPayload_(u));
  } catch (e) { return { valid: false }; }
}

// ==================== STUDENTS ====================
function deactivateStudent(params) {
  clearRequestCache_();
  const { token, sid } = params || {};
  const admin = requireAction_(token, 'students.delete');
  const rec = findStudentRecord_(sid);
  if (!rec) return { success: false, message: 'Student not found' };
  const statusIdx = rec.headers.indexOf('Status');
  rec.sheet.getRange(rec.rowIndex + 1, statusIdx + 1).setValue('Inactive');
  appendAudit_('DEACTIVATE_STUDENT', `${rec.student.FullName} (${sid})`, admin.email);
  return { success: true, message: 'Student deactivated successfully' };
}
function reactivateStudent(params) {
  clearRequestCache_();
  const { token, sid } = params || {};
  requireAction_(token, 'students.delete');
  const rec = findStudentRecord_(sid);
  if (!rec) return { success: false, message: 'Student not found' };
  const statusIdx = rec.headers.indexOf('Status');
  if (String(rec.data[rec.rowIndex][statusIdx]).toLowerCase() === 'active')
    return { success: false, message: 'Student is already active' };
  rec.sheet.getRange(rec.rowIndex + 1, statusIdx + 1).setValue('Active');
  return { success: true, message: 'Student reactivated successfully' };
}
// Removes all rows for the given student IDs from every related sheet,
// deleting contiguous blocks in single calls.
function purgeStudentRecords_(ss, sidSet) {
  [['Fees_Ledger', 1], ['Results_Entry', 1], ['Attendance', 1],
   ['Student_Fee_Overrides', 0], ['Conduct_Records', 0], ['Canteen_Ledger', 2], ['Promotion_Decisions', 0]].forEach(([name, col]) => {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    const data = sh.getDataRange().getValues();
    const rows = [];
    for (let i = 1; i < data.length; i++) {
      if (data[i][col] && sidSet.has(data[i][col].toString().trim())) rows.push(i + 1);
    }
    deleteRowsGrouped_(sh, rows);
  });
}
function deleteStudent(params) {
  clearRequestCache_();
  const { token, sid, confirmDelete } = params || {};
  const admin = requireAction_(token, 'students.delete');
  if (confirmDelete !== true && confirmDelete !== 'true' && confirmDelete !== 'YES')
    return { success: false, message: 'Please confirm deletion by setting confirmDelete to true.' };
  try {
    return withScriptLock_(30000, () => {
      const ss = getSpreadsheet_();
      const rec = findStudentRecord_(sid);
      if (!rec) return { success: false, message: 'Student not found' };
      if (studentsWithPayments_(new Set([String(sid).trim()])).size)
        return { success: false, message: `${rec.student.FullName} has payment records, which are part of the school's accounts. Deactivate the student instead of deleting.` };
      const name = rec.student.FullName, cls = rec.student.Class;
      deleteRowSafe_(rec.sheet, rec.rowIndex + 1);
      purgeStudentRecords_(ss, new Set([String(sid).trim()]));
      appendAudit_('DELETE_STUDENT', `Permanently deleted: ${name} (ID: ${sid}, Class: ${cls})`, admin.email);
      return { success: true, message: `Student "${name}" (${sid}) and all records permanently deleted.` };
    });
  } catch (e) {
    return { success: false, message: 'Delete failed: ' + e.toString() };
  }
}
function bulkDeleteStudents(params) {
  clearRequestCache_();
  const { token, studentIDs, confirmDelete } = params || {};
  const admin = requireAction_(token, 'students.delete');
  if (!Array.isArray(studentIDs) || !studentIDs.length) return { success: false, message: 'No student IDs provided' };
  if (confirmDelete !== true && confirmDelete !== 'true' && confirmDelete !== 'YES')
    return { success: false, message: 'Please confirm deletion by setting confirmDelete to true.' };
  try {
    return withScriptLock_(60000, () => {
      const ss = getSpreadsheet_();
      const ids = studentIDs.map(s => String(s).trim());
      const paid = studentsWithPayments_(new Set(ids));
      const sidSet = new Set(ids.filter(s => !paid.has(s)));
      const t = readStudentsTable_();
      if (!t) return { success: false, message: 'Students sheet not found' };
      const sh = t.sh, data = t.data;
      const deletedInfo = {}, rows = [];
      for (let i = 1; i < data.length; i++) {
        const sid = data[i][0] ? data[i][0].toString().trim() : '';
        if (sidSet.has(sid)) { deletedInfo[sid] = { name: data[i][1] || '', cls: data[i][4] || '' }; rows.push(i + 1); }
      }
      deleteRowsGrouped_(sh, rows);
      purgeStudentRecords_(ss, sidSet);
      // FIX: audit rows previously paired row positions with the wrong IDs.
      const results = [];
      const now = new Date().toISOString();
      const auditRows = [];
      Array.from(sidSet).forEach(sid => {
        if (deletedInfo[sid]) {
          results.push({ studentID: sid, status: 'deleted' });
          auditRows.push([now, 'DELETE_STUDENT', `Permanently deleted: ${deletedInfo[sid].name} (ID: ${sid}, Class: ${deletedInfo[sid].cls})`, admin.email]);
        } else {
          results.push({ studentID: sid, status: 'failed', message: 'Not found' });
        }
      });
      if (auditRows.length) {
        appendAudit_('BULK_DELETE', `${auditRows.length} student(s)`, admin.email);
        const aSh = ss.getSheetByName('Audit_Log');
        appendRows_(aSh, auditRows);
      }
      paid.forEach(sid => results.push({ studentID: sid, status: 'failed', message: 'Has payment records — deactivate instead' }));
      const successCount = auditRows.length, failCount = sidSet.size - successCount + paid.size;
      return { success: true, totalProcessed: sidSet.size + paid.size, successCount, failCount, results,
               message: `Deleted ${successCount} student(s). ${failCount} failed.` };
    });
  } catch (e) {
    return { success: false, message: 'Bulk delete failed: ' + e.toString() };
  }
}
function validClassCode_(code) {
  const c = String(code || '').trim().toUpperCase();
  const found = getClasses_().find(x => x.code.toUpperCase() === c);
  return found ? found.code : null;
}
const ADMISSION_FEE_TYPE = 'Admission Fee (One-Time)';
function normName_(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }
// Charges the one-time admission fee — never twice for the same student.
function chargeAdmissionFee_(ss, sid, name, cls, amount) {
  if (!(amount > 0)) return false;
  const sh = ss.getSheetByName('Fees_Ledger');
  if (sh.getLastRow() > 1 && sh.getRange(2, 2, sh.getLastRow() - 1, 6).getValues()
        .some(r => String(r[0]).trim() === sid && String(r[5]) === ADMISSION_FEE_TYPE)) return false;
  appendRows_(sh, [['CHG' + Date.now(), sid, name, cls, CONFIG.CURRENT_TERM, CONFIG.CURRENT_ACADEMIC_YEAR,
    ADMISSION_FEE_TYPE, amount, 0, amount, todayStr_(), '', '', '', 'Charge', 'One-time admission fee (new admission)', '']]);
  return true;
}
// Adds a student.
//  • newAdmission = true  → charges the one-time admission fee (amount from
//    Settings unless given). Existing pupils being entered into the system
//    are added with newAdmission = false and are never charged.
//  • idempotencyKey       → a repeated submission returns the same student
//    instead of creating a second one.
//  • A student with the same name (and date of birth) is flagged; the page
//    asks before adding them anyway (confirmDuplicate).
function addStudent(params) {
  clearRequestCache_();
  const { token, ...data } = params || {};
  const user = requireAction_(token, 'students.edit');
  syncConfig_();
  const fullName = String(data.fullName || '').trim().replace(/\s+/g, ' ');
  if (!fullName) return { success: false, message: 'Full name is required.' };
  const cls = validClassCode_(data.class);
  if (!cls) return { success: false, message: 'Please choose a valid class.' };
  const newAdmission = data.newAdmission === true || data.newAdmission === 'true';
  const fee = !newAdmission ? 0 : (data.admissionFee === undefined || data.admissionFee === null || data.admissionFee === '')
    ? numSetting_('AdmissionFee', 0) : parseFloat(data.admissionFee);
  if (isNaN(fee) || fee < 0) return { success: false, message: 'Admission fee cannot be negative.' };
  const key = data.idempotencyKey ? 'addStudent_' + String(data.idempotencyKey) : '';
  return withScriptLock_(30000, () => {
    const cache = CacheService.getScriptCache();
    if (key) {
      const prev = cache.get(key);
      if (prev) return { success: true, duplicate: true, studentID: prev, message: 'This student was already added — the repeated submission was ignored.' };
    }
    if (!data.confirmDuplicate) {
      const nm = normName_(fullName), dob = String(data.dateOfBirth || '').trim();
      const twin = loadStudents_().find(s => normName_(s.FullName) === nm && (!dob || !s.DateOfBirth || String(s.DateOfBirth).trim() === dob));
      if (twin) return { success: false, possibleDuplicate: true,
        message: `${twin.FullName} (${twin.StudentID}, ${twin.Class}) is already registered with the same name${dob && twin.DateOfBirth ? ' and date of birth' : ''}.` };
    }
    const sid = getNextStudentID_();
    const ss = getSpreadsheet_();
    const sh = ss.getSheetByName('Students');
    if (!sh) throw new Error('Students sheet missing');
    appendRows_(sh, [[
      sid, fullName, data.gender || '', data.dateOfBirth || '', cls,
      data.admissionDate || todayStr_(), data.address || '',
      data.parentName || '', textCell_(data.parentMoMo), textCell_(data.emergencyContact),
      data.previousSchool || '', data.medicalConditions || '',
      'Active', data.scholarship || 'None', '',
      0, 0, user.email, new Date().toISOString()
    ]]);
    const charged = chargeAdmissionFee_(ss, sid, fullName, cls, r2(fee));
    if (key) cache.put(key, sid, 21600);
    return { success: true, studentID: sid, admissionFeeCharged: charged ? r2(fee) : 0,
             message: 'Student added' + (charged ? ` — admission fee of GH₵${r2(fee).toFixed(2)} charged` : '') + '.' };
  });
}
function updateStudent(params) {
  clearRequestCache_();
  const { token, studentID, ...data } = params || {};
  if (!studentID) return { success: false, message: 'Student ID required' };
  requireAction_(token, 'students.edit');
  if (data.fullName !== undefined && !String(data.fullName).trim()) return { success: false, message: 'Full name cannot be empty.' };
  let cls;
  if (data.class !== undefined) { cls = validClassCode_(data.class); if (!cls) return { success: false, message: 'Please choose a valid class.' }; }
  const rec = findStudentRecord_(studentID);
  if (!rec) return { success: false, message: 'Student not found' };
  const headers = rec.headers;
  const row = rec.data[rec.rowIndex].slice();
  const set = (col, val) => { const idx = headers.indexOf(col); if (idx >= 0 && val !== undefined && val !== null) row[idx] = val; };
  set('FullName', data.fullName !== undefined ? String(data.fullName).trim() : undefined);
  set('Gender', data.gender);
  set('DateOfBirth', data.dateOfBirth);
  set('Class', cls);
  set('AdmissionDate', data.admissionDate);
  set('ResidentialAddress', data.address);
  set('ParentName', data.parentName);
  set('Scholarship', data.scholarship);
  set('PreviousSchool', data.previousSchool);
  set('MedicalConditions', data.medicalConditions);
  set('Status', data.status);
  // Re-protect phone columns (they were losing leading zeros on every edit).
  ['ParentMoMo', 'EmergencyContact'].forEach(col => {
    const idx = headers.indexOf(col);
    if (idx < 0) return;
    const incoming = col === 'ParentMoMo' ? data.parentMoMo : data.emergencyContact;
    row[idx] = textCell_(incoming !== undefined ? incoming : row[idx]);
  });
  // FIX: CreatedBy / CreatedDate are no longer overwritten on every edit.
  writeStudentRow_(rec.table, rec.rowIndex, row);
  return { success: true, message: 'Student updated successfully' };
}
// Personal details (address, parent, phone numbers, medical, date of birth) go only to people
// whose role includes the Students page. Everyone else who is signed in gets the basics
// they need for picking a student: ID, name, gender, class, status.
const STUDENT_PRIVATE_FIELDS_ = ['DateOfBirth', 'ResidentialAddress', 'ParentName', 'ParentMoMo', 'EmergencyContact',
  'PreviousSchool', 'MedicalConditions', 'RolloverBalance', 'TotalFeesPaid', 'CreatedBy', 'Scholarship'];
function canSeeStudentDetails_(user) {
  return user.role === ADMIN_ROLE || getRoleAccess_(user.role).pages.includes('students') || getRoleAccess_(user.role).pages.includes('fees');
}
function studentsFor_(user, list) {
  if (canSeeStudentDetails_(user)) return list;
  const strip = s => { const o = Object.assign({}, s); STUDENT_PRIVATE_FIELDS_.forEach(f => { if (f in o) o[f] = ''; }); return o; };
  return Array.isArray(list) ? list.map(strip) : (list ? strip(list) : list);
}
function getAllStudents(params) {
  clearRequestCache_();
  const { token, classFilter } = params || {};
  const me = requireUser_(token);
  const students = loadStudents_();
  return studentsFor_(me, classFilter && classFilter !== 'All' ? students.filter(s => s.Class === classFilter) : students);
}
function searchStudents(params) {
  clearRequestCache_();
  const { token, term, classFilter } = params || {};
  const me = requireUser_(token);
  const all = classFilter && classFilter !== 'All' ? loadStudents_().filter(s => s.Class === classFilter) : loadStudents_();
  if (!term) return studentsFor_(me, all);
  const t = String(term).toLowerCase(), details = canSeeStudentDetails_(me);
  return studentsFor_(me, all.filter(s =>
    String(s.FullName || '').toLowerCase().includes(t) ||
    String(s.StudentID || '').toLowerCase().includes(t) ||
    (details && String(s.ParentName || '').toLowerCase().includes(t))));
}
function getStudentById(params) {
  clearRequestCache_();
  const { token, sid } = params || {};
  const me = requireUser_(token);
  return studentsFor_(me, getStudentByIdDirect_(sid));
}
function getAllStudentsIncludingInactive(params) {
  clearRequestCache_();
  requireAction_((params || {}).token, 'students.delete');
  const t = readStudentsTable_();
  if (!t) return [];
  return t.data.slice(1).filter(r => r[0] && r[0].toString().trim()).map(r => rowToStudent_(t.headers, r));
}

// ==================== FEE DATA LOADERS ====================
function getFeeItems_() {
  const sh = getSpreadsheet_().getSheetByName('Fee_Items');
  if (!sh) return [];
  const term = CONFIG.CURRENT_TERM, ay = CONFIG.CURRENT_ACADEMIC_YEAR;
  return sh.getDataRange().getValues().slice(1)
    .filter(r => r[0] && r[3] && parseInt(r[1], 10) === term && String(r[2]).trim() === ay)
    .map(r => ({ classCode: r[0].toString().trim(), term: parseInt(r[1], 10), academicYear: String(r[2]).trim(),
                 component: r[3].toString().trim(), amount: parseFloat(r[4]) || 0 }));
}
function getLedgerRows_() {
  const sh = getSpreadsheet_().getSheetByName('Fees_Ledger');
  if (!sh) return [];
  const term = CONFIG.CURRENT_TERM, ay = CONFIG.CURRENT_ACADEMIC_YEAR;
  // Term and year (columns E:F) are read for every row; the rest only for this term's rows.
  return readRowsWhere_(sh, 5, 2, p => parseInt(p[0], 10) === term && String(p[1]).trim() === ay, 15)
    .filter(r => r[0])
    .map(r => ({
      transactionID: r[0], studentID: r[1] ? r[1].toString().trim() : '', feeType: String(r[6] || ''),
      amountDue: parseFloat(r[7]) || 0, amountPaid: parseFloat(r[8]) || 0,
      paymentDate: fmtDate_(r[10]), method: r[11], receipt: r[13], momoID: r[12],
      status: r[14] ? r[14].toString().trim() : ''
    }));
}
function getAllLedgerRowsInRange_(startDate, endDate) {
  const sh = getSpreadsheet_().getSheetByName('Fees_Ledger');
  if (!sh) return [];
  // Amount and date (columns I:K) decide which rows are needed.
  return readRowsWhere_(sh, 9, 3, p => {
      if ((parseFloat(p[0]) || 0) === 0) return false;
      const d = parseSheetDate_(p[2]);
      return d && d >= startDate && d <= endDate;
    }, 15)
    .map(r => ({ studentID: r[1] ? r[1].toString() : '', feeType: r[6], amountPaid: parseFloat(r[8]) || 0,
                 paymentDate: fmtDate_(r[10]), term: r[4], academicYear: r[5] }));
}
function getStudentFeeOverridesAll_() {
  const sh = getSpreadsheet_().getSheetByName('Student_Fee_Overrides');
  if (!sh) return {};
  const term = CONFIG.CURRENT_TERM, ay = CONFIG.CURRENT_ACADEMIC_YEAR;
  const overrides = {};
  sh.getDataRange().getValues().slice(1).forEach(r => {
    if (r[0] && parseInt(r[2], 10) === term && String(r[3]).trim() === ay) {
      const sid = r[0].toString().trim();
      if (!overrides[sid]) overrides[sid] = {};
      overrides[sid][r[4].toString().trim()] = parseFloat(r[5]) || 0;
    }
  });
  return overrides;
}
function loadFeeData_() {
  syncConfig_();
  return { students: loadStudents_(), feeItems: getFeeItems_(), ledger: getLedgerRows_(), overrides: getStudentFeeOverridesAll_() };
}

// ==================== FEE COMPUTATION ====================
// Breakdown rows carry:
//   standard       – the class fee-item amount
//   preScholarship – amount after per-student override, BEFORE scholarship
//                    (this is what the "Edit Fees" screen must edit, otherwise
//                    saving overrides double-applied the scholarship)
//   expected       – what the student actually owes for the component
//   isCharge       – one-off ledger charge (e.g. admission fee); not editable
function computeStudentFeeSummary_(student, feeItemsByClass, ledgerByStudent, overrides) {
  const sid = student.StudentID;
  const ov = (overrides && overrides[sid]) || {};
  const components = (feeItemsByClass[student.Class] || []).map(f => {
    const pre = ov[f.component] !== undefined ? ov[f.component] : f.amount;
    return { component: f.component, standard: f.amount, preScholarship: pre, expected: pre, isCharge: false };
  });
  const scholarship = String(student.Scholarship || 'None').trim();
  if (/^full$/i.test(scholarship)) {
    components.forEach(c => { c.expected = 0; });
  } else if (scholarship && !/^none$/i.test(scholarship)) {
    // Partial scholarship = fixed amount the student pays for term fees.
    // FIX: factor is capped at 1 (a cap above the fees used to INFLATE them)
    // and rounding residue goes to the last component so the total is exact.
    const cap = parseFloat(scholarship);
    const base = components.reduce((s, c) => s + c.preScholarship, 0);
    if (!isNaN(cap) && cap >= 0 && base > 0 && cap < base) {
      const factor = cap / base;
      let allocated = 0;
      components.forEach((c, i) => {
        if (i === components.length - 1) c.expected = r2(cap - allocated);
        else { c.expected = r2(c.preScholarship * factor); allocated = r2(allocated + c.expected); }
      });
    }
  }
  const ledgerRows = ledgerByStudent[sid] || [];
  // FIX: one-off charges (AmountDue on the ledger, e.g. admission fee) were
  // written but never counted, so they never showed as owed.
  const charges = {};
  ledgerRows.forEach(r => { if (r.amountDue > 0) charges[r.feeType] = r2((charges[r.feeType] || 0) + r.amountDue); });
  Object.keys(charges).forEach(k => components.push({ component: k, standard: charges[k], preScholarship: charges[k], expected: charges[k], isCharge: true }));

  const totalPaid = r2(ledgerRows.reduce((s, r) => s + r.amountPaid, 0));
  const totalExpected = r2(components.reduce((s, c) => s + c.expected, 0));
  const rollover = parseFloat(student.RolloverBalance) || 0;
  const totalDue = r2(totalExpected + (rollover > 0 ? rollover : 0));
  const totalBalance = r2(totalDue - totalPaid + (rollover < 0 ? rollover : 0));
  const paymentStatus = (totalDue <= 0 || totalBalance <= 0) ? 'Full'
    : (totalPaid > 0 || rollover < 0) ? 'Partial' : 'Not Paid';

  const PRIORITY = ['Admission Fee (One-Time)','Tuition','Exams Fee','BECE Registration Fee',
    'Feeding','Learning Materials','PTA Dues','ICT Lab Fee'];
  const sorted = components.slice().sort((a, b) => {
    const ai = PRIORITY.indexOf(a.component), bi = PRIORITY.indexOf(b.component);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
  });
  // Balances carried over at rollover show as one "Arrears" line, settled
  // first; payments then go to this term's components in priority order.
  if (rollover > 0) sorted.unshift({ component: ARREARS_FEE_TYPE, standard: rollover, preScholarship: rollover, expected: rollover, isArrears: true });
  let remaining = totalPaid;
  sorted.forEach((c, idx) => {
    const paid = r2(Math.max(0, Math.min(c.expected, remaining)));
    remaining = r2(remaining - paid);
    c.paid = paid;
    c.balance = r2(c.expected - paid);
    if (idx === sorted.length - 1 && remaining > 0) { c.paid = r2(c.paid + remaining); c.balance = Math.max(0, r2(c.balance - remaining)); }
  });
  return {
    totalExpected, totalPaid, rolloverBalance: rollover, totalDue, totalBalance, paymentStatus,
    breakdown: sorted.map(c => ({ component: c.component, standard: c.standard, preScholarship: c.preScholarship,
                                  expected: c.expected, paid: c.paid, balance: c.balance, isCharge: c.isCharge, isArrears: !!c.isArrears }))
  };
}
const ARREARS_FEE_TYPE = 'Arrears';
function _buildFeeIndexes_(feeItems, ledger) {
  const feeItemsByClass = {}, ledgerByStudent = {};
  feeItems.forEach(f => { (feeItemsByClass[f.classCode] = feeItemsByClass[f.classCode] || []).push(f); });
  ledger.forEach(r => { if (r.studentID) (ledgerByStudent[r.studentID] = ledgerByStudent[r.studentID] || []).push(r); });
  return { feeItemsByClass, ledgerByStudent };
}

// ==================== CLASSES & SUBJECTS ====================
function getClasses_() {
  if (_classesCache) return _classesCache;
  const sh = getSpreadsheet_().getSheetByName('Classes');
  if (!sh) return [];
  return _classesCache = sh.getDataRange().getValues().slice(1).filter(r => r[0])
    .map(r => ({ code: r[0].toString().trim(), name: String(r[1] || r[0]), category: String(r[2] || '') }));
}
function getTopClassCode_() {
  const cl = getClasses_();
  return cl.length ? cl[cl.length - 1].code : 'B9';
}
function getClasses(params) {
  clearRequestCache_();
  requireUser_((params || {}).token);
  return getClasses_();
}
function classCodeOk_(c) { return /^[A-Z0-9_-]{1,10}$/.test(c); }
function addClass(params) {
  clearRequestCache_();
  const { token, code, name, category } = params || {};
  requireRole(token, ['Admin']);
  const c = String(code || '').trim().toUpperCase();
  if (!c || !classCodeOk_(c)) return { success: false, message: 'Class code is required (letters/numbers only, max 10).' };
  if (!String(name || '').trim()) return { success: false, message: 'Class name is required.' };
  return withScriptLock_(30000, () => {
    let sh = getSpreadsheet_().getSheetByName('Classes');
    if (!sh) { createDatabaseSchema_(); sh = getSpreadsheet_().getSheetByName('Classes'); }
    if (getClasses_().some(x => x.code.toUpperCase() === c)) return { success: false, message: `Class ${c} already exists.` };
    appendRows_(sh, [[c, String(name).trim(), String(category || '').trim()]]);
    return { success: true, message: 'Class added.' };
  });
}
// Edits a class. Changing the CODE also moves every student, fee item,
// fee override and canteen rate from the old code to the new one.
function updateClass(params) {
  clearRequestCache_();
  const { token, code, newCode, name, category } = params || {};
  const admin = requireRole(token, ['Admin']);
  const from = String(code || '').trim();
  const to = String(newCode || from).trim().toUpperCase();
  if (!classCodeOk_(to)) return { success: false, message: 'Class code: letters/numbers only, max 10.' };
  if (!String(name || '').trim()) return { success: false, message: 'Class name is required.' };
  return withScriptLock_(60000, () => {
    const ss = getSpreadsheet_();
    const sh = ss.getSheetByName('Classes');
    const data = sh.getDataRange().getValues();
    const i = data.findIndex((r, k) => k > 0 && String(r[0]).trim() === from);
    if (i < 1) return { success: false, message: 'Class not found.' };
    if (to !== from && data.some((r, k) => k > 0 && k !== i && String(r[0]).trim().toUpperCase() === to)) return { success: false, message: `Class ${to} already exists.` };
    sh.getRange(i + 1, 1, 1, 3).setValues([[to, String(name).trim(), String(category || '').trim()]]);
    let moved = 0;
    if (to !== from) {
      const st = readStudentsTable_();
      const ci = st ? st.headers.indexOf('Class') : -1;
      if (st && ci >= 0 && st.data.length > 1) {
        const col = st.data.slice(1).map(r => { if (String(r[ci]).trim() === from) { moved++; return [to]; } return [r[ci]]; });
        if (moved) st.sh.getRange(2, ci + 1, col.length, 1).setValues(col);
      }
      [['Fee_Items', 0], ['Student_Fee_Overrides', 1]].forEach(([n, c]) => {
        const s2 = ss.getSheetByName(n);
        if (!s2 || s2.getLastRow() < 2) return;
        const vals = s2.getRange(2, c + 1, s2.getLastRow() - 1, 1).getValues();
        if (vals.some(v => String(v[0]).trim() === from)) s2.getRange(2, c + 1, vals.length, 1).setValues(vals.map(v => [String(v[0]).trim() === from ? to : v[0]]));
      });
      try {
        const rates = JSON.parse(getSetting_('CanteenClassRates') || '{}') || {};
        if (Object.prototype.hasOwnProperty.call(rates, from)) { rates[to] = rates[from]; delete rates[from]; setSetting_('CanteenClassRates', JSON.stringify(rates)); }
      } catch (e) { /* no canteen rates */ }
      appendAudit_('CLASS_RENAME', `${from} → ${to} (${moved} students moved)`, admin.email);
    }
    return { success: true, message: 'Class updated.' + (moved ? ` ${moved} student(s) moved to ${to}.` : '') };
  });
}
// Moves a class up/down. The order decides promotion (next class up) and
// which class graduates (the last one).
function moveClass(params) {
  clearRequestCache_();
  const { token, code, direction } = params || {};
  requireRole(token, ['Admin']);
  return withScriptLock_(30000, () => {
    const sh = getSpreadsheet_().getSheetByName('Classes');
    const data = sh.getDataRange().getValues();
    const rows = data.slice(1).filter(r => r[0]);
    const i = rows.findIndex(r => String(r[0]).trim() === String(code).trim());
    const j = direction === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= rows.length) return { success: false, message: 'Cannot move further.' };
    const tmp = rows[i]; rows[i] = rows[j]; rows[j] = tmp;
    sh.getRange(2, 1, rows.length, 3).setValues(fxRows_(rows.map(r => [r[0], r[1], r[2]])));
    return { success: true };
  });
}
function deleteClass(params) {
  clearRequestCache_();
  const { token, code } = params || {};
  requireRole(token, ['Admin']);
  const count = loadStudents_().filter(s => String(s.Class).toUpperCase() === String(code).toUpperCase()).length;
  if (count) return { success: false, message: `Cannot delete: ${count} active student(s) are still in this class. Move them first.` };
  return withScriptLock_(30000, () => {
    const sh = getSpreadsheet_().getSheetByName('Classes');
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] && data[i][0].toString().trim() === String(code).trim()) { deleteRowSafe_(sh, i + 1); return { success: true, message: 'Class deleted.' }; }
    }
    return { success: false, message: 'Not found' };
  });
}
function getClassCategory_(className) {
  if (!className) return 'Upper Primary';
  const c = className.toString().toUpperCase();
  if (c.startsWith('KG')) return 'KG';
  if (c.startsWith('N')) return 'Nursery';
  const n = parseInt(c.replace(/[^0-9]/g, ''), 10);
  if (n >= 1 && n <= 3) return 'Lower Primary';
  if (n >= 4 && n <= 6) return 'Upper Primary';
  if (n >= 7 && n <= 9) return 'JHS';
  return 'Upper Primary';
}
function getSubjectsForCategory_(category) {
  const sh = getSpreadsheet_().getSheetByName('Subjects');
  if (!sh) return [];
  return sh.getDataRange().getValues().slice(1)
    .filter(r => r[0] && r[0].toString().trim() === category)
    .map(r => String(r[1] || '').trim()).filter(Boolean);
}
function categoryForClass_(classCode, classes) {
  const cls = (classes || getClasses_()).find(c => c.code.toUpperCase() === String(classCode || '').toUpperCase());
  return cls ? cls.category : getClassCategory_(classCode);
}
function getGESSubjects(params) {
  clearRequestCache_();
  const { token, classCode } = params || {};
  requireAccess_(token, 'results');
  if (!classCode) return [];
  return getSubjectsForCategory_(categoryForClass_(classCode));
}
function getSubjects(params) {
  clearRequestCache_();
  requireRole((params || {}).token, ['Admin']);
  const sh = getSpreadsheet_().getSheetByName('Subjects');
  if (!sh) return [];
  return sh.getDataRange().getValues().slice(1).filter(r => r[0] && r[1])
    .map(r => ({ category: r[0].toString(), subjectName: r[1].toString() }));
}
function addSubject(params) {
  clearRequestCache_();
  const { token, category, subjectName } = params || {};
  requireRole(token, ['Admin']);
  const cat = String(category || '').trim(), sub = String(subjectName || '').trim();
  if (!cat || !sub) return { success: false, message: 'Category and subject name are required.' };
  return withScriptLock_(30000, () => {
    let sh = getSpreadsheet_().getSheetByName('Subjects');
    if (!sh) { createDatabaseSchema_(); sh = getSpreadsheet_().getSheetByName('Subjects'); }
    const exists = sh.getDataRange().getValues().slice(1)
      .some(r => String(r[0]).trim() === cat && String(r[1]).trim().toLowerCase() === sub.toLowerCase());
    if (exists) return { success: false, message: 'That subject already exists for this category.' };
    appendRows_(sh, [[cat, sub]]);
    return { success: true, message: 'Subject added.' };
  });
}
// Renames a subject (and/or moves it to another category). Scores already
// entered under the old name, in classes of that category, are renamed too
// so they stay on the report cards.
function updateSubject(params) {
  clearRequestCache_();
  const { token, category, name, newCategory, newName } = params || {};
  const admin = requireRole(token, ['Admin']);
  const cat = String(category || '').trim(), sub = String(name || '').trim();
  const cat2 = String(newCategory || cat).trim(), sub2 = String(newName || '').trim();
  if (!cat2 || !sub2) return { success: false, message: 'Category and subject name are required.' };
  return withScriptLock_(60000, () => {
    const ss = getSpreadsheet_(), sh = ss.getSheetByName('Subjects');
    const data = sh.getDataRange().getValues();
    const i = data.findIndex((r, k) => k > 0 && String(r[0]).trim() === cat && String(r[1]).trim() === sub);
    if (i < 1) return { success: false, message: 'Subject not found.' };
    if (data.some((r, k) => k > 0 && k !== i && String(r[0]).trim() === cat2 && String(r[1]).trim().toLowerCase() === sub2.toLowerCase()))
      return { success: false, message: 'That subject already exists for this category.' };
    sh.getRange(i + 1, 1, 1, 2).setValues([[cat2, sub2]]);
    let renamed = 0;
    if (sub2 !== sub) {
      const rs = ss.getSheetByName('Results_Entry');
      if (rs && rs.getLastRow() > 1) {
        const classes = getClasses_();
        const vals = rs.getRange(2, 4, rs.getLastRow() - 1, 4).getValues();     // Class, Term, Year, Subject
        const col = vals.map(v => {
          if (String(v[3]).trim() === sub && categoryForClass_(String(v[0]), classes) === cat) { renamed++; return [sub2]; }
          return [v[3]];
        });
        if (renamed) rs.getRange(2, 7, col.length, 1).setValues(col);
      }
      appendAudit_('SUBJECT_RENAME', `${cat}: ${sub} → ${cat2}: ${sub2} (${renamed} score rows)`, admin.email);
    }
    return { success: true, message: 'Subject updated.' + (renamed ? ` ${renamed} saved score(s) kept under the new name.` : '') };
  });
}
function deleteSubject(params) {
  clearRequestCache_();
  const { token, category, name } = params || {};
  requireRole(token, ['Admin']);
  return withScriptLock_(30000, () => {
    const sh = getSpreadsheet_().getSheetByName('Subjects');
    const data = sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === String(category).trim() && String(data[i][1]).trim() === String(name).trim()) {
        deleteRowSafe_(sh, i + 1); return { success: true, message: 'Subject deleted.' };
      }
    }
    return { success: false, message: 'Not found' };
  });
}
// Next class in Classes-sheet order, for "Promoted To" on Term 3 reports.
function getNextClassInHierarchy_(currentClassCode) {
  const classes = getClasses_();
  const idx = classes.findIndex(c => c.code.toUpperCase() === String(currentClassCode || '').toUpperCase());
  if (idx === -1) return '';
  if (idx === classes.length - 1) return 'Graduated';
  return classes[idx + 1].name;
}
// Competition-ranked position per subject (ties share a position).
function computeSubjectPositions_(subjects, classmateIDs, resultsByStudent) {
  const positionsBySubject = {};
  subjects.forEach(sub => {
    // Only students with a score for this subject are ranked; others get no
    // position (shown as "—") instead of all tying for 1st at zero.
    const rows = classmateIDs.map(id => {
      const r = resultsByStudent[id] && resultsByStudent[id][sub];
      return r ? { id, total: r.total } : null;
    }).filter(Boolean).sort((a, b) => b.total - a.total);
    let lastScore = null, lastPos = 0;
    const map = {};
    rows.forEach((row, idx) => {
      if (row.total !== lastScore) { lastPos = idx + 1; lastScore = row.total; }
      map[row.id] = lastPos;
    });
    positionsBySubject[sub] = map;
  });
  return positionsBySubject;
}

// ==================== FEE ITEMS ====================
function getFeeItems(params) {
  clearRequestCache_();
  requireAccess_((params || {}).token, ['fees','settings']);
  syncConfig_();
  return getFeeItems_();
}
// Which classes a fee target covers: a class code, "CAT:<category>" or "ALL".
function feeTargetClasses_(target) {
  const classes = getClasses_(), t = String(target || '').trim();
  if (t === 'ALL') return classes.map(c => c.code);
  if (t.indexOf('CAT:') === 0) { const cat = t.slice(4).trim(); return classes.filter(c => c.category === cat).map(c => c.code); }
  const c = validClassCode_(t);
  return c ? [c] : [];
}
function feeComponentError_(comp) {
  if (!comp) return 'Fee component name is required.';
  if (/^\s*arrears\b/i.test(comp)) return 'Arrears are added automatically: any balance left at the end of a term is carried into the next term as "Arrears". It cannot be a fee item.';
  if (/admission/i.test(comp)) return 'The admission fee is charged once, only to new students, when they are added (set the amount in Settings → School Info). It cannot be a termly fee item.';
  return '';
}
// Adds a fee item for one class, a whole category or all classes. An
// existing component for a class is UPDATED, never duplicated.
function addFeeItem(params) {
  clearRequestCache_();
  const { token, target, classCode, component, amount } = params || {};
  requireRole(token, ['Admin']);
  syncConfig_();
  const classes = feeTargetClasses_(target || classCode);
  if (!classes.length) return { success: false, message: 'Please choose a class or category (the category has no classes).' };
  const comp = String(component || '').trim().replace(/\s+/g, ' ');
  const cErr = feeComponentError_(comp);
  if (cErr) return { success: false, message: cErr };
  const amt = r2(parseFloat(amount));
  if (isNaN(parseFloat(amount)) || amt < 0) return { success: false, message: 'Please enter a valid amount.' };
  return withScriptLock_(30000, () => {
    let sh = getSpreadsheet_().getSheetByName('Fee_Items');
    if (!sh) { createDatabaseSchema_(); sh = getSpreadsheet_().getSheetByName('Fee_Items'); }
    const data = sh.getDataRange().getValues();
    const term = CONFIG.CURRENT_TERM, ay = CONFIG.CURRENT_ACADEMIC_YEAR;
    let updated = 0;
    const inserts = [];
    classes.forEach(cls => {
      let hit = false;
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][0]).trim() === cls && String(data[i][3]).trim().toLowerCase() === comp.toLowerCase() &&
            parseInt(data[i][1], 10) === term && String(data[i][2]).trim() === ay) {
          if (r2(data[i][4]) !== amt) { sh.getRange(i + 1, 5).setValue(amt); updated++; }
          hit = true;
        }
      }
      if (!hit) inserts.push([cls, term, ay, comp, amt]);
    });
    appendRows_(sh, inserts);
    const parts = [];
    if (inserts.length) parts.push(`added for ${inserts.length} class(es)`);
    if (updated) parts.push(`amount updated for ${updated} class(es)`);
    return { success: true, added: inserts.length, updated, message: `${comp}: ` + (parts.join(', ') || 'no change (already set to that amount)') + '.' };
  });
}
// Edits one class's fee item (current term): amount and/or name.
function updateFeeItem(params) {
  clearRequestCache_();
  const { token, classCode, component, newComponent, amount } = params || {};
  requireRole(token, ['Admin']);
  syncConfig_();
  const comp2 = String(newComponent || component || '').trim().replace(/\s+/g, ' ');
  const cErr = feeComponentError_(comp2);
  if (cErr) return { success: false, message: cErr };
  const amt = r2(parseFloat(amount));
  if (isNaN(parseFloat(amount)) || amt < 0) return { success: false, message: 'Please enter a valid amount.' };
  return withScriptLock_(30000, () => {
    const ss = getSpreadsheet_(), sh = ss.getSheetByName('Fee_Items');
    const data = sh.getDataRange().getValues();
    const term = CONFIG.CURRENT_TERM, ay = CONFIG.CURRENT_ACADEMIC_YEAR;
    const match = (r, comp) => String(r[0]).trim() === String(classCode).trim() && String(r[3]).trim() === comp &&
                               parseInt(r[1], 10) === term && String(r[2]).trim() === ay;
    const i = data.findIndex((r, k) => k > 0 && match(r, String(component).trim()));
    if (i < 1) return { success: false, message: 'Fee item not found.' };
    if (comp2.toLowerCase() !== String(component).trim().toLowerCase() &&
        data.some((r, k) => k > 0 && String(r[0]).trim() === String(classCode).trim() && String(r[3]).trim().toLowerCase() === comp2.toLowerCase() &&
                            parseInt(r[1], 10) === term && String(r[2]).trim() === ay))
      return { success: false, message: `${classCode} already has a fee item called "${comp2}".` };
    sh.getRange(i + 1, 4, 1, 2).setValues([[comp2, amt]]);
    if (comp2 !== String(component).trim()) {          // keep students' individual fee overrides attached
      const ov = ss.getSheetByName('Student_Fee_Overrides');
      if (ov && ov.getLastRow() > 1) {
        const vals = ov.getRange(2, 1, ov.getLastRow() - 1, 5).getValues();
        const col = vals.map(r => [String(r[1]).trim() === String(classCode).trim() && parseInt(r[2], 10) === term && String(r[3]).trim() === ay &&
                                   String(r[4]).trim() === String(component).trim() ? comp2 : r[4]]);
        ov.getRange(2, 5, col.length, 1).setValues(col);
      }
    }
    return { success: true, message: 'Fee item updated.' };
  });
}
// Deletes a fee item for one class, or for every class the target covers.
function deleteFeeItem(params) {
  clearRequestCache_();
  const { token, classCode, target, component, term, academicYear } = params || {};
  requireRole(token, ['Admin']);
  syncConfig_();
  const ay = String(academicYear || CONFIG.CURRENT_ACADEMIC_YEAR).trim();
  const t = parseInt(term || CONFIG.CURRENT_TERM, 10);
  const classes = new Set(target ? feeTargetClasses_(target) : [String(classCode).trim()]);
  return withScriptLock_(30000, () => {
    const sh = getSpreadsheet_().getSheetByName('Fee_Items');
    const data = sh.getDataRange().getValues();
    const rows = [];
    for (let i = 1; i < data.length; i++) {
      if (classes.has(String(data[i][0]).trim()) && String(data[i][3]).trim() === String(component).trim() &&
          parseInt(data[i][1], 10) === t && String(data[i][2]).trim() === ay) rows.push(i + 1);
    }
    if (!rows.length) return { success: false, message: 'Not found' };
    deleteRowsGrouped_(sh, rows);
    return { success: true, message: `Deleted from ${rows.length} class(es).` };
  });
}
function saveStudentFeeOverrides(params) {
  clearRequestCache_();
  const { token, sid, overrides } = params || {};
  requireAccess_(token, 'fees');
  requireAction_(token, 'fees.adjust');
  syncConfig_();
  const student = getStudentByIdDirect_(sid);
  if (!student) return { success: false, message: 'Student not found' };
  const list = Array.isArray(overrides) ? overrides : [];
  if (list.some(o => isNaN(parseFloat(o.amount)) || parseFloat(o.amount) < 0))
    return { success: false, message: 'Override amounts must be zero or more.' };
  const standard = {};
  getFeeItems_().filter(f => f.classCode === student.Class).forEach(f => { standard[f.component] = f.amount; });
  return withScriptLock_(30000, () => {
    const ss = getSpreadsheet_();
    let sh = ss.getSheetByName('Student_Fee_Overrides');
    if (!sh) {
      sh = ss.insertSheet('Student_Fee_Overrides');
      sh.getRange(1, 1, 1, 6).setValues([['StudentID','Class','Term','AcademicYear','FeeComponent','OverrideAmount']]);
    }
    const term = CONFIG.CURRENT_TERM, ay = CONFIG.CURRENT_ACADEMIC_YEAR;
    const data = sh.getDataRange().getValues();
    const rows = [];
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] && data[i][0].toString().trim() === String(sid).trim() &&
          parseInt(data[i][2], 10) === term && String(data[i][3]).trim() === ay) rows.push(i + 1);
    }
    deleteRowsGrouped_(sh, rows);
    // Only store real fee-item components whose amount differs from standard.
    const newRows = list
      .filter(o => Object.prototype.hasOwnProperty.call(standard, o.component) && r2(o.amount) !== r2(standard[o.component]))
      .map(o => [sid, student.Class, term, ay, o.component, r2(o.amount)]);
    if (newRows.length) appendRows_(sh, newRows);
    return { success: true, message: 'Overrides saved' };
  });
}

// ==================== FEE OVERVIEWS ====================
function getAllFeeOverview(params) {
  clearRequestCache_();
  // FIX: auth errors used to be swallowed and shown as "No fee data".
  requireAccess_((params || {}).token, ['fees','finances']);
  const { students, feeItems, ledger, overrides } = loadFeeData_();
  if (!students.length) return [];
  const { feeItemsByClass, ledgerByStudent } = _buildFeeIndexes_(feeItems, ledger);
  const classes = getClasses_();
  const known = new Set(classes.map(c => c.code));
  const groups = classes.map(c => ({ code: c.code, name: c.name }));
  // FIX: students whose class isn't in the Classes sheet were silently dropped.
  const orphanCodes = Array.from(new Set(students.filter(s => !known.has(s.Class)).map(s => s.Class)));
  orphanCodes.forEach(code => groups.push({ code, name: (code || 'No class') + ' (not in Classes list)' }));
  const result = [];
  groups.forEach(({ code, name }) => {
    const list = [];
    students.filter(s => s.Class === code).forEach(student => {
      try {
        const sum = computeStudentFeeSummary_(student, feeItemsByClass, ledgerByStudent, overrides);
        list.push({ studentID: student.StudentID, studentName: student.FullName, className: code, arrears: sum.rolloverBalance,
                    termFees: sum.totalExpected, totalDue: sum.totalDue, totalPaid: sum.totalPaid, balance: sum.totalBalance, paymentStatus: sum.paymentStatus });
      } catch (e) { console.error('Fee overview error:', student.StudentID, e); }
    });
    if (list.length) result.push({ className: code, classNameFull: name, students: list });
  });
  // Graduates who still owe (or paid this term) — collectible arrears.
  const grads = [];
  loadGraduates_().forEach(st => {
    const sum = graduateSummary_(st, ledgerByStudent);
    if (Math.abs(sum.totalBalance) > 0.004 || sum.totalPaid > 0)
      grads.push({ studentID: st.StudentID, studentName: st.FullName, className: 'GRADUATED', arrears: sum.rolloverBalance, termFees: 0, totalDue: sum.totalDue, totalPaid: sum.totalPaid,
                   balance: sum.totalBalance, paymentStatus: sum.paymentStatus });
  });
  if (grads.length) result.push({ className: 'GRADUATED', classNameFull: 'Graduated — arrears', students: grads });
  return result;
}
function getClassFeeOverview(params) {
  const { token, classCode } = params || {};
  const found = getAllFeeOverview({ token }).find(f => f.className === classCode);
  return found ? found.students : [];
}
function getFinancialSummary(params) {
  clearRequestCache_();
  requireAccess_((params || {}).token, 'finances');
  const { students, feeItems, ledger, overrides } = loadFeeData_();
  const { feeItemsByClass, ledgerByStudent } = _buildFeeIndexes_(feeItems, ledger);
  let totalAmountDue = 0, totalRolloverOwed = 0, totalRolloverCredit = 0, totalReceived = 0, totalOutstanding = 0;
  students.forEach(student => {
    const sum = computeStudentFeeSummary_(student, feeItemsByClass, ledgerByStudent, overrides);
    totalAmountDue += sum.totalExpected;
    if (sum.rolloverBalance > 0) totalRolloverOwed += sum.rolloverBalance;
    else if (sum.rolloverBalance < 0) totalRolloverCredit += Math.abs(sum.rolloverBalance);
    totalReceived += sum.totalPaid;
    totalOutstanding += Math.max(0, sum.totalBalance);
  });
  let graduatesOwing = 0;
  loadGraduates_().forEach(st => {
    const sum = graduateSummary_(st, ledgerByStudent);
    if (sum.rolloverBalance > 0) totalRolloverOwed += sum.rolloverBalance;
    totalReceived += sum.totalPaid;
    if (sum.totalBalance > 0.004) { totalOutstanding += sum.totalBalance; graduatesOwing++; }
  });
  return {
    success: true, totalAmountDue: r2(totalAmountDue), totalRolloverOwed: r2(totalRolloverOwed),
    totalRolloverCredit: r2(totalRolloverCredit), totalExpected: r2(totalAmountDue + totalRolloverOwed),
    totalReceived: r2(totalReceived), totalOutstanding: r2(totalOutstanding),
    activeStudentCount: students.length, graduatesOwing, term: CONFIG.CURRENT_TERM, academicYear: CONFIG.CURRENT_ACADEMIC_YEAR
  };
}
function getStudentFeeSummary(params) {
  clearRequestCache_();
  const { token, sid } = params || {};
  requireAccess_(token, 'fees');
  syncConfig_();
  let student = getStudentByIdDirect_(sid), graduate = false;
  if (!student) {
    const rec = findStudentRecord_(sid);
    if (rec && String(rec.student.Status).toLowerCase() === 'graduated') { student = rec.student; graduate = true; }
  }
  if (!student) return { success: false, message: 'Student not found' };
  const feeItems = graduate ? [] : getFeeItems_().filter(f => f.classCode === student.Class);
  const ledgerRows = getLedgerRows_().filter(r => r.studentID === student.StudentID);
  const sum = computeStudentFeeSummary_(student, { [student.Class]: feeItems }, { [student.StudentID]: ledgerRows }, getStudentFeeOverridesAll_());
  return {
    success: true,
    student: { studentID: student.StudentID, fullName: student.FullName, class: student.Class, scholarship: student.Scholarship || 'None', graduated: graduate },
    breakdown: sum.breakdown, totalExpected: sum.totalExpected, totalPaid: sum.totalPaid,
    rolloverBalance: sum.rolloverBalance, totalDue: sum.totalDue, totalBalance: sum.totalBalance, paymentStatus: sum.paymentStatus,
    payments: ledgerRows.filter(r => r.amountPaid > 0).map(r => ({
      transactionID: r.transactionID, date: r.paymentDate, component: r.feeType, amount: r.amountPaid, receipt: r.receipt, method: r.method,
      reversed: r.status === 'Reversed'
    }))
  };
}

// ==================== PAYMENTS ====================
// Finds a ledger row by its idempotency key (column Q) without loading the sheet.
function ledgerRowByKey_(sh, key) {
  const last = sh.getLastRow();
  if (last < 2 || !key) return null;
  const found = sh.getRange(2, 17, last - 1, 1).createTextFinder(String(key)).matchEntireCell(true).findNext();
  return found ? sh.getRange(found.getRow(), 1, 1, 17).getValues()[0] : null;
}
function ensureLedgerIdempotencyColumn_() {
  const sh = getSpreadsheet_().getSheetByName('Fees_Ledger');
  if (!sh) return;
  ensureCols_(sh, 17);
  const headerRow = sh.getRange(1, 1, 1, 17).getValues()[0];
  if (headerRow[16] !== 'IdempotencyKey') {
    sh.getRange(1, 17).setValue('IdempotencyKey').setFontWeight('bold').setBackground('#006B3F').setFontColor('#FFFFFF');
  }
}
// Duplicate protection (idempotency key + 45 s heuristic) now genuinely runs
// under ONE lock: the receipt-number increment used to release it early.
function recordFeePayment(params) {
  clearRequestCache_();
  const { token, idempotencyKey, ...data } = params || {};
  requireAccess_(token, 'fees');
  syncConfig_();
  const amount = r2(parseFloat(data.amountPaid));
  if (!(amount > 0)) return { success: false, message: 'Invalid payment amount' };
  const method = String(data.paymentMethod || 'Cash');
  if (method === 'Mobile Money' && !String(data.momoTransactionID || '').trim())
    return { success: false, message: 'A MoMo reference is required for Mobile Money payments.' };
  const feeType = String(data.feeType || 'General Payment');
  if (data.paymentDate) {
    const pd = String(data.paymentDate).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pd) || !parseYMD_(pd)) return { success: false, message: 'Please choose a valid payment date.' };
    if (pd > todayStr_()) return { success: false, message: 'A payment cannot be dated in the future.' };
  }
  return withScriptLock_(30000, () => {
    const rec = findStudentRecord_(data.studentID);
    if (!rec) return { success: false, message: 'Student not found' };
    const statusIdx = rec.headers.indexOf('Status');
    if (String(rec.data[rec.rowIndex][statusIdx] || '').toLowerCase() === 'inactive')
      return { success: false, message: 'This student is inactive. Reactivate them before recording payments.' };
    const student = rec.student;
    ensureLedgerIdempotencyColumn_();
    const ss = getSpreadsheet_();
    const sh = ss.getSheetByName('Fees_Ledger');
    const nowMs = Date.now();
    // 1) The same request sent twice (retry after a dropped connection, offline outbox):
    //    found with a server-side text search of the key column, not by reading every row.
    if (idempotencyKey) {
      const hit = ledgerRowByKey_(sh, idempotencyKey);
      if (hit) {
        return { success: true, receiptNumber: hit[13], transactionID: hit[0], duplicate: true,
                 message: 'This payment was already recorded — duplicate request safely ignored.' };
      }
    }
    // 2) A caller that sent NO key (double-click in an old page): look only at the most recent
    //    rows. A request that does carry a key is never treated as a duplicate of a different
    //    request — two genuine identical payments a few seconds apart are both recorded.
    if (!idempotencyKey && sh.getLastRow() > 1) {
      const last = sh.getLastRow(), n = Math.min(200, last - 1);
      const tail = sh.getRange(last - n + 1, 1, n, 17).getValues();
      for (let i = tail.length - 1; i >= 0; i--) {
        const row = tail[i];
        if (!row[0]) continue;
        if (row[1] && row[1].toString().trim() === student.StudentID && String(row[6]) === feeType &&
            Math.abs((parseFloat(row[8]) || 0) - amount) < 0.005 && row[0].toString().indexOf('TRX') === 0) {
          const ts = parseInt(row[0].toString().slice(3), 10);
          if (!isNaN(ts) && (nowMs - ts) < 45000) {
            return { success: true, receiptNumber: row[13], transactionID: row[0], duplicate: true,
                     message: 'A matching payment was just recorded moments ago — treated as a duplicate to avoid double-charging.' };
          }
        }
      }
    }
    const rn = getNextReceiptNumber_();
    const tid = 'TRX' + nowMs;
    sh.appendRow(fxRows_([[
      tid, student.StudentID, student.FullName, student.Class,
      CONFIG.CURRENT_TERM, CONFIG.CURRENT_ACADEMIC_YEAR,
      feeType, 0, amount, 0,
      data.paymentDate || todayStr_(), method, data.momoTransactionID ? textCell_(data.momoTransactionID) : '',
      rn, 'Paid', data.notes || '', idempotencyKey || ''
    ]])[0]);
    const tfIdx = rec.headers.indexOf('TotalFeesPaid');
    if (tfIdx >= 0) {
      const cur = parseFloat(rec.data[rec.rowIndex][tfIdx]) || 0;
      rec.sheet.getRange(rec.rowIndex + 1, tfIdx + 1).setValue(r2(cur + amount));
    }
    return { success: true, receiptNumber: rn, transactionID: tid, message: 'Payment recorded' };
  });
}
function getPrintableReceipt(params) {
  clearRequestCache_();
  const { token, tid } = params || {};
  const me = requireAccess_(token, 'fees');
  syncConfig_();
  const sh = getSpreadsheet_().getSheetByName('Fees_Ledger');
  if (!sh) return null;
  const headers = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
  const found = readRowsByNumber_(sh, findRowNumbers_(sh, 1, tid).slice(0, 1), headers.length);
  for (let i = 0; i < found.length; i++) {
    const data = [headers, found[i].values];
    {
      const rc = {};
      headers.forEach((h, idx) => { rc[h] = fmtDate_(found[i].values[idx]); });
      const school = {
        schoolName: getSetting_('SchoolName') || CONFIG.SCHOOL_NAME, schoolMotto: getSetting_('SchoolMotto') || CONFIG.SCHOOL_MOTTO,
        schoolAddress: getSetting_('SchoolAddress') || CONFIG.SCHOOL_ADDRESS, schoolPhone: getSetting_('SchoolPhone') || CONFIG.SCHOOL_PHONE,
        schoolEmail: getSetting_('SchoolEmail') || CONFIG.SCHOOL_EMAIL, schoolCrest: getSetting_('SchoolCrest') || ''
      };
      const summary = getStudentFeeSummary({ token, sid: rc['StudentID'] });
      rc.outstandingBalance = summary && summary.success ? summary.totalBalance : 0;
      // Account position for the receipt's summary panel (current term).
      rc.termDue = summary && summary.success ? summary.totalDue : 0;
      rc.termPaid = summary && summary.success ? summary.totalPaid : 0;
      rc.currentTerm = CONFIG.CURRENT_TERM; rc.currentYear = CONFIG.CURRENT_ACADEMIC_YEAR;
      rc.issuedBy = me.name || me.email;
      return Object.assign(rc, school);
    }
  }
  return null;
}
function getStudentPaymentHistory(params) {
  clearRequestCache_();
  const { token, sid } = params || {};
  requireAccess_(token, 'fees');
  const rec = findStudentRecord_(sid);
  if (!rec) return { success: false, message: 'Student not found' };
  const sh = getSpreadsheet_().getSheetByName('Fees_Ledger');
  if (!sh) return { success: true, studentName: rec.student.FullName, studentID: sid, class: rec.student.Class, payments: [] };
  const payments = [];
  readRowsByNumber_(sh, findRowNumbers_(sh, 2, String(sid).trim()), 17).map(x => x.values).forEach(row => {
    if (!row[1] || row[1].toString().trim() !== String(sid).trim()) return;
    const amtPaid = parseFloat(row[8]) || 0;
    if (amtPaid <= 0) return;                         // charges and reversal entries are not payments
    payments.push({ date: fmtDate_(row[10]), term: row[4], academicYear: row[5], feeType: row[6],
                    amount: amtPaid, method: row[11], receipt: row[13], transactionID: row[0], reversed: String(row[14]) === 'Reversed' });
  });
  payments.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return { success: true, studentName: rec.student.FullName, studentID: sid, class: rec.student.Class, payments };
}

// ==================== FEE CORRECTIONS & GRADUATES' ARREARS ====================
// Students who have made payments can't be permanently deleted: their
// payments are part of the school's income history. Deactivate them instead.
function studentsWithPayments_(sidSet) {
  const ss = getSpreadsheet_(), out = new Set();
  const fl = ss.getSheetByName('Fees_Ledger');
  if (fl && fl.getLastRow() > 1) fl.getRange(2, 2, fl.getLastRow() - 1, 8).getValues().forEach(r => {
    const sid = String(r[0] || '').trim();
    if (sidSet.has(sid) && (parseFloat(r[7]) || 0) !== 0) out.add(sid);
  });
  const cl = ss.getSheetByName('Canteen_Ledger');
  if (cl && cl.getLastRow() > 1) cl.getRange(2, 3, cl.getLastRow() - 1, 4).getValues().forEach(r => {
    const sid = String(r[0] || '').trim();
    if (sidSet.has(sid) && String(r[3]).toUpperCase() === 'PAYMENT') out.add(sid);
  });
  return out;
}
// Graduated students keep any unpaid balance (RolloverBalance). They are no
// longer charged term fees, but can still pay off what they owe.
function loadGraduates_() {
  const t = readStudentsTable_();
  if (!t) return [];
  const si = t.headers.indexOf('Status');
  return t.data.slice(1).filter(r => r[0] && String(r[si]).trim().toLowerCase() === 'graduated').map(r => rowToStudent_(t.headers, r));
}
function graduateSummary_(student, ledgerByStudent) {
  return computeStudentFeeSummary_(student, {}, ledgerByStudent, {});      // no term fees, only arrears
}
// Reverses a fee payment entered by mistake. The original stays on record
// (marked "Reversed") and a matching negative entry is added, so every
// balance and income report stays correct and traceable. One reversal only.
function reverseFeePayment(params) {
  clearRequestCache_();
  const { token, tid, reason } = params || {};
  const user = requireAction_(token, 'fees.reverse');
  syncConfig_();
  const why = String(reason || '').trim();
  if (!why) return { success: false, message: 'Please give a reason for the reversal.' };
  return withScriptLock_(30000, () => {
    const sh = getSpreadsheet_().getSheetByName('Fees_Ledger');
    if (!sh || sh.getLastRow() < 2) return { success: false, message: 'Payment not found.' };
    const hit = readRowsByNumber_(sh, findRowNumbers_(sh, 1, tid).slice(0, 1), 17)[0];
    if (!hit) return { success: false, message: 'Payment not found.' };
    const i = hit.row - 1;
    const row = hit.values, amt = parseFloat(row[8]) || 0;
    if (String(row[0]).indexOf('TRX') !== 0 || !(amt > 0)) return { success: false, message: 'Only a recorded payment can be reversed.' };
    if (String(row[14]) === 'Reversed' || ledgerRowByKey_(sh, 'REV|' + tid)) return { success: false, message: 'This payment has already been reversed.' };
    appendRows_(sh, [['REV' + Date.now(), row[1], row[2], row[3], CONFIG.CURRENT_TERM, CONFIG.CURRENT_ACADEMIC_YEAR, row[6], 0, -amt, 0,
                      todayStr_(), row[11], '', row[13], 'Reversal', 'Reversal of ' + row[13] + ': ' + why, 'REV|' + tid]]);
    sh.getRange(i + 1, 15).setValue('Reversed');
    const rec = findStudentRecord_(row[1]);
    if (rec) {
      const tf = rec.headers.indexOf('TotalFeesPaid');
      if (tf >= 0) rec.sheet.getRange(rec.rowIndex + 1, tf + 1).setValue(r2((parseFloat(rec.data[rec.rowIndex][tf]) || 0) - amt));
    }
    appendAudit_('REVERSE_PAYMENT', `${row[13]} — ${row[2]} (${row[1]}) GH₵${amt}: ${why}`, user.email);
    return { success: true, message: `Payment ${row[13]} (GH₵${amt.toFixed(2)}) reversed.` };
  });
}

// ==================== ROLLOVER ====================
// FIXES: graduates only at the end of Term 3 (it graduated the top class at
// EVERY term), uses the real top class, writes only the 3 changed columns
// (full-sheet writes stripped phone leading zeros), blocks double-runs.
function processRollover(params) {
  clearRequestCache_();
  const adminUser = requireRole((params || {}).token, ['Admin']);
  try {
    return withScriptLock_(60000, () => {
      syncConfig_();
      const last = Date.parse(getSetting_('LastRolloverAt') || '');
      if (!isNaN(last) && Date.now() - last < 10 * 60 * 1000)
        return { success: false, message: 'A rollover was completed less than 10 minutes ago. Refresh the page to see the new term.' };
      const ss = getSpreadsheet_();
      const st = readStudentsTable_();
      if (!st) return { success: false, message: 'Students sheet not found' };
      const sh = st.sh;
      const { feeItems, ledger, overrides } = loadFeeData_();
      const { feeItemsByClass, ledgerByStudent } = _buildFeeIndexes_(feeItems, ledger);
      const allData = st.data;
      const headers = allData[0];
      const idx = n => headers.indexOf(n);
      const rbIdx = idx('RolloverBalance'), tfIdx = idx('TotalFeesPaid'), statusIdx = idx('Status'),
            idIdx = idx('StudentID'), classIdx = idx('Class'), scholIdx = idx('Scholarship');
      const currentTerm = CONFIG.CURRENT_TERM, currentYear = CONFIG.CURRENT_ACADEMIC_YEAR;
      const yearEnd = currentTerm === 3;
      const gradClass = getTopClassCode_().toUpperCase();
      const decisions = yearEnd ? freezePromotionDecisions_(loadStudents_(), adminUser.email) : {};
      const rbCol = [], tfCol = [], stCol = [];
      let processedCount = 0, graduatedCount = 0, totalRolloverAmount = 0, graduatedRolloverAmount = 0, overpaidCount = 0, totalOverpaid = 0;
      for (let i = 1; i < allData.length; i++) {
        const row = allData[i];
        rbCol.push([row[rbIdx]]); tfCol.push([row[tfIdx]]); stCol.push([row[statusIdx]]);
        const studentId = row[idIdx] ? row[idIdx].toString().trim() : '';
        if (studentId && String(row[statusIdx]).trim().toLowerCase() === 'graduated') {
          // Graduates: no new fees, but this term's payments reduce what they owe.
          const g = graduateSummary_({ StudentID: studentId, Class: '', Scholarship: 'None', RolloverBalance: row[rbIdx] || 0 }, ledgerByStudent);
          rbCol[i - 1] = [r2(g.totalBalance)]; tfCol[i - 1] = [0];
          continue;
        }
        if (!studentId || !isActiveStatus_(row[statusIdx])) continue;
        const studentClass = row[classIdx] ? row[classIdx].toString().trim() : '';
        const sum = computeStudentFeeSummary_({ StudentID: studentId, Class: studentClass, Scholarship: row[scholIdx] || 'None',
                                               RolloverBalance: row[rbIdx] || 0 }, feeItemsByClass, ledgerByStudent, overrides);
        const bal = r2(sum.totalBalance);
        const k = i - 1;
        rbCol[k] = [bal]; tfCol[k] = [0];
        if (bal < 0) { totalOverpaid += -bal; overpaidCount++; }
        if (yearEnd && studentClass.toUpperCase() === gradClass && decisions[studentId] !== 'Repeat') {
          stCol[k] = ['Graduated']; graduatedCount++;
          if (bal > 0) graduatedRolloverAmount += bal;
        } else {
          processedCount++;
          if (bal > 0) totalRolloverAmount += bal;
        }
      }
      const n = allData.length - 1;
      // If anything fails after the students are updated (timeout, quota), put them back exactly as
      // they were, so running the rollover again can never count a term's fees twice.
      const orig = allData.slice(1);
      const putBack = () => {
        try {
          sh.getRange(2, rbIdx + 1, n, 1).setValues(orig.map(r => [r[rbIdx]]));
          sh.getRange(2, tfIdx + 1, n, 1).setValues(orig.map(r => [r[tfIdx]]));
          sh.getRange(2, statusIdx + 1, n, 1).setValues(orig.map(r => [r[statusIdx]]));
        } catch (e2) { /* nothing more can be done here */ }
      };
      if (n > 0) {
        sh.getRange(2, rbIdx + 1, n, 1).setValues(rbCol);
        sh.getRange(2, tfIdx + 1, n, 1).setValues(tfCol);
        sh.getRange(2, statusIdx + 1, n, 1).setValues(stCol);
      }
      let newTerm = currentTerm + 1, newYear = currentYear;
      try {
      if (newTerm > 3) {
        newTerm = 1;
        const [sy, ey] = currentYear.split('/').map(Number);
        newYear = `${sy + 1}/${ey + 1}`;
      }
      setSetting_('CurrentTerm', newTerm);
      setSetting_('CurrentAcademicYear', newYear);
      setSetting_('LastRolloverAt', new Date().toISOString());
      setSetting_('ArchiveDue', 'true');        // reminder until the closed term is archived
      var feeCopyResult = copyFeeItemsToNextTermInternal_(currentTerm, newTerm, currentYear, newYear);
      } catch (e) {
        putBack();
        try { setSetting_('CurrentTerm', currentTerm); setSetting_('CurrentAcademicYear', currentYear); setSetting_('LastRolloverAt', ''); } catch (e3) { /* ignore */ }
        throw e;
      }
      appendAudit_('ROLLOVER',
        `Term ${currentTerm}→${newTerm} | Year ${currentYear}→${newYear} | ${processedCount} students | ${graduatedCount} graduates | ` +
        `GH₵${totalRolloverAmount.toFixed(2)} owed (active) | GH₵${graduatedRolloverAmount.toFixed(2)} owed (graduates) | GH₵${totalOverpaid.toFixed(2)} overpaid`,
        adminUser.email);
      return {
        success: true, processedCount, graduatedCount,
        totalRolloverAmount: r2(totalRolloverAmount), graduatedRolloverAmount: r2(graduatedRolloverAmount),
        totalOverpaid: r2(totalOverpaid), overpaidCount, newTerm, newAcademicYear: newYear,
        feeItemsCopied: feeCopyResult.copied || 0,
        message: (feeCopyResult.copied || 0) > 0 ? 'Rollover completed!' : 'Rollover completed, but NO fee items were set up for the new term. Open Fees → Fee items and add or copy them before taking payments, otherwise students will show no fees.'
      };
    });
  } catch (error) {
    return { success: false, message: 'Rollover failed: ' + error.toString() };
  }
}
function copyFeeItemsToNextTermInternal_(currentTerm, newTerm, currentYear, newYear) {
  try {
    const sh = getSpreadsheet_().getSheetByName('Fee_Items');
    if (!sh) return { copied: 0 };
    const allData = sh.getDataRange().getValues().slice(1);
    const currentItems = allData.filter(r => r[0] && parseInt(r[1], 10) === currentTerm && String(r[2]).trim() === currentYear);
    if (!currentItems.length) return { copied: 0 };
    if (allData.some(r => parseInt(r[1], 10) === newTerm && String(r[2]).trim() === newYear)) return { copied: 0 };
    const newRows = currentItems.map(item => [item[0], newTerm, newYear, item[3], parseFloat(item[4]) || 0]);
    appendRows_(sh, newRows);
    return { copied: newRows.length };
  } catch (e) { return { copied: 0 }; }
}
// FIX: Term 3 used to produce "Term 4". Now wraps to Term 1 of next year.
function copyFeeItemsToNewTerm(params) {
  clearRequestCache_();
  requireRole((params || {}).token, ['Admin']);
  syncConfig_();
  return withScriptLock_(30000, () => {
    const currentTerm = CONFIG.CURRENT_TERM, currentYear = CONFIG.CURRENT_ACADEMIC_YEAR;
    let newTerm = currentTerm + 1, newYear = currentYear;
    if (newTerm > 3) { newTerm = 1; const [sy, ey] = currentYear.split('/').map(Number); newYear = `${sy + 1}/${ey + 1}`; }
    const sh = getSpreadsheet_().getSheetByName('Fee_Items');
    if (!sh) return { success: false, message: 'Fee_Items sheet not found' };
    const allData = sh.getDataRange().getValues().slice(1);
    if (!allData.some(r => r[0] && parseInt(r[1], 10) === currentTerm && String(r[2]).trim() === currentYear))
      return { success: false, message: 'No fee items found' };
    if (allData.some(r => parseInt(r[1], 10) === newTerm && String(r[2]).trim() === newYear))
      return { success: false, message: `Fee items already exist for Term ${newTerm} ${newYear}` };
    const res = copyFeeItemsToNextTermInternal_(currentTerm, newTerm, currentYear, newYear);
    return { success: true, copied: res.copied, message: `✅ Copied ${res.copied} fee items to Term ${newTerm} ${newYear}` };
  });
}

// ==================== EXPENSES ====================
function ensureExpensesTermColumns_() {
  const sh = getSpreadsheet_().getSheetByName('Expenses');
  if (!sh) return;
  ensureCols_(sh, 12);
  const headerRow = sh.getRange(1, 1, 1, 12).getValues()[0];
  if (headerRow[9] !== 'Term' || headerRow[10] !== 'AcademicYear')
    sh.getRange(1, 10, 1, 2).setValues([['Term','AcademicYear']]).setFontWeight('bold').setBackground('#006B3F').setFontColor('#FFFFFF');
  if (headerRow[11] !== 'IdempotencyKey')
    sh.getRange(1, 12).setValue('IdempotencyKey').setFontWeight('bold').setBackground('#006B3F').setFontColor('#FFFFFF');
}
function recordExpense(params) {
  clearRequestCache_();
  const { token, ...data } = params || {};
  const user = requireAccess_(token, 'expenses');
  // Payroll keys are reserved for rows posted by the Payroll page.
  const idempotencyKey = String(data.idempotencyKey || '').indexOf('PAYROLL|') === 0 ? '' : data.idempotencyKey;
  delete data.idempotencyKey;
  syncConfig_();
  const period = entryPeriod_(data);
  const amount = r2(parseFloat(data.amount));
  if (!(amount > 0)) return { success: false, message: 'Please enter an amount greater than 0.' };
  const description = String(data.description || '').trim();
  if (!description) return { success: false, message: 'Please enter a description.' };
  const category = String(data.category || 'General');
  if (data.date && String(data.date).trim() > todayStr_()) return { success: false, message: 'An expense cannot be dated in the future.' };
  return withScriptLock_(30000, () => {
    ensureExpensesTermColumns_();
    const sh = getSpreadsheet_().getSheetByName('Expenses');
    const nowMs = Date.now();
    if (idempotencyKey) {
      // A request that carries a key is matched by that key only (server-side search).
      const hit = readRowsByNumber_(sh, findRowNumbers_(sh, 12, idempotencyKey).slice(0, 1), 12)[0];
      if (hit) return { success: true, voucherNumber: hit.values[6], duplicate: true, message: 'This expense was already recorded — duplicate request safely ignored.' };
    } else {
      // No key (old client): treat an identical expense in the last 45 s as a repeat. Last 200 rows only.
      const last = sh.getLastRow(), from = Math.max(2, last - 199);
      const recent = last >= 2 ? sh.getRange(from, 1, last - from + 1, 12).getValues() : [];
      for (let i = 0; i < recent.length; i++) {
        const row = recent[i];
        if (!row[0]) continue;
        if (row[2] === description && row[3] === category && Math.abs((parseFloat(row[4]) || 0) - amount) < 0.005 &&
            row[0].toString().indexOf('EXP') === 0) {
          const ts = parseInt(row[0].toString().slice(3), 10);
          if (!isNaN(ts) && (nowMs - ts) < 45000)
            return { success: true, voucherNumber: row[6], duplicate: true, message: 'A matching expense was just recorded moments ago — treated as a duplicate.' };
        }
      }
    }
    const vn = getNextVoucherNumber_();
    sh.appendRow(fxRows_([['EXP' + nowMs, data.date || todayStr_(), description, category, amount, data.paidBy || '',
                  vn, user.email, data.notes || '', period.term, period.year, idempotencyKey || '']])[0]);
    return { success: true, voucherNumber: vn, message: 'Expense recorded' };
  });
}
function updateExpense(params) {
  clearRequestCache_();
  const { token, expenseID, date, description, category, amount, paidBy, notes } = params || {};
  requireAccess_(token, 'expenses');
  if (amount !== undefined && amount !== null && !(parseFloat(amount) > 0)) return { success: false, message: 'Please enter an amount greater than 0.' };
  if (description !== undefined && description !== null && !String(description).trim()) return { success: false, message: 'Please enter a description.' };
  if (date && String(date).trim() > todayStr_()) return { success: false, message: 'An expense cannot be dated in the future.' };
  const sh = getSpreadsheet_().getSheetByName('Expenses');
  if (!sh) return { success: false, message: 'Sheet not found' };
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][0].toString() === String(expenseID)) {
      if (String(data[i][11] || '').indexOf('PAYROLL|') === 0)
        return { success: false, message: 'This expense was posted by Payroll. To change it, reverse that month on the Payroll page and pay it again.' };
      const row = data[i].slice();
      if (date) row[1] = date;
      if (description !== undefined && description !== null) row[2] = String(description).trim();
      if (category) row[3] = category;
      if (amount !== undefined && amount !== null) row[4] = r2(parseFloat(amount));
      if (paidBy !== undefined && paidBy !== null) row[5] = paidBy;
      if (notes !== undefined && notes !== null) row[8] = notes;
      sh.getRange(i + 1, 1, 1, row.length).setValues(fxRows_([row]));
      return { success: true, message: 'Expense updated' };
    }
  }
  return { success: false, message: 'Expense not found' };
}
function getExpenses(params) {
  clearRequestCache_();
  requireAccess_((params || {}).token, 'expenses');
  const sh = getSpreadsheet_().getSheetByName('Expenses');
  if (!sh) return [];
  const raw = sh.getDataRange().getValues();
  const headers = raw[0];
  return raw.slice(1).filter(r => r[0]).map(r => {
    const obj = {};
    headers.forEach((h, idx) => { const v = fmtDate_(r[idx]); obj[h] = (v !== undefined && v !== null) ? v : ''; });
    return obj;
  }).sort((a, b) => String(b.Date || '').localeCompare(String(a.Date || '')));
}
function deleteExpense(params) {
  clearRequestCache_();
  const { token, eid } = params || {};
  const admin = requireAction_(token, 'expenses.delete');
  const sh = getSpreadsheet_().getSheetByName('Expenses');
  if (!sh) return { success: false, message: 'Sheet not found' };
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][0].toString() === String(eid)) {
      if (String(data[i][11] || '').indexOf('PAYROLL|') === 0)
        return { success: false, message: 'This expense was posted by Payroll. Reverse that month on the Payroll page instead.' };
      appendAudit_('DELETE_EXPENSE', `${data[i][2]} — GH₵${data[i][4]} (${data[i][6]})`, admin.email);
      deleteRowSafe_(sh, i + 1);
      return { success: true };
    }
  }
  return { success: false, message: 'Expense not found' };
}
function getExpenseCategories(params) {
  clearRequestCache_();
  requireAccess_((params || {}).token, 'expenses');
  const raw = getSetting_('ExpenseCategories');
  if (!raw || raw.toString().trim() === '') return [];
  return raw.toString().split(',').map(s => s.trim()).filter(Boolean);
}
function saveExpenseCategories(params) {
  clearRequestCache_();
  const { token, categories } = params || {};
  requireAccess_(token, 'expenses');
  const clean = Array.from(new Set((Array.isArray(categories) ? categories : []).map(c => String(c).replace(/,/g, ' ').trim()).filter(Boolean)));
  setSetting_('ExpenseCategories', clean.join(','));
  return { success: true, categories: clean };
}

// ==================== FINANCIAL REPORT ====================
// FIX: income was filtered to the CURRENT TERM while expenses used the date
// range only, so any range spanning terms produced a wrong net balance.
// Both sides now use the same date range.
function getFinancialReport(params) {
  clearRequestCache_();
  const { token, startDate, endDate } = params || {};
  requireAccess_(token, 'finances');
  syncConfig_();
  const start = startDate ? parseYMD_(startDate) : new Date(0);
  const end = endDate ? parseYMD_(endDate) : new Date();
  end.setHours(23, 59, 59, 999);
  let totalFees = 0;
  getAllLedgerRowsInRange_(start, end).forEach(r => { totalFees += r.amountPaid; });
  let totalExpenses = 0;
  const expensesByCategory = {};
  const expSh = getSpreadsheet_().getSheetByName('Expenses');
  if (expSh) {
    expSh.getDataRange().getValues().slice(1).forEach(row => {
      if (!row[0]) return;
      const d = parseSheetDate_(row[1]);
      if (!d || d < start || d > end) return;
      const amt = parseFloat(row[4]) || 0;
      totalExpenses += amt;
      const cat = row[3] ? row[3].toString() : 'General';
      expensesByCategory[cat] = r2((expensesByCategory[cat] || 0) + amt);
    });
  }
  // Canteen money is kept separate: see the Canteen page (Reports tab).
  return {
    success: true, totalFees: r2(totalFees), totalExpenses: r2(totalExpenses),
    netBalance: r2(totalFees - totalExpenses),
    expensesByCategory, startDate: fmtDate_(start), endDate: fmtDate_(end),
    term: CONFIG.CURRENT_TERM, academicYear: CONFIG.CURRENT_ACADEMIC_YEAR
  };
}
function getIncomeExpenditureStatement(params) {
  clearRequestCache_();
  const { token, mode, term, academicYear, startDate, endDate } = params || {};
  requireAccess_(token, 'finances');
  syncConfig_();
  const m = mode || 'custom';
  const termNames = ['', 'First Term', 'Second Term', 'Third Term'];
  const incomeByType = {}, expenditureByCategory = {};
  let totalIncome = 0, totalExpenditure = 0, periodLabel = '', rangeStart = '', rangeEnd = '';
  if (m === 'term' || m === 'annual') {
    const targetYear = String(academicYear || CONFIG.CURRENT_ACADEMIC_YEAR).trim();
    const targetTerm = m === 'term' ? parseInt(term || CONFIG.CURRENT_TERM, 10) : null;
    const ledgerSh = getSpreadsheet_().getSheetByName('Fees_Ledger');
    (ledgerSh ? ledgerSh.getDataRange().getValues().slice(1) : []).forEach(row => {
      if (!row[0] || String(row[5]).trim() !== targetYear) return;
      if (targetTerm !== null && parseInt(row[4], 10) !== targetTerm) return;
      const amt = parseFloat(row[8]) || 0;
      if (!amt) return;                                 // payments add, reversals subtract
      const type = row[6] ? row[6].toString() : 'General Payment';
      incomeByType[type] = (incomeByType[type] || 0) + amt;
      totalIncome += amt;
    });
    const expSh = getSpreadsheet_().getSheetByName('Expenses');
    (expSh ? expSh.getDataRange().getValues().slice(1) : []).forEach(row => {
      if (!row[0]) return;
      if (String(row[10] || '').trim() !== targetYear) return;
      const rowTerm = row[9] !== '' && row[9] !== null && row[9] !== undefined ? parseInt(row[9], 10) : null;
      if (targetTerm !== null && rowTerm !== targetTerm) return;
      const amt = parseFloat(row[4]) || 0;
      const cat = row[3] ? row[3].toString() : 'General';
      expenditureByCategory[cat] = (expenditureByCategory[cat] || 0) + amt;
      totalExpenditure += amt;
    });
    periodLabel = m === 'term' ? (termNames[targetTerm] || ('Term ' + targetTerm)) + ' — ' + targetYear : 'Full Academic Year — ' + targetYear;
  } else {
    const start = startDate ? parseYMD_(startDate) : new Date(0);
    const end = endDate ? parseYMD_(endDate) : new Date();
    end.setHours(23, 59, 59, 999);
    getAllLedgerRowsInRange_(start, end).forEach(r => {
      if (!r.amountPaid) return;                        // payments add, reversals subtract
      const type = r.feeType ? r.feeType.toString() : 'General Payment';
      incomeByType[type] = (incomeByType[type] || 0) + r.amountPaid;
      totalIncome += r.amountPaid;
    });
    const expSh = getSpreadsheet_().getSheetByName('Expenses');
    if (expSh) {
      expSh.getDataRange().getValues().slice(1).forEach(row => {
        if (!row[0]) return;
        const d = parseSheetDate_(row[1]);
        if (!d || d < start || d > end) return;
        const amt = parseFloat(row[4]) || 0;
        const cat = row[3] ? row[3].toString() : 'General';
        expenditureByCategory[cat] = (expenditureByCategory[cat] || 0) + amt;
        totalExpenditure += amt;
      });
    }
    rangeStart = fmtDate_(start); rangeEnd = fmtDate_(end);
    periodLabel = 'Custom Period — ' + rangeStart + ' to ' + rangeEnd;
  }
  return {
    success: true, mode: m, periodLabel, startDate: rangeStart, endDate: rangeEnd,
    incomeRows: Object.keys(incomeByType).sort().map(k => ({ label: k, amount: r2(incomeByType[k]) })),
    expenditureRows: Object.keys(expenditureByCategory).sort().map(k => ({ label: k, amount: r2(expenditureByCategory[k]) })),
    totalIncome: r2(totalIncome), totalExpenditure: r2(totalExpenditure), netSurplus: r2(totalIncome - totalExpenditure),
    schoolName: getSetting_('SchoolName') || CONFIG.SCHOOL_NAME, term: CONFIG.CURRENT_TERM, academicYear: CONFIG.CURRENT_ACADEMIC_YEAR
  };
}

// ==================== RESULTS ====================
function calculateGESGrade_(score) {
  if (score >= 80) return { grade: 1, descriptor: 'Excellent' };
  if (score >= 70) return { grade: 2, descriptor: 'Very Good' };
  if (score >= 65) return { grade: 3, descriptor: 'Good' };
  if (score >= 60) return { grade: 4, descriptor: 'High Average' };
  if (score >= 55) return { grade: 5, descriptor: 'Average' };
  if (score >= 50) return { grade: 6, descriptor: 'Low Average' };
  if (score >= 45) return { grade: 7, descriptor: 'Pass' };
  if (score >= 40) return { grade: 8, descriptor: 'Pass (Low)' };
  return { grade: 9, descriptor: 'Fail' };
}
// Teachers enter raw scores out of 100; they're scaled to the configured
// weights before storage. ONE routine saves scores for any number of
// students: it reads the sheet once, never creates a second row for the
// same student+subject in a term, and writes in as few calls as possible.
// entries: [{ student, subject, rawClass, rawExam }]
function saveScores_(entries, period) {
  const weights = getWeights_();
  const sh = getSpreadsheet_().getSheetByName('Results_Entry');
  if (!sh) throw new Error('Results_Entry sheet missing');
  const term = period ? period.term : CONFIG.CURRENT_TERM, ay = period ? period.year : CONFIG.CURRENT_ACADEMIC_YEAR;
  const r1 = v => Math.round(v * 10) / 10;
  const rowOf = {}, current = {};
  const n = sh.getLastRow() - 1;
  if (n > 0) sh.getRange(2, 2, n, 8).getValues().forEach((r, i) => {        // SID, Name, Class, Term, Year, Subject, ClassScore, ExamScore
    if (!r[0] || parseInt(r[3], 10) !== term || String(r[4]).trim() !== ay) return;
    const key = String(r[0]).trim() + '|' + String(r[5]).trim();
    rowOf[key] = i + 2; current[key] = [parseFloat(r[6]) || 0, parseFloat(r[7]) || 0];
  });
  const latest = {};                                    // duplicates in one save: last one wins
  entries.forEach(e => { latest[e.student.StudentID + '|' + e.subject] = e; });
  const updates = [], inserts = [];
  let k = 0;
  const stamp = Date.now();
  Object.keys(latest).forEach(key => {
    const e = latest[key];
    const cs = r1(e.rawClass * weights.classWeight / 100), es = r1(e.rawExam * weights.examWeight / 100), total = r1(cs + es);
    const vals = [cs, es, total, calculateGESGrade_(total).grade];
    if (rowOf[key]) {
      if (Math.abs(current[key][0] - cs) < 0.05 && Math.abs(current[key][1] - es) < 0.05) return;   // unchanged → no write
      updates.push({ row: rowOf[key], vals });
    }
    else inserts.push(['RES' + stamp + '_' + (k++), e.student.StudentID, e.student.FullName, e.student.Class, term, ay, e.subject].concat(vals));
  });
  updates.sort((a, b) => a.row - b.row);
  let i = 0;
  while (i < updates.length) {
    let j = i;
    while (j + 1 < updates.length && updates[j + 1].row === updates[j].row + 1) j++;
    sh.getRange(updates[i].row, 8, j - i + 1, 4).setValues(updates.slice(i, j + 1).map(u => u.vals));
    i = j + 1;
  }
  appendRows_(sh, inserts);
  return updates.length + inserts.length;
}
function validRaw_(v) { const n = parseFloat(v); return String(v).trim() !== '' && !isNaN(n) && n >= 0 && n <= 100 ? n : null; }
function recordSubjectScoreBatch(params) {
  clearRequestCache_();
  const { token, studentID, scores } = params || {};
  requireAccess_(token, 'results');
  syncConfig_();
  if (!Array.isArray(scores) || !scores.length) return { success: false, message: 'No scores to save.' };
  const student = getStudentByIdDirect_(studentID);
  if (!student) return { success: false, message: 'Student not found' };
  const entries = [], rejected = [];
  scores.forEach(sc => {
    const c = validRaw_(sc.classScore), x = validRaw_(sc.examScore);
    if (c === null || x === null || !sc.subject) { rejected.push(sc.subject); return; }
    entries.push({ student, subject: String(sc.subject), rawClass: c, rawExam: x });
  });
  const period = entryPeriod_(params);
  return withScriptLock_(30000, () => {
    const saved = entries.length ? saveScores_(entries, period) : 0;
    return { success: true, saved, rejected,
             message: rejected.length ? `Scores saved. Skipped invalid entries for: ${rejected.join(', ')}` : 'Scores saved' };
  });
}
// ---------- Class results template (download → fill → upload) ----------
function resultsTemplateHeaders_(subjects, cls) {
  const h = ['Student ID [' + cls + ']', 'Student Name'];
  subjects.forEach(s => { h.push(s + ' - Class (out of 100)', s + ' - Exam (out of 100)'); });
  h.push('Conduct');
  return h;
}
// Data for the class results workbook (built as an Excel file in the
// browser: names/IDs locked, score cells limited to 0–100, a Conduct dropdown).
function getClassResultsTemplate(params) {
  clearRequestCache_();
  const { token, classCode } = params || {};
  requireAccess_(token, 'results');
  syncConfig_();
  const cls = validClassCode_(classCode);
  if (!cls) return { success: false, message: 'Please choose a class.' };
  const subjects = getSubjectsForCategory_(categoryForClass_(cls));
  if (!subjects.length) return { success: false, message: 'No subjects are set up for this class. Add them in Settings → Subjects.' };
  const w = getWeights_();
  const raw = (v, wt) => wt > 0 ? Math.round(v / wt * 100 * 10) / 10 : 0;
  const results = loadResultsByStudent_();
  const conduct = getAllConductRecords_();
  const students = loadStudents_().filter(s => s.Class === cls).sort((a, b) => String(a.FullName).localeCompare(String(b.FullName)));
  const clsObj = getClasses_().find(c => c.code === cls);
  return {
    success: true, classCode: cls, className: clsObj ? clsObj.name : cls, term: CONFIG.CURRENT_TERM, academicYear: CONFIG.CURRENT_ACADEMIC_YEAR,
    schoolName: getSetting_('SchoolName') || CONFIG.SCHOOL_NAME, subjects, conductOptions: CONDUCT_OPTIONS,
    headers: resultsTemplateHeaders_(subjects, cls),
    rows: students.map(s => {
      const my = results[s.StudentID] || {};
      const row = [s.StudentID, s.FullName];
      subjects.forEach(sub => { const r = my[sub]; row.push(r ? raw(r.classScore, w.classWeight) : '', r ? raw(r.examScore, w.examWeight) : ''); });
      row.push(conduct[s.StudentID] || '');
      return row;
    })
  };
}
// Saves conduct ratings for many students with one read and few writes.
function saveConductBatch_(list, userEmail) {
  if (!list.length) return 0;
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName('Conduct_Records');
  if (!sh) {
    sh = ss.insertSheet('Conduct_Records');
    sh.getRange(1, 1, 1, 8).setValues([['StudentID','StudentName','Class','Term','AcademicYear','Conduct','UpdatedBy','UpdatedDate']])
      .setFontWeight('bold').setBackground('#006B3F').setFontColor('#FFFFFF');
  }
  const term = CONFIG.CURRENT_TERM, ay = CONFIG.CURRENT_ACADEMIC_YEAR, now = new Date().toISOString();
  const rowOf = {};
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues().forEach((r, i) => {
    if (r[0] && parseInt(r[3], 10) === term && String(r[4]).trim() === ay) rowOf[String(r[0]).trim()] = { row: i + 2, conduct: String(r[5]) };
  });
  const inserts = [];
  let changed = 0;
  list.forEach(x => {
    const row = [x.student.StudentID, x.student.FullName, x.student.Class, term, ay, x.conduct, userEmail, now];
    const ex = rowOf[x.student.StudentID];
    if (ex) { if (ex.conduct !== x.conduct) { sh.getRange(ex.row, 1, 1, 8).setValues(fxRows_([row])); changed++; } }
    else { inserts.push(row); rowOf[x.student.StudentID] = { row: -1, conduct: x.conduct }; changed++; }
  });
  appendRows_(sh, inserts);
  return changed;
}
// Saves a filled class workbook. `rows` = the sheet's cells (from the Excel
// file, read in the browser) — or `csv` text. Blank cells keep what's saved.
// Problems are reported by row; valid rows are saved; re-uploading the same
// file changes nothing.
function uploadClassResults(params) {
  clearRequestCache_();
  const { token, classCode, csv } = params || {};
  const user = requireAccess_(token, 'results');
  syncConfig_();
  const cls = validClassCode_(classCode);
  if (!cls) return { success: false, message: 'Please choose a class.' };
  let rows = params.rows;
  if (!Array.isArray(rows)) {
    try { rows = Utilities.parseCsv(String(csv || '').replace(/^﻿/, '')); }
    catch (e) { return { success: false, message: 'Could not read the file. Use the downloaded Excel template.' }; }
  }
  rows = rows.map(r => (Array.isArray(r) ? r : []).map(v => v === null || v === undefined ? '' : String(v)));
  const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const hIdx = rows.findIndex(r => r.some(v => norm(v).indexOf('student id') === 0));
  if (hIdx < 0) return { success: false, message: 'The "Student ID" heading is missing. Please download a fresh template.' };
  const headRaw = rows[hIdx], head = headRaw.map(norm);
  const idCol = head.findIndex(h => h.indexOf('student id') === 0);
  const tag = /\[([^\]]+)\]/.exec(headRaw[idCol] || '');
  if (tag && tag[1].trim().toUpperCase() !== cls.toUpperCase())
    return { success: false, message: `This file is the template for ${tag[1].trim()}, not ${cls}. Choose ${tag[1].trim()} in the class list, or download the ${cls} template.` };
  const subjects = getSubjectsForCategory_(categoryForClass_(cls));
  const cols = {}, missing = [];
  subjects.forEach(sub => {
    const c = head.indexOf(norm(sub + ' - Class (out of 100)')), x = head.indexOf(norm(sub + ' - Exam (out of 100)'));
    if (c < 0 || x < 0) missing.push(sub); else cols[sub] = [c, x];
  });
  const conductCol = head.indexOf('conduct');
  if (missing.length === subjects.length && conductCol < 0) return { success: false, message: `This file doesn't match ${cls}'s subjects. Please download the template for ${cls} again.` };
  const options = {};
  CONDUCT_OPTIONS.forEach(o => { options[norm(o)] = o; });
  const inClass = {};
  loadStudents_().filter(s => s.Class === cls).forEach(s => { inClass[s.StudentID] = s; });
  const entries = [], conducts = [], problems = [], seen = {};
  let studentsWithScores = 0;
  rows.slice(hIdx + 1).forEach((r, k) => {
    if (!r.some(v => String(v).trim() !== '')) return;
    const line = hIdx + k + 2, sid = String(r[idCol] || '').trim();
    if (!sid) { problems.push(`Row ${line}: no Student ID.`); return; }
    const st = inClass[sid];
    if (!st) { problems.push(`Row ${line}: ${sid} is not an active student in ${cls}.`); return; }
    if (seen[sid]) { problems.push(`Row ${line}: ${sid} appears more than once (first copy on row ${seen[sid]} used).`); return; }
    seen[sid] = line;
    let any = false;
    Object.keys(cols).forEach(sub => {
      const cv = String(r[cols[sub][0]] || '').trim(), xv = String(r[cols[sub][1]] || '').trim();
      if (cv === '' && xv === '') return;                        // left blank → keep what's saved
      const c = validRaw_(cv), x = validRaw_(xv);
      if (c === null || x === null) { problems.push(`Row ${line} (${st.FullName}), ${sub}: both scores must be numbers from 0 to 100.`); return; }
      entries.push({ student: st, subject: sub, rawClass: c, rawExam: x }); any = true;
    });
    if (any) studentsWithScores++;
    if (conductCol >= 0) {
      const cv = String(r[conductCol] || '').trim();
      if (cv) {
        if (options[norm(cv)]) conducts.push({ student: st, conduct: options[norm(cv)] });
        else problems.push(`Row ${line} (${st.FullName}): "${cv}" is not one of the conduct options.`);
      }
    }
  });
  if (!entries.length && !conducts.length) return { success: false, message: 'No scores or conduct found to save.', problems, missingSubjects: missing };
  return withScriptLock_(60000, () => {
    const saved = entries.length ? saveScores_(entries) : 0;
    const conductSaved = saveConductBatch_(conducts, user.email);
    const parts = [];
    if (saved) parts.push(`${saved} subject score(s)`);
    if (conductSaved) parts.push(`conduct for ${conductSaved} student(s)`);
    return { success: true, saved, conductSaved, students: studentsWithScores, problems, missingSubjects: missing,
             message: (parts.length ? 'Saved ' + parts.join(' and ') + '.' : 'No changes — everything in the file was already saved.') +
                      (problems.length ? ` ${problems.length} problem(s) — see list.` : '') };
  });
}
// Also returns the raw (out-of-100) values so the entry form can be
// pre-filled — previously it always showed 0s, and saving a partial edit
// wiped existing scores.
function getStudentResults(params) {
  clearRequestCache_();
  const { token, sid } = params || {};
  requireAccess_(token, 'results');
  syncConfig_();
  const w = getWeights_();
  const raw = (v, wt) => wt > 0 ? Math.round(v / wt * 100 * 10) / 10 : 0;
  const sh = getSpreadsheet_().getSheetByName('Results_Entry');
  if (!sh) return [];
  // Only this student's rows are read (server-side search on the StudentID column).
  return readRowsByNumber_(sh, findRowNumbers_(sh, 2, String(sid).trim()), 11).map(x => x.values)
    .filter(r => r[1] && r[1].toString().trim() === String(sid).trim() && parseInt(r[4], 10) === CONFIG.CURRENT_TERM && String(r[5]).trim() === CONFIG.CURRENT_ACADEMIC_YEAR)
    .map(r => {
      const cs = parseFloat(r[7]) || 0, es = parseFloat(r[8]) || 0;
      return { subject: r[6], classScore: cs, examScore: es, total: parseFloat(r[9]) || 0, grade: parseInt(r[10], 10) || 0,
               rawClass: raw(cs, w.classWeight), rawExam: raw(es, w.examWeight) };
    });
}
function loadResultsByStudent_() {
  const resSh = getSpreadsheet_().getSheetByName('Results_Entry');
  const map = {};
  // Term/year (columns E:F) are read for every row; the other columns only for this term's rows.
  (resSh ? readRowsWhere_(resSh, 5, 2, p => parseInt(p[0], 10) === CONFIG.CURRENT_TERM && String(p[1]).trim() === CONFIG.CURRENT_ACADEMIC_YEAR, 11) : []).forEach(r => {
    if (parseInt(r[4], 10) !== CONFIG.CURRENT_TERM || String(r[5]).trim() !== CONFIG.CURRENT_ACADEMIC_YEAR) return;
    const sid = r[1] ? r[1].toString().trim() : '';
    if (!sid) return;
    (map[sid] = map[sid] || {})[r[6]] = {
      classScore: parseFloat(r[7]) || 0, examScore: parseFloat(r[8]) || 0, total: parseFloat(r[9]) || 0, grade: parseInt(r[10], 10) || 0
    };
  });
  return map;
}
function rankRows_(rows, key) {
  rows.sort((a, b) => b[key] - a[key]);
  let last = null, pos = 0;
  rows.forEach((row, i) => { if (row[key] !== last) { pos = i + 1; last = row[key]; } row.position = pos; });
  return rows;
}
function getClassBroadsheet(params) {
  clearRequestCache_();
  const { token, classCode } = params || {};
  requireAccess_(token, 'results');
  syncConfig_();
  if (!classCode || classCode === 'All') return { success: false, message: 'Please select a specific class.' };
  const classes = getClasses_();
  const cls = classes.find(c => c.code.toUpperCase() === classCode.toUpperCase());
  const category = cls ? cls.category : getClassCategory_(classCode);
  const className = cls ? cls.name : classCode;
  const subjects = getSubjectsForCategory_(category);
  const students = loadStudents_().filter(s => s.Class === classCode);
  const base = { success: true, classCode, className, category, subjects, term: CONFIG.CURRENT_TERM, academicYear: CONFIG.CURRENT_ACADEMIC_YEAR };
  if (!students.length) return Object.assign(base, { rows: [] });
  const resultsByStudent = loadResultsByStudent_();
  const decisions = CONFIG.CURRENT_TERM === 3 ? readPromotionDecisions_(CONFIG.CURRENT_ACADEMIC_YEAR) : {};
  const passMark = promotionPassMark_();
  const rows = students.map(student => {
    const my = resultsByStudent[student.StudentID] || {};
    const scores = {};
    let grandTotal = 0;
    subjects.forEach(sub => {
      const r = my[sub];
      scores[sub] = { total: r ? r.total : 0, grade: r ? r.grade : null };
      grandTotal += r ? r.total : 0;
    });
    const average = subjects.length ? grandTotal / subjects.length : 0;
    return { studentID: student.StudentID, studentName: student.FullName, scores,
             grandTotal: r2(grandTotal), average: r2(average),
             decision: CONFIG.CURRENT_TERM === 3 ? decidePromotion_(average, decisions[student.StudentID], passMark).decision : '' };
  });
  return Object.assign(base, { rows: rankRows_(rows, 'grandTotal') });
}

// ==================== ATTENDANCE ====================
// "Late" counts as attended on the report card.
const isPresentStatus_ = s => { const v = String(s || '').toLowerCase(); return v === 'present' || v === 'late'; };
// NEW: lets the attendance screen show what was already saved for a date
// (it always reset everyone to "Present", silently overwriting records).
// Reads only the columns attendance needs (StudentID … Status), not the
// whole sheet, and matches dates with plain number comparisons.
function readAttendanceDay_(sh, dateObj) {
  const lastRow = sh.getLastRow();
  const t0 = dateObj.getTime(), t1 = t0 + 86400000;
  const out = { map: {}, rowOf: {} };
  if (lastRow < 2) return out;
  const vals = sh.getRange(2, 2, lastRow - 1, 5).getValues();   // SID, Name, Class, Date, Status
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (!v[0]) continue;
    let d = v[3];
    if (!(d instanceof Date)) { d = parseSheetDate_(d); if (!d) continue; }
    const t = d.getTime();
    if (t < t0 || t >= t1) continue;
    const sid = String(v[0]).trim();
    out.map[sid] = String(v[4] || '');
    out.rowOf[sid] = i + 2;
  }
  return out;
}
function attendanceArchiveGuard_(ymd) {
  const through = String(getSetting_('AttendanceArchivedThrough') || '');
  return through && ymd <= through ? `Attendance up to ${through} belongs to closed terms that have been archived and can no longer be changed.` : '';
}
function getAttendanceForDate(params) {
  clearRequestCache_();
  const { token, date } = params || {};
  requireAccess_(token, 'attendance');
  const target = parseYMD_(date);
  if (!target) return {};
  target.setHours(0, 0, 0, 0);
  const sh = getSpreadsheet_().getSheetByName('Attendance');
  return sh ? readAttendanceDay_(sh, target).map : {};
}
function markAttendanceBatch(params) {
  clearRequestCache_();
  const { token, date, records } = params || {};
  requireAccess_(token, 'attendance');
  syncConfig_();
  if (!Array.isArray(records) || !records.length) return { success: false, message: 'No attendance records to save.' };
  const dateObj = parseYMD_(date);
  if (!dateObj) return { success: false, message: 'Please choose a valid date.' };
  dateObj.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(23, 59, 59, 999);
  if (dateObj > today) return { success: false, message: 'Attendance cannot be recorded for a future date.' };
  const guard = attendanceArchiveGuard_(String(date).trim());
  if (guard) return { success: false, message: guard };
  const sh = getSpreadsheet_().getSheetByName('Attendance');
  if (!sh) return { success: false, message: 'Attendance sheet missing' };
  const _p = entryPeriod_(params), term = _p.term, ay = _p.year;
  return withScriptLock_(30000, () => {
    const day = readAttendanceDay_(sh, dateObj);
    loadStudents_();
    const updates = [], inserts = [], seen = new Set();
    const stamp = Date.now();
    records.forEach((rec, n) => {
      const student = _studentsIndex[String(rec.studentID).trim()];
      if (!student || !ATTENDANCE_STATUSES.includes(rec.status) || seen.has(student.StudentID)) return;
      seen.add(student.StudentID);
      const row = day.rowOf[student.StudentID];
      if (row) { if (day.map[student.StudentID] !== rec.status) updates.push({ row, status: rec.status }); }
      else inserts.push(['ATT' + stamp + '_' + n, student.StudentID, student.FullName, student.Class, dateObj, rec.status, term, ay]);
    });
    // Changed statuses are written in contiguous blocks (one write per block)
    // instead of rewriting the whole Status column.
    updates.sort((x, y) => x.row - y.row);
    let i = 0;
    while (i < updates.length) {
      let j = i;
      while (j + 1 < updates.length && updates[j + 1].row === updates[j].row + 1) j++;
      sh.getRange(updates[i].row, 6, j - i + 1, 1).setValues(updates.slice(i, j + 1).map(u => [u.status]));
      i = j + 1;
    }
    if (inserts.length) appendRows_(sh, inserts);
    return { success: true, message: `Attendance saved (${inserts.length} new, ${updates.length} changed).` };
  });
}

// ==================== CONDUCT ====================
const CONDUCT_OPTIONS = [
  'Well-behaved', 'Neat and respectful', 'Obedient and responsible', 'Calm and creative',
  'Works well with others', 'Courageous and confident', 'Actively contributes in class',
  'Polite and courteous', 'Honest and trustworthy', 'Displays good leadership qualities',
  'Shows respect for school rules', 'Maintains a positive attitude', 'Punctual and dependable'
];
function upsertStudentConduct_(sid, studentName, className, conduct, userEmail, period) {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName('Conduct_Records');
  if (!sh) {
    sh = ss.insertSheet('Conduct_Records');
    sh.getRange(1, 1, 1, 8).setValues([['StudentID','StudentName','Class','Term','AcademicYear','Conduct','UpdatedBy','UpdatedDate']])
      .setFontWeight('bold').setBackground('#006B3F').setFontColor('#FFFFFF');
  }
  const term = period ? period.term : CONFIG.CURRENT_TERM, ay = period ? period.year : CONFIG.CURRENT_ACADEMIC_YEAR;
  const data = sh.getDataRange().getValues();
  const row = [sid, studentName, className, term, ay, conduct, userEmail, new Date().toISOString()];
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][0].toString().trim() === sid && parseInt(data[i][3], 10) === term && String(data[i][4]).trim() === ay) {
      sh.getRange(i + 1, 1, 1, 8).setValues(fxRows_([row])); return;
    }
  }
  sh.appendRow(fxRows_([row])[0]);
}
function getAllConductRecords_() {
  const sh = getSpreadsheet_().getSheetByName('Conduct_Records');
  const map = {};
  if (!sh) return map;
  readRowsWhere_(sh, 4, 2, p => parseInt(p[0], 10) === CONFIG.CURRENT_TERM && String(p[1]).trim() === CONFIG.CURRENT_ACADEMIC_YEAR, 6).forEach(row => {
    if (row[0] && parseInt(row[3], 10) === CONFIG.CURRENT_TERM && String(row[4]).trim() === CONFIG.CURRENT_ACADEMIC_YEAR)
      map[row[0].toString().trim()] = row[5] || null;
  });
  return map;
}
function getConductOptions(params) {
  clearRequestCache_();
  requireAccess_((params || {}).token, 'results');
  return CONDUCT_OPTIONS;
}
function getStudentConduct(params) {
  clearRequestCache_();
  const { token, sid } = params || {};
  requireAccess_(token, 'results');
  syncConfig_();
  return { success: true, conduct: getAllConductRecords_()[String(sid).trim()] || null };
}
function saveStudentConduct(params) {
  clearRequestCache_();
  const { token, sid, conduct } = params || {};
  const user = requireAccess_(token, 'results');
  syncConfig_();
  if (!conduct || CONDUCT_OPTIONS.indexOf(conduct) === -1) return { success: false, message: 'Please select a valid conduct rating.' };
  const student = getStudentByIdDirect_(sid);
  if (!student) return { success: false, message: 'Student not found' };
  return withScriptLock_(30000, () => {
    upsertStudentConduct_(student.StudentID, student.FullName, student.Class, conduct, user.email, entryPeriod_(params));
    return { success: true, message: 'Conduct saved' };
  });
}

// ==================== REPORT CARDS ====================
function teacherRemark_(avg) {
  return avg >= 80 ? 'Excellent performance!' : avg >= 70 ? 'Very good performance.' : avg >= 65 ? 'Good performance.'
    : avg >= 60 ? 'High average.' : avg >= 55 ? 'Average performance.' : avg >= 50 ? 'Below average.'
    : avg >= 45 ? 'Needs improvement.' : avg >= 40 ? 'Poor performance.' : 'Very poor performance.';
}
function reportSchoolInfo_() {
  return {
    schoolName: getSetting_('SchoolName') || CONFIG.SCHOOL_NAME,
    schoolMotto: getSetting_('SchoolMotto') || CONFIG.SCHOOL_MOTTO,
    schoolAddress: (getSetting_('SchoolAddress') || CONFIG.SCHOOL_ADDRESS) + ' | Tel: ' + (getSetting_('SchoolPhone') || CONFIG.SCHOOL_PHONE),
    schoolCrest: getSetting_('SchoolCrest') || '',
    nextTermBegins: String(getSetting_('NextTermBegins') || '')
  };
}
// Builds report cards for a list of students using shared, pre-loaded data.
// Single and batch generation share this so they can never disagree.
// `shared` = true → school details (incl. the crest image) are NOT copied
// into every card; the batch returns them once and the page merges them.
function buildReportCards_(students, shared) {
  const info = shared ? {} : reportSchoolInfo_();
  const photos = getStudentPhotos_(new Set(students.map(s => s.StudentID)));
  const weights = getWeights_();
  const classes = getClasses_();
  const subjectsByCategory = loadSubjectsByCategory_();
  const resultsByStudent = loadResultsByStudent_();
  const thirdTerm = CONFIG.CURRENT_TERM === 3;
  const decisions = thirdTerm ? readPromotionDecisions_(CONFIG.CURRENT_ACADEMIC_YEAR) : {};
  const passMark = thirdTerm ? promotionPassMark_() : 0;
  const attByStudent = {};
  const attSh = getSpreadsheet_().getSheetByName('Attendance');
  if (attSh && attSh.getLastRow() > 1) {
    // Only StudentID + Status/Term/Year columns (4 of 8).
    const n = attSh.getLastRow() - 1;
    const ids = attSh.getRange(2, 2, n, 1).getValues(), rest = attSh.getRange(2, 6, n, 3).getValues();
    for (let i = 0; i < n; i++) {
      const r = rest[i];
      if (!ids[i][0] || parseInt(r[1], 10) !== CONFIG.CURRENT_TERM || String(r[2]).trim() !== CONFIG.CURRENT_ACADEMIC_YEAR) continue;
      const sid = ids[i][0].toString().trim();
      const a = attByStudent[sid] = attByStudent[sid] || { present: 0, total: 0 };
      a.total++;
      if (isPresentStatus_(r[0])) a.present++;
    }
  }
  const conductByStudent = getAllConductRecords_();
  // Current-term fee balance (incl. arrears) for the "Outstanding Fees" box,
  // computed once for the whole batch.
  let feeIdx = null;
  try {
    const idx = _buildFeeIndexes_(getFeeItems_(), getLedgerRows_());
    feeIdx = { feeItemsByClass: idx.feeItemsByClass, ledgerByStudent: idx.ledgerByStudent, overrides: getStudentFeeOverridesAll_() };
  } catch (e) { console.error('Report card fee balance failed', e); }
  const feeBalanceFor = st => {
    if (!feeIdx) return null;
    try { return computeStudentFeeSummary_(st, feeIdx.feeItemsByClass, feeIdx.ledgerByStudent, feeIdx.overrides).totalBalance; }
    catch (e) { return null; }
  };
  // FIX: classmates were filtered with Status === 'Active' (case-sensitive),
  // so students with "active"/blank status got position 0.
  const byClass = {};
  loadStudents_().forEach(s => { (byClass[s.Class] = byClass[s.Class] || []).push(s); });
  const classCtx = {};
  const ctxFor = cls => {
    if (classCtx[cls]) return classCtx[cls];
    const subjects = subjectsByCategory[categoryForClass_(cls, classes)] || [];
    const mates = byClass[cls] || [];
    // Overall position: only students with at least one score are ranked.
    const ranks = rankRows_(mates.filter(s => {
      const pr = resultsByStudent[s.StudentID] || {};
      return subjects.some(sub => pr[sub]);
    }).map(s => {
      const pr = resultsByStudent[s.StudentID] || {};
      // rounded to 0.1 so that 0.1+0.2-style sums cannot split a genuine tie
      return { id: s.StudentID, grandTotal: Math.round(subjects.reduce((sum, sub) => sum + (pr[sub] ? pr[sub].total : 0), 0) * 10) / 10 };
    }), 'grandTotal');
    classCtx[cls] = {
      subjects, ranks, outOf: ranks.length,
      positions: computeSubjectPositions_(subjects, mates.map(s => s.StudentID), resultsByStudent)
    };
    return classCtx[cls];
  };
  return students.map(student => {
    const ctx = ctxFor(student.Class);
    const my = resultsByStudent[student.StudentID] || {};
    let totalScore = 0;
    const subjectRows = ctx.subjects.map(sub => {
      const r = my[sub] || { classScore: 0, examScore: 0, total: 0 };
      const g = calculateGESGrade_(r.total);
      totalScore += r.total;
      return { name: sub, classScore: r.classScore, examScore: r.examScore, total: r.total,
               position: (ctx.positions[sub] && ctx.positions[sub][student.StudentID]) || 0, grade: g.grade, descriptor: g.descriptor };
    });
    const avg = ctx.subjects.length ? totalScore / ctx.subjects.length : 0;
    const myRank = ctx.ranks.find(r => r.id === student.StudentID);
    const explicitConduct = conductByStudent[student.StudentID] || null;
    return Object.assign({}, info, {
      student: { FullName: student.FullName, StudentID: student.StudentID, Class: student.Class, Gender: student.Gender },
      term: CONFIG.CURRENT_TERM, academicYear: CONFIG.CURRENT_ACADEMIC_YEAR,
      promotion: thirdTerm ? promotionLabel_(decidePromotion_(avg, decisions[student.StudentID], passMark).decision, student.Class) : null,
      studentPhoto: photos[student.StudentID] || '', scoreWeights: weights,
      subjects: subjectRows, totalScore: Math.round(totalScore * 10) / 10, average: Math.round(avg * 100) / 100,
      rank: Object.keys(my).some(sub => ctx.subjects.indexOf(sub) >= 0)
        ? { rank: myRank ? myRank.position : 0, outOf: ctx.outOf } : { rank: 0, outOf: ctx.outOf },
      teacherRemark: teacherRemark_(avg), attendance: attByStudent[student.StudentID] || { present: 0, total: 0 },
      conduct: explicitConduct || '',          // set by the teacher; never auto-generated
      feeBalance: feeBalanceFor(student)
    });
  });
}
function generateReportCard(params) {
  clearRequestCache_();
  const { token, sid } = params || {};
  requireAccess_(token, 'report');
  try {
    syncConfig_();
    const student = getStudentByIdDirect_(sid);
    if (!student) return { error: true, message: 'Student not found (they may be inactive or graduated).' };
    return buildReportCards_([student])[0];
  } catch (e) {
    return { error: true, message: 'generateReportCard failed for sid=' + sid + ': ' + (e && e.message ? e.message : e) };
  }
}
function generateReportCardsBatch(params) {
  clearRequestCache_();
  const { token, classCode, studentIDs } = params || {};
  requireAccess_(token, 'report');
  try {
    syncConfig_();
    let students = loadStudents_();
    if (Array.isArray(studentIDs) && studentIDs.length) {
      const idSet = new Set(studentIDs.map(s => String(s).trim()));
      students = students.filter(s => idSet.has(s.StudentID));
    } else if (classCode && classCode !== 'All') {
      students = students.filter(s => s.Class === classCode);
    }
    if (!students.length) return { success: true, count: 0, reportCards: [], school: reportSchoolInfo_() };
    // One class per call keeps each response small (photos are ~10–50 KB
    // each); the page asks for "All classes" one class at a time.
    if (students.length > 250) return { success: false, message: 'Too many students in one request — please print one class at a time.' };
    const reportCards = buildReportCards_(students, true).sort((a, b) =>
      a.student.Class !== b.student.Class ? String(a.student.Class).localeCompare(String(b.student.Class))
                                          : String(a.student.FullName).localeCompare(String(b.student.FullName)));
    return { success: true, count: reportCards.length, reportCards, school: reportSchoolInfo_() };
  } catch (e) {
    return { success: false, message: 'generateReportCardsBatch failed (class=' + classCode + '): ' + (e && e.message ? e.message : e) };
  }
}

// ==================== PROMOTION DECISIONS (Third Term) ====================
// Each student's Third Term report says "Promoted to …" or "Repeated".
//   • Automatic: promoted, unless a pass mark is set (Settings → School Info)
//     and the student's Third Term average is below it.
//   • Manual: a teacher can set Promote / Repeat for a student (Results).
// At the Third Term rollover every decision is frozen in Promotion_Decisions,
// and "Promote All Students" then keeps repeated students in their class.
const PROMO_SHEET = 'Promotion_Decisions';
const PROMO_HEADERS = ['StudentID', 'StudentName', 'Class', 'AcademicYear', 'Decision', 'Source', 'Average', 'UpdatedBy', 'UpdatedDate'];
function promoSheet_(create) {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(PROMO_SHEET);
  if (!sh && create) {
    sh = ss.insertSheet(PROMO_SHEET);
    sh.getRange(1, 1, 1, PROMO_HEADERS.length).setValues([PROMO_HEADERS]).setFontWeight('bold').setBackground('#006B3F').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
    trimColumns_(sh, PROMO_HEADERS.length);
  }
  return sh || null;
}
function promotionPassMark_() { return Math.max(0, Math.min(100, numSetting_('PromotionPassMark', 0))); }
// { sid: { decision, source, average, row } } for one academic year
function readPromotionDecisions_(year) {
  const sh = promoSheet_(false), out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, PROMO_HEADERS.length).getValues().forEach((r, i) => {
    if (!r[0] || String(r[3]).trim() !== String(year).trim()) return;
    out[String(r[0]).trim()] = { decision: String(r[4]), source: String(r[5]), average: parseFloat(r[6]) || 0, row: i + 2 };
  });
  return out;
}
function decidePromotion_(average, manual, passMark) {
  if (manual && manual.source === 'Manual' && (manual.decision === 'Promote' || manual.decision === 'Repeat'))
    return { decision: manual.decision, source: 'Manual' };
  return { decision: passMark > 0 && average < passMark ? 'Repeat' : 'Promote', source: 'Auto' };
}
function loadSubjectsByCategory_() {
  const map = {};
  const sh = getSpreadsheet_().getSheetByName('Subjects');
  (sh ? sh.getDataRange().getValues().slice(1) : []).forEach(r => {
    const cat = String(r[0] || '').trim(), sub = String(r[1] || '').trim();
    if (cat && sub) (map[cat] = map[cat] || []).push(sub);
  });
  return map;
}
// Current-term average per student — the same figure as on the report card.
function termAverages_(students, subjectsByCategory, resultsByStudent) {
  const classes = getClasses_();
  subjectsByCategory = subjectsByCategory || loadSubjectsByCategory_();
  resultsByStudent = resultsByStudent || loadResultsByStudent_();
  const out = {};
  students.forEach(s => {
    const subjects = subjectsByCategory[categoryForClass_(s.Class, classes)] || [];
    const my = resultsByStudent[s.StudentID] || {};
    const total = subjects.reduce((t, sub) => t + (my[sub] ? my[sub].total : 0), 0);
    out[s.StudentID] = subjects.length ? total / subjects.length : 0;
  });
  return out;
}
// Text for the top of a Third Term report card.
function promotionLabel_(decision, classCode) {
  const classes = getClasses_();
  const i = classes.findIndex(c => c.code.toUpperCase() === String(classCode || '').toUpperCase());
  const current = i >= 0 ? classes[i].name : classCode;
  if (decision === 'Repeat') return { decision, label: 'Repeated', detail: 'To remain in ' + current };
  if (i === classes.length - 1) return { decision, label: 'Completed', detail: 'Has completed ' + current };
  return { decision, label: 'Promoted to', detail: i >= 0 ? classes[i + 1].name : '' };
}
function getPromotionDecision(params) {
  clearRequestCache_();
  const { token, sid } = params || {};
  requireAccess_(token, 'results');
  syncConfig_();
  const s = getStudentByIdDirect_(sid);
  if (!s) return { success: false, message: 'Student not found' };
  const passMark = promotionPassMark_();
  const manual = readPromotionDecisions_(CONFIG.CURRENT_ACADEMIC_YEAR)[s.StudentID];
  const avg = termAverages_([s])[s.StudentID];
  const auto = decidePromotion_(avg, null, passMark);
  return { success: true, term: CONFIG.CURRENT_TERM, passMark, average: Math.round(avg * 100) / 100,
           automatic: auto.decision, manual: manual && manual.source === 'Manual' ? manual.decision : '' };
}
// decision: 'Auto' (follow the pass mark), 'Promote' or 'Repeat'
function savePromotionDecision(params) {
  clearRequestCache_();
  const { token, sid, decision } = params || {};
  const user = requireAccess_(token, 'results');
  syncConfig_();
  if (CONFIG.CURRENT_TERM !== 3) return { success: false, message: 'Promotion decisions are made in Third Term.' };
  if (['Auto', 'Promote', 'Repeat'].indexOf(decision) < 0) return { success: false, message: 'Invalid decision.' };
  const s = getStudentByIdDirect_(sid);
  if (!s) return { success: false, message: 'Student not found' };
  return withScriptLock_(30000, () => {
    const year = CONFIG.CURRENT_ACADEMIC_YEAR;
    const existing = readPromotionDecisions_(year)[s.StudentID];
    const sh = promoSheet_(true);
    if (decision === 'Auto') { if (existing) deleteRowSafe_(sh, existing.row); }
    else {
      const avg = termAverages_([s])[s.StudentID];
      const row = [s.StudentID, s.FullName, s.Class, year, decision, 'Manual', Math.round(avg * 100) / 100, user.email, new Date().toISOString()];
      if (existing) sh.getRange(existing.row, 1, 1, row.length).setValues(fxRows_([row])); else appendRows_(sh, [row]);
    }
    return { success: true, message: decision === 'Auto' ? 'Set to automatic (pass mark).' : `Set to ${decision === 'Promote' ? 'promote' : 'repeat'}.` };
  });
}
// Called by the Third Term rollover BEFORE results are archived: stores the
// final decision for every active student. Returns { sid: decision }.
function freezePromotionDecisions_(students, actor) {
  const year = CONFIG.CURRENT_ACADEMIC_YEAR, passMark = promotionPassMark_();
  const existing = readPromotionDecisions_(year);
  const avgs = termAverages_(students);
  const sh = promoSheet_(true), now = new Date().toISOString(), rows = [], out = {};
  students.forEach(s => {
    const d = decidePromotion_(avgs[s.StudentID], existing[s.StudentID], passMark);
    out[s.StudentID] = d.decision;
    if (existing[s.StudentID] && existing[s.StudentID].source === 'Manual') return;      // already stored
    const row = [s.StudentID, s.FullName, s.Class, year, d.decision, 'Auto', Math.round(avgs[s.StudentID] * 100) / 100, actor, now];
    if (existing[s.StudentID]) sh.getRange(existing[s.StudentID].row, 1, 1, row.length).setValues(fxRows_([row])); else rows.push(row);
  });
  appendRows_(sh, rows);
  return out;
}
function previousAcademicYear_(year) {
  const [a, b] = String(year).split('/').map(Number);
  return isNaN(a) || isNaN(b) ? '' : `${a - 1}/${b - 1}`;
}

// ==================== PROMOTION ====================
// FIXES: locked, audit-logged, case-insensitive matching, and refuses to run
// twice in the same academic year (a second click promoted everyone again).
function promoteAllClasses(params) {
  clearRequestCache_();
  const admin = requireRole((params || {}).token, ['Admin']);
  syncConfig_();
  return withScriptLock_(60000, () => {
    if (String(getSetting_('LastPromotionYear') || '') === CONFIG.CURRENT_ACADEMIC_YEAR)
      return { success: false, message: `Students have already been promoted for ${CONFIG.CURRENT_ACADEMIC_YEAR}. Promotion can only run once per academic year.` };
    // Promoted during Third Term already? Then the first term of the next year must not promote again.
    const lp = String(getSetting_('LastPromotionTerm') || '').split('|');
    if (CONFIG.CURRENT_TERM === 1 && lp[0] === previousAcademicYear_(CONFIG.CURRENT_ACADEMIC_YEAR) && lp[1] === '3')
      return { success: false, message: 'Students were already promoted at the end of last year (in Third Term). Do not promote again.' };
    const classes = getClasses_();
    if (!classes.length) return { success: false, message: 'No classes configured.' };
    const order = {};
    classes.forEach((c, i) => { order[c.code.toUpperCase()] = i; });
    const st = readStudentsTable_();
    const sh = st.sh, allData = st.data;
    const headers = allData[0];
    const clsIdx = headers.indexOf('Class'), statIdx = headers.indexOf('Status');
    const clsCol = [], statCol = [];
    const counts = {};
    // Decisions from the Third Term just closed (frozen at rollover); if
    // promotion is run while still in Third Term, decide now.
    let repeat = {};
    if (CONFIG.CURRENT_TERM === 3) {
      const live = loadStudents_(), avgs = termAverages_(live), dec = readPromotionDecisions_(CONFIG.CURRENT_ACADEMIC_YEAR), pm = promotionPassMark_();
      live.forEach(s => { if (decidePromotion_(avgs[s.StudentID], dec[s.StudentID], pm).decision === 'Repeat') repeat[s.StudentID] = true; });
    } else {
      const dec = readPromotionDecisions_(previousAcademicYear_(CONFIG.CURRENT_ACADEMIC_YEAR));
      Object.keys(dec).forEach(sid => { if (dec[sid].decision === 'Repeat') repeat[sid] = true; });
    }
    for (let ri = 1; ri < allData.length; ri++) {
      const row = allData[ri];
      clsCol.push([row[clsIdx]]); statCol.push([row[statIdx]]);
      if (!row[0] || !isActiveStatus_(row[statIdx])) continue;
      const ci = order[String(row[clsIdx] || '').trim().toUpperCase()];
      if (ci === undefined) continue;
      const from = classes[ci].code;
      const to = ci < classes.length - 1 ? classes[ci + 1].code : 'Graduated';
      const c = counts[from] = counts[from] || { from, to, promoted: 0, graduated: 0, repeated: 0 };
      if (repeat[String(row[0]).trim()]) { c.repeated++; continue; }          // stays in the same class
      if (to === 'Graduated') { statCol[ri - 1] = ['Graduated']; c.graduated++; }
      else { clsCol[ri - 1] = [to]; c.promoted++; }
    }
    const n = allData.length - 1;
    if (n > 0) {
      sh.getRange(2, clsIdx + 1, n, 1).setValues(clsCol);
      sh.getRange(2, statIdx + 1, n, 1).setValues(statCol);
    }
    setSetting_('LastPromotionYear', CONFIG.CURRENT_ACADEMIC_YEAR);
    setSetting_('LastPromotionTerm', CONFIG.CURRENT_ACADEMIC_YEAR + '|' + CONFIG.CURRENT_TERM);
    const summary = classes.map(c => counts[c.code]).filter(Boolean);
    appendAudit_('PROMOTE_ALL', summary.map(s => `${s.from}→${s.to}: ${s.promoted + s.graduated}` + (s.repeated ? ` (${s.repeated} repeating)` : '')).join(' | '), admin.email);
    return { success: true, summary };
  });
}

// ==================== DASHBOARD ====================
function getDashboardStats(params) {
  clearRequestCache_();
  const me = requireAccess_((params || {}).token, 'dashboard');
  syncConfig_();
  const students = loadStudents_();
  const top = getTopClassCode_();
  let male = 0, female = 0, finalCount = 0;
  students.forEach(s => {
    const g = String(s.Gender || '').toLowerCase();
    if (g === 'male') male++;
    if (g === 'female') female++;
    if (String(s.Class).toUpperCase() === top.toUpperCase()) finalCount++;
  });
  const t0 = parseYMD_(todayStr_()).getTime(), t1 = t0 + 86400000;
  const isToday = v => { const d = parseSheetDate_(v); if (!d) return false; const t = d.getTime(); return t >= t0 && t < t1; };
  const ss = getSpreadsheet_();
  let todayCollection = 0, todayExpenses = 0;
  const feesSh = ss.getSheetByName('Fees_Ledger');
  if (feesSh && feesSh.getLastRow() > 1)          // only the date + amount columns
    feesSh.getRange(2, 9, feesSh.getLastRow() - 1, 3).getValues().forEach(r => { if (isToday(r[2])) todayCollection += parseFloat(r[0]) || 0; });
  const expSh = ss.getSheetByName('Expenses');
  if (expSh && expSh.getLastRow() > 1)
    expSh.getRange(2, 1, expSh.getLastRow() - 1, 5).getValues().forEach(r => { if (r[0] && isToday(r[1])) todayExpenses += parseFloat(r[4]) || 0; });
  return {
    totalStudents: students.length, maleCount: male, femaleCount: female,
    b9Count: finalCount, finalClassCount: finalCount, finalClassCode: top,
    todayCollection: r2(todayCollection), todayExpenses: r2(todayExpenses),
    archiveDue: me.role === ADMIN_ROLE && archiveStillDue_(),
    term: CONFIG.CURRENT_TERM, academicYear: CONFIG.CURRENT_ACADEMIC_YEAR,
    schoolName: getSetting_('SchoolName') || CONFIG.SCHOOL_NAME
  };
}

// ==================== SCORE WEIGHTS & SCHOOL CONFIG ====================
function getScoreWeights(params) {
  clearRequestCache_();
  requireAccess_((params || {}).token, ['results','settings']);
  return getWeights_();
}
function updateScoreWeights(params) {
  clearRequestCache_();
  const { token, classWeight, examWeight } = params || {};
  requireRole(token, ['Admin']);
  const cw = parseInt(classWeight, 10), ew = parseInt(examWeight, 10);
  if (isNaN(cw) || isNaN(ew) || cw < 0 || ew < 0 || cw + ew !== 100)
    return { success: false, message: 'Class and exam weights must be whole numbers that add up to 100.' };
  setSetting_('ClassScoreWeight', cw);
  setSetting_('ExamScoreWeight', ew);
  return { success: true };
}
function getSchoolConfig(params) {
  clearRequestCache_();
  requireUser_((params || {}).token);
  syncConfig_();
  return {
    schoolName: getSetting_('SchoolName') || CONFIG.SCHOOL_NAME,
    schoolMotto: getSetting_('SchoolMotto') || CONFIG.SCHOOL_MOTTO,
    schoolAddress: getSetting_('SchoolAddress') || CONFIG.SCHOOL_ADDRESS,
    schoolEmail: getSetting_('SchoolEmail') || CONFIG.SCHOOL_EMAIL,
    schoolPhone: getSetting_('SchoolPhone') || CONFIG.SCHOOL_PHONE,
    currentTerm: CONFIG.CURRENT_TERM,
    currentAcademicYear: CONFIG.CURRENT_ACADEMIC_YEAR,
    termDays: parseInt(getSetting_('TermDays'), 10) || CONFIG.TERM_DAYS,
    nextTermBegins: String(getSetting_('NextTermBegins') || ''),
    promotionPassMark: promotionPassMark_(),
    admissionFee: numSetting_('AdmissionFee', 0),
    scoreWeights: getWeights_()
  };
}
function updateSchoolConfig(params) {
  clearRequestCache_();
  const { token, ...data } = params || {};
  const cfgAdmin = requireRole(token, ['Admin']);
  if (data.currentTerm !== undefined && data.currentTerm !== '') {
    const t = parseInt(data.currentTerm, 10);
    if (!(t >= 1 && t <= 3)) return { success: false, message: 'Term must be 1, 2 or 3.' };
  }
  if (data.currentAcademicYear) {
    const m = /^(\d{4})\/(\d{4})$/.exec(String(data.currentAcademicYear).trim());
    if (!m || +m[2] !== +m[1] + 1) return { success: false, message: 'Academic year must look like 2025/2026.' };
  }
  if (data.schoolEmail && !isValidEmail_(data.schoolEmail)) return { success: false, message: 'School email is not valid.' };
  if (data.admissionFee !== undefined && data.admissionFee !== '' && !(parseFloat(data.admissionFee) >= 0))
    return { success: false, message: 'Admission fee must be zero or more.' };
  if (data.promotionPassMark !== undefined && data.promotionPassMark !== '') {
    const pm = parseFloat(data.promotionPassMark);
    if (isNaN(pm) || pm < 0 || pm > 100) return { success: false, message: 'Promotion pass mark must be between 0 and 100.' };
  }
  if (data.schoolName) setSetting_('SchoolName', String(data.schoolName).trim());
  if (data.schoolMotto !== undefined) setSetting_('SchoolMotto', String(data.schoolMotto).trim());
  if (data.schoolAddress !== undefined) setSetting_('SchoolAddress', String(data.schoolAddress).trim());
  if (data.schoolEmail) setSetting_('SchoolEmail', String(data.schoolEmail).trim());
  if (data.schoolPhone !== undefined) setSetting_('SchoolPhone', textCell_(data.schoolPhone));
  if (data.currentTerm) setSetting_('CurrentTerm', parseInt(data.currentTerm, 10));
  if (data.currentAcademicYear) setSetting_('CurrentAcademicYear', String(data.currentAcademicYear).trim());
  if (data.termDays && parseInt(data.termDays, 10) > 0) setSetting_('TermDays', parseInt(data.termDays, 10));
  if (Object.prototype.hasOwnProperty.call(data, 'nextTermBegins')) setSetting_('NextTermBegins', data.nextTermBegins || '');
  if (data.promotionPassMark !== undefined && data.promotionPassMark !== '') setSetting_('PromotionPassMark', parseFloat(data.promotionPassMark));
  if (data.admissionFee !== undefined && data.admissionFee !== '') setSetting_('AdmissionFee', r2(parseFloat(data.admissionFee)));
  if (data.currentTerm || data.currentAcademicYear || data.admissionFee !== undefined)
    appendAudit_('SETTINGS_UPDATE', `Term ${data.currentTerm || '-'}, year ${data.currentAcademicYear || '-'}, admission fee ${data.admissionFee === undefined ? '-' : data.admissionFee}`, cfgAdmin.email);
  return { success: true };
}
function getSchoolName() { clearRequestCache_(); return getSetting_('SchoolName') || CONFIG.SCHOOL_NAME; }
function getSchoolCrest(params) { clearRequestCache_(); return getSetting_('SchoolCrest') || ''; }
function validImageData_(data) {
  const s = String(data || '');
  if (!s) return 'No image supplied.';
  // Pictures are uploaded and stored in the sheet. An external link would let whoever hosts it see who
  // opens a report card, so links are accepted only if an administrator switches them on
  // (Settings row AllowImageLinks = true).
  const isData = /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(s);
  const isLink = /^https:\/\//i.test(s) && String(getSetting_('AllowImageLinks') || '').toLowerCase() === 'true';
  if (!isData && !isLink) return 'Please upload the picture from this device. Picture links are switched off to protect privacy.';
  if (s.length > CONFIG.MAX_IMAGE_CHARS) return 'Image is too large. Please use a smaller picture.';
  return '';
}
function uploadSchoolCrest(params) {
  clearRequestCache_();
  const { token, data } = params || {};
  requireRole(token, ['Admin']);
  const err = validImageData_(data);
  if (err) return { success: false, message: err };
  setSetting_('SchoolCrest', data);
  return { success: true };
}
function uploadStudentPhoto(params) {
  clearRequestCache_();
  const { token, sid, photo } = params || {};
  requireAction_(token, 'students.edit');
  const err = validImageData_(photo);
  if (err) return { success: false, message: err };
  const rec = findStudentRecord_(sid);
  if (!rec) return { success: false, message: 'Student not found' };
  const pIdx = rec.headers.indexOf('PhotoURL');
  if (pIdx < 0) return { success: false, message: 'Column missing' };
  rec.sheet.getRange(rec.rowIndex + 1, pIdx + 1).setValue(photo);
  try { CacheService.getScriptCache().remove('photo_' + rec.student.StudentID); } catch (e) {}
  return { success: true };
}

// ==================== BULK UPLOAD ====================
// FIXES: rows are validated (name + a class that exists) BEFORE IDs are
// reserved; class codes are normalised; invalid rows are reported.
function bulkUploadStudents(params) {
  clearRequestCache_();
  const { token, fileContent } = params || {};
  const user = requireAction_(token, 'students.edit');
  syncConfig_();
  if (!fileContent) return { success: false, message: 'No file content' };
  let rows;
  try { rows = Utilities.parseCsv(String(fileContent).replace(/^\uFEFF/, '')); }
  catch (e) { return { success: false, message: 'Could not read the CSV file: ' + e.message }; }
  if (rows.length < 2) return { success: false, message: 'No data in CSV' };
  const headers = rows[0].map(h => h.trim().replace(/\s/g, '').toLowerCase());
  const required = ['fullname','gender','dateofbirth','class','admissiondate','residentialaddress','parentname','parentmomo'];
  const missing = required.filter(r => !headers.includes(r));
  if (missing.length) return { success: false, message: 'Missing columns: ' + missing.join(', ') };
  const classMap = {};
  getClasses_().forEach(c => { classMap[c.code.toUpperCase()] = c.code; });
  // Uploading the same file twice must not create the students twice:
  // anyone already registered (same name + date of birth, or same name +
  // class when no date is given) is skipped, as are repeats inside the file.
  const dupKey = (name, dob, cls) => normName_(name) + '|' + (String(dob || '').trim() || 'class:' + String(cls || '').toUpperCase());
  const existing = {};
  loadStudents_().forEach(s => { existing[dupKey(s.FullName, s.DateOfBirth, s.Class)] = s.StudentID; existing[dupKey(s.FullName, '', s.Class)] = s.StudentID; });
  const inFile = {};
  const valid = [], skipped = [];
  rows.slice(1).forEach((r, i) => {
    const d = {};
    headers.forEach((h, idx) => { d[h] = r[idx] ? r[idx].toString().trim().slice(0, 200) : ''; });
    if (!Object.values(d).some(Boolean)) return;                 // blank line
    const cls = classMap[String(d.class).toUpperCase()];
    if (!d.fullname) { skipped.push(`Row ${i + 2}: missing FullName`); return; }
    if (!cls) { skipped.push(`Row ${i + 2}: unknown class "${d.class}"`); return; }
    d.class = cls;
    d.fullname = d.fullname.replace(/\s+/g, ' ');
    const k = dupKey(d.fullname, d.dateofbirth, cls);
    if (existing[k] || (!d.dateofbirth && existing[dupKey(d.fullname, '', cls)])) { skipped.push(`Row ${i + 2}: ${d.fullname} is already registered (${existing[k] || existing[dupKey(d.fullname, '', cls)]})`); return; }
    if (inFile[k]) { skipped.push(`Row ${i + 2}: ${d.fullname} repeats row ${inFile[k]}`); return; }
    inFile[k] = i + 2;
    const g = d.gender.toLowerCase();
    d.gender = g.startsWith('m') ? 'Male' : g.startsWith('f') ? 'Female' : d.gender;
    valid.push(d);
  });
  if (!valid.length) return { success: false, added: 0, skipped, message: 'No new students to add. ' + skipped.slice(0, 5).join('; ') };
  return withScriptLock_(60000, () => {
  const firstID = incrementSettingBatch_('LastStudentID', valid.length);
  const nowStr = new Date().toISOString();
  const sheetRows = valid.map((d, i) => [
    formatStudentID_(firstID + i), d.fullname, d.gender, d.dateofbirth, d.class,
    d.admissiondate || todayStr_(), d.residentialaddress, d.parentname, textCell_(d.parentmomo),
    textCell_(d.emergencycontact), d.previousschool || '', d.medicalconditions || '',
    'Active', d.scholarship || 'None', '', 0, 0, user.email, nowStr
  ]);
  const sh = getSpreadsheet_().getSheetByName('Students');
  appendRows_(sh, sheetRows);
  // Bulk upload is for pupils already in the school: no admission fee is charged.
  return { success: true, added: sheetRows.length, skipped,
           message: `${sheetRows.length} students added` + (skipped.length ? `, ${skipped.length} row(s) skipped` : '') };
  });
}

// ==================== DATA MAINTENANCE (Settings → Data) ====================
// Google Sheets allows 10 million cells per spreadsheet, and every read gets
// slower as sheets grow. Attendance and canteen add a row per student per
// school day, so this section keeps the live sheets small:
//   • Health  – rows and cells used per sheet, against the limit
//   • Compact – removes unused empty columns/rows (they count toward the limit)
//   • Archive – moves rows from CLOSED terms into a separate archive
//               spreadsheet. Report cards, attendance, results and conduct
//               only ever use the current term, so nothing on screen
//               changes. Canteen balances are carried forward and daily
//               canteen totals are kept for reports.
const CELL_LIMIT = 10000000;
const ARCHIVE_SHEETS = ['Attendance', 'Results_Entry', 'Conduct_Records', 'Student_Fee_Overrides', 'Canteen_Ledger'];
const ARCHIVE_CHUNK = 20000;          // rows moved per call (keeps each call well under 6 minutes)
const APP_SHEETS = ['Students', 'Classes', 'Subjects', 'Fee_Items', 'Fees_Ledger', 'Results_Entry', 'Attendance', 'Expenses',
  'Conduct_Records', 'Settings', 'Audit_Log', 'Student_Fee_Overrides', 'Canteen_Ledger', 'Canteen_Summary', 'Canteen_Expenses', 'Promotion_Decisions',
  'Payroll_Staff', 'Payroll_Runs', 'Payroll_Lines'];

// The term/year an entry was MADE in. The app sends it with things saved offline so that,
// when they reach the server after a rollover, they still land in the term they belong to.
// Only the current term or the one immediately before it is accepted; anything else is
// treated as "now". (Fee payments deliberately do not use this: money received after a
// rollover must reduce what the student owes now.)
function entryPeriod_(params) {
  const cur = { term: CONFIG.CURRENT_TERM, year: CONFIG.CURRENT_ACADEMIC_YEAR };
  const t = parseInt(params && params.term, 10), y = String((params && params.academicYear) || '').trim();
  if (!(t >= 1 && t <= 3) || !/^\d{4}\/\d{4}$/.test(y)) return cur;
  if (t === cur.term && y === cur.year) return cur;
  const prev = cur.term > 1 ? { term: cur.term - 1, year: cur.year } : { term: 3, year: previousAcademicYear_(cur.year) };
  return (t === prev.term && y === prev.year) ? { term: t, year: y } : cur;
}
function termOrd_(year, term) {
  const y = parseInt(String(year || '').split('/')[0], 10), t = parseInt(term, 10);
  return isNaN(y) || isNaN(t) ? null : y * 10 + t;
}
function closedTermCount_(sh) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return 0;
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const t = headers.indexOf('Term'), y = headers.indexOf('AcademicYear');
  if (t < 0 || y < 0) return 0;
  const cur = termOrd_(CONFIG.CURRENT_ACADEMIC_YEAR, CONFIG.CURRENT_TERM);
  const lo = Math.min(t, y), vals = sh.getRange(2, lo + 1, n, Math.abs(t - y) + 1).getValues();
  let count = 0;
  vals.forEach(r => { const o = termOrd_(r[y - lo], r[t - lo]); if (o !== null && o < cur) count++; });
  return count;
}
// The reminder is a flag set at rollover. It is re-checked against the
// sheets themselves, so it disappears as soon as nothing is left to archive
// (it used to clear only when Settings → Data was opened afterwards).
function archiveStillDue_() {
  const pending = ARCHIVE_SHEETS.some(n => getSetting_('ArchivePending_' + n));
  if (pending) return true;
  if (String(getSetting_('ArchiveDue') || '') !== 'true') return false;
  syncConfig_();
  const ss = getSpreadsheet_();
  const closed = ARCHIVE_SHEETS.some(n => { const sh = ss.getSheetByName(n); return sh && closedTermCount_(sh) > 0; });
  if (!closed) setSetting_('ArchiveDue', '');
  return closed;
}
function getArchiveStatus(params) {
  clearRequestCache_();
  requireRole((params || {}).token, ['Admin']);
  syncConfig_();
  const ss = getSpreadsheet_();
  const left = ARCHIVE_SHEETS.map(n => { const sh = ss.getSheetByName(n); return { sheet: n, rows: sh ? closedTermCount_(sh) : 0 }; }).filter(x => x.rows > 0);
  const pending = ARCHIVE_SHEETS.filter(n => getSetting_('ArchivePending_' + n));
  if (!left.length && !pending.length) setSetting_('ArchiveDue', '');
  else setSetting_('ArchiveDue', 'true');
  return { success: true, due: left.length > 0 || pending.length > 0, left, pending };
}
function getDataHealth(params) {
  clearRequestCache_();
  requireRole((params || {}).token, ['Admin']);
  syncConfig_();
  const ss = getSpreadsheet_();
  let total = 0, wasted = 0;
  const sheets = ss.getSheets().map(sh => {
    const name = sh.getName(), lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    const cells = sh.getMaxRows() * sh.getMaxColumns(), used = lastRow * lastCol;
    total += cells; wasted += Math.max(0, cells - used);
    return { name, rows: Math.max(0, lastRow - 1), cols: lastCol, cells,
             closedRows: ARCHIVE_SHEETS.includes(name) ? closedTermCount_(sh) : 0 };
  }).sort((a, b) => b.cells - a.cells);
  const pending = ARCHIVE_SHEETS.filter(n => getSetting_('ArchivePending_' + n));
  const closedTotal = sheets.reduce((t, s) => t + s.closedRows, 0);
  if (!closedTotal && !pending.length && getSetting_('ArchiveDue')) setSetting_('ArchiveDue', '');
  else if ((closedTotal || pending.length) && !getSetting_('ArchiveDue')) setSetting_('ArchiveDue', 'true');
  const url = id => 'https://docs.google.com/spreadsheets/d/' + id + '/edit';
  const archiveFiles = [];
  const legacy = getSetting_('ArchiveSpreadsheetId');
  if (legacy) archiveFiles.push({ label: 'Archive', url: url(legacy) });
  const map = archiveFilesMap_();
  Object.keys(map).sort().forEach(y => map[y].forEach((id, i) => archiveFiles.push({ label: y + (i ? ' (part ' + (i + 1) + ')' : ''), url: url(id) })));
  const archiveUrl = archiveFiles.length ? archiveFiles[archiveFiles.length - 1].url : '';
  return { success: true, sheets, totalCells: total, wastedCells: wasted, cellLimit: CELL_LIMIT,
           percent: Math.round(total / CELL_LIMIT * 1000) / 10, archiveSheets: ARCHIVE_SHEETS, pending, closedTotal,
           archiveUrl, archiveFiles, lastArchiveAt: String(getSetting_('LastArchiveAt') || ''),
           term: CONFIG.CURRENT_TERM, academicYear: CONFIG.CURRENT_ACADEMIC_YEAR };
}
// Removes empty columns to the right of the data and spare empty rows
// (keeps 50 spare rows). Never touches cells that hold data.
function compactSheets(params) {
  clearRequestCache_();
  const admin = requireRole((params || {}).token, ['Admin']);
  return withScriptLock_(30000, () => {
    const ss = getSpreadsheet_();
    let freed = 0;
    APP_SHEETS.forEach(name => {
      const sh = ss.getSheetByName(name);
      if (!sh) return;
      const before = sh.getMaxRows() * sh.getMaxColumns();
      trimColumns_(sh, Math.max(1, sh.getLastColumn()));
      const keepRows = Math.max(sh.getLastRow(), sh.getFrozenRows() + 1, 2) + 50;
      if (sh.getMaxRows() > keepRows) sh.deleteRows(keepRows + 1, sh.getMaxRows() - keepRows);
      freed += before - sh.getMaxRows() * sh.getMaxColumns();
    });
    appendAudit_('COMPACT', `Freed ${freed} empty cells`, admin.email);
    return { success: true, freed, message: `Freed ${freed.toLocaleString()} empty cells.` };
  });
}
// One archive spreadsheet per academic year. Each archive file has the
// same 10-million-cell limit as the main one, so if a year's file gets near
// the limit, a "(part 2)" file is started automatically.
const ARCHIVE_FILE_CAP = 9000000;
function archiveFilesMap_() {
  try { return JSON.parse(getSetting_('ArchiveFiles') || '{}') || {}; } catch (e) { return {}; }
}
function spreadsheetCells_(ss) { return ss.getSheets().reduce((t, s) => t + s.getMaxRows() * s.getMaxColumns(), 0); }
function getArchiveSpreadsheet_(year, neededCells) {
  const map = archiveFilesMap_();
  const ids = map[year] || [];
  if (ids.length) {
    try {
      const a = SpreadsheetApp.openById(String(ids[ids.length - 1]));
      if (spreadsheetCells_(a) + (neededCells || 0) <= ARCHIVE_FILE_CAP) return a;
    } catch (e) { /* file deleted → start a new part */ }
  }
  const part = ids.length + 1;
  const school = getSetting_('SchoolName') || CONFIG.SCHOOL_NAME;
  const a = SpreadsheetApp.create(`${school} — iSmartSchool Archive ${year}` + (part > 1 ? ` (part ${part})` : ''));
  const about = a.getSheets()[0];
  about.setName('About');
  about.getRange(1, 1, 3, 1).setValues([[`${school} — archived records, academic year ${year}` + (part > 1 ? ` (part ${part})` : '')],
    ['Rows from closed terms, moved here automatically by iSmartSchool (Settings → Data).'],
    ['Each tab matches a sheet in the main spreadsheet; ArchiveBatch identifies each archive run.']]);
  trimColumns_(about, 1);
  map[year] = ids.concat([a.getId()]);
  setSetting_('ArchiveFiles', JSON.stringify(map));
  return a;
}
function archiveTab_(arch, name, headers) {
  let sh = arch.getSheetByName(name);
  if (!sh) {
    const h = headers.concat(['ArchivedAt', 'ArchiveBatch']);
    sh = arch.insertSheet(name);
    ensureCols_(sh, h.length);
    sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold');
    sh.setFrozenRows(1);
    trimColumns_(sh, h.length);
  }
  return sh;
}
// Archive cells are written as plain text so nothing is reinterpreted
// (phone numbers keep leading zeros, dates stay as yyyy-MM-dd).
function appendTextRows_(sh, rows) {
  if (!rows.length) return;
  const width = rows[0].length, start = sh.getLastRow() + 1, need = start + rows.length - 1, maxRows = sh.getMaxRows();
  if (need > maxRows) sh.insertRowsAfter(maxRows, need - maxRows);
  ensureCols_(sh, width);
  sh.getRange(start, 1, rows.length, width).setNumberFormat('@').setValues(rows);
}
function archiveStringifier_() {
  const fast = Session.getScriptTimeZone() === getTz_();
  const pad = n => (n < 10 ? '0' : '') + n;
  const cell = v => v instanceof Date
    ? (fast ? v.getFullYear() + '-' + pad(v.getMonth() + 1) + '-' + pad(v.getDate()) : fmtDate_(v))
    : (v === null || v === undefined ? '' : String(v));
  return row => row.map(cell);
}
// Rows of one batch in the archive tab (appended together, so contiguous).
function readArchiveBatch_(tab, width, batch) {
  const n = tab.getLastRow() - 1;
  if (n < 1) return { rows: [], values: [] };
  const ids = tab.getRange(2, width + 2, n, 1).getValues();
  const rows = [];
  ids.forEach((v, i) => { if (v[0] === batch) rows.push(i + 2); });
  if (!rows.length) return { rows, values: [] };
  const values = tab.getRange(rows[0], 1, rows[rows.length - 1] - rows[0] + 1, width).getValues()
    .filter((_, k) => ids[rows[0] - 2 + k][0] === batch).map(r => r.map(v => v === null || v === undefined ? '' : String(v)));
  return { rows, values };
}
// Finishes an archive batch: canteen/attendance follow-ups, then removes the
// archived rows from the live sheet. Safe to repeat.
function commitArchive_(src, name, headers, values, strRows, batch, pickIdx, toStr) {
  if (name === 'Canteen_Ledger') canteenCommitArchive_(headers, strRows, batch);
  if (name === 'Attendance') {
    const di = headers.indexOf('Date');
    let max = String(getSetting_('AttendanceArchivedThrough') || '');
    strRows.forEach(r => { const d = String(r[di] || ''); if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d > max) max = d; });
    if (max) setSetting_('AttendanceArchivedThrough', max);
  }
  let rows = pickIdx ? pickIdx.map(i => i + 1) : null;
  if (!rows) {                      // recovery: find the archived rows by content
    const want = {};
    strRows.forEach(r => { const k = r.join('\u0001'); want[k] = (want[k] || 0) + 1; });
    rows = [];
    for (let i = 1; i < values.length; i++) {
      const k = toStr(values[i]).join('\u0001');
      if (want[k]) { want[k]--; rows.push(i + 1); }
    }
  }
  deleteRowsGrouped_(src, rows);
  if (name === 'Canteen_Ledger') canteenBumpVersion_();
}
// Moves up to ARCHIVE_CHUNK closed-term rows of ONE sheet per call. The page
// calls it repeatedly until `remaining` is 0. An interrupted run is detected
// and finished/undone safely on the next call.
function archiveClosedTerms(params) {
  clearRequestCache_();
  const { token, sheet } = params || {};
  const admin = requireRole(token, ['Admin']);
  if (!ARCHIVE_SHEETS.includes(sheet)) return { success: false, message: 'This sheet cannot be archived.' };
  syncConfig_();
  return withScriptLock_(60000, () => {
    const src = getSpreadsheet_().getSheetByName(sheet);
    if (!src || src.getLastRow() < 2) return { success: true, sheet, archived: 0, remaining: 0 };
    const values = src.getRange(1, 1, src.getLastRow(), src.getLastColumn()).getValues();
    const headers = values[0].map(String);
    const tIdx = headers.indexOf('Term'), yIdx = headers.indexOf('AcademicYear');
    if (tIdx < 0 || yIdx < 0) return { success: true, sheet, archived: 0, remaining: 0, skipped: true };   // nothing term-stamped to move
    const toStr = archiveStringifier_();
    const pendKey = 'ArchivePending_' + sheet;
    let pending = null;
    try { pending = JSON.parse(getSetting_('ArchivePending_' + sheet) || 'null'); } catch (e) { pending = null; }
    if (pending && pending.batch) {
      let arch;
      try { arch = SpreadsheetApp.openById(String(pending.fileId)); }
      catch (e) { setSetting_(pendKey, ''); return { success: false, message: 'The archive file for an interrupted run is missing; nothing was removed from the live sheet. Click Archive again.' }; }
      const tab = archiveTab_(arch, sheet, headers);
      const b = readArchiveBatch_(tab, headers.length, pending.batch);
      if (pending.state === 'copied') commitArchive_(src, sheet, headers, values, b.values, pending.batch, null, toStr);
      else deleteRowsGrouped_(tab, b.rows);          // copy never finished → discard it and start again
      setSetting_(pendKey, '');
      return { success: true, sheet, archived: 0, remaining: 1, recovered: true, archiveUrl: arch.getUrl() };
    }
    const cur = termOrd_(CONFIG.CURRENT_ACADEMIC_YEAR, CONFIG.CURRENT_TERM);
    // Closed rows, oldest academic year first (each year has its own archive file).
    const closed = [];
    let oldest = null;
    for (let i = 1; i < values.length; i++) {
      const o = termOrd_(values[i][yIdx], values[i][tIdx]);
      if (o === null || o >= cur) continue;          // current term, or no term → stays live
      closed.push(i);
      const y = Math.floor(o / 10);
      if (oldest === null || y < oldest) oldest = y;
    }
    if (!closed.length) return { success: true, sheet, archived: 0, remaining: 0 };
    const pick = closed.filter(i => Math.floor(termOrd_(values[i][yIdx], values[i][tIdx]) / 10) === oldest).slice(0, ARCHIVE_CHUNK);
    const remaining = closed.length - pick.length;
    const year = oldest + '/' + (oldest + 1);
    const arch = getArchiveSpreadsheet_(year, pick.length * (headers.length + 2) + 1000);
    const tab = archiveTab_(arch, sheet, headers);
    const batch = 'B' + Date.now();
    const stamp = new Date().toISOString();
    const strRows = pick.map(i => toStr(values[i]));
    setSetting_(pendKey, JSON.stringify({ batch, state: 'copying', fileId: arch.getId() }));
    appendTextRows_(tab, strRows.map(r => r.concat([stamp, batch])));
    setSetting_(pendKey, JSON.stringify({ batch, state: 'copied', fileId: arch.getId() }));
    commitArchive_(src, sheet, headers, values, strRows, batch, pick, toStr);
    setSetting_(pendKey, '');
    setSetting_('LastArchiveAt', stamp);
    appendAudit_('ARCHIVE', `${sheet}: moved ${pick.length} closed-term rows to the archive (batch ${batch})`, admin.email);
    return { success: true, sheet, archived: pick.length, remaining, archiveUrl: arch.getUrl() };
  });
}

// ==================== WEB APP ENTRY ====================
function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('iSmartSchool – GES SMS')
    // ALLOWALL lets any site frame the login page (clickjacking). Only
    // enable it if you deliberately embed the app (e.g. Google Sites).
    .setXFrameOptionsMode(CONFIG.ALLOW_IFRAME_EMBED ? HtmlService.XFrameOptionsMode.ALLOWALL : HtmlService.XFrameOptionsMode.DEFAULT)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

// ==================== LOGIN RECOVERY (run from the Apps Script editor) ====================
// Both functions refuse to run unless the person running them is the
// script owner. That stops anyone calling them from the web page.
function isScriptOwnerRunning_() {
  const active = (Session.getActiveUser().getEmail() || '').toLowerCase();
  const owner = (Session.getEffectiveUser().getEmail() || '').toLowerCase();
  return !!active && active === owner;
}

// STEP 1 — Select "diagnoseLogin" in the editor toolbar and click Run.
// Then open View → Logs (or Execution log). It lists every account, says
// whether each record looks valid, and clears any failed-login lockouts.
// It never shows passwords.
function diagnoseLogin() {
  if (!isScriptOwnerRunning_()) throw new Error('Run this from the Apps Script editor as the script owner.');
  clearRequestCache_();
  const ss = getSpreadsheet_();
  Logger.log('Spreadsheet: ' + ss.getName() + ' (' + ss.getId() + ')');
  if (!ss.getSheetByName('Settings')) { Logger.log('❌ No "Settings" sheet in this spreadsheet — the script may be attached to the wrong file.'); return; }
  const users = getUsers_();
  if (!users.length) { Logger.log('❌ No user accounts found. Open the web app — it should show "Create Admin".'); return; }
  const cache = CacheService.getScriptCache();
  users.forEach(u => {
    const pw = String(u.password || '');
    const okFormat = /^[0-9a-f]+:[0-9a-f]{64}$/i.test(pw);
    const spaces = u.email !== u.email.trim() ? '  ⚠️ email has extra spaces' : '';
    Logger.log(`• "${u.email}" | role=${u.role} | status=${u.status} | password record ${okFormat ? 'OK' : '❌ DAMAGED/MISSING'}${spaces}`);
    cache.remove(loginFailKey_(u.email));
  });
  Logger.log('Failed-login lockouts cleared. If your email is listed with "password record OK", the password typed is wrong — use resetUserPassword.');
}

// STEP 2 (only if needed) — Fill in the two values below, select
// "resetUserPassword" and click Run. Then BLANK the values again and save,
// so the new password isn't left sitting in the code.
const RESET_EMAIL = '';        // e.g. 'edenpeakacademy@gmail.com'
const RESET_NEW_PASSWORD = ''; // at least 8 characters
function resetUserPassword() {
  if (!isScriptOwnerRunning_()) throw new Error('Run this from the Apps Script editor as the script owner.');
  if (!RESET_EMAIL || String(RESET_NEW_PASSWORD).length < CONFIG.MIN_PASSWORD_LENGTH) throw new Error('Fill in RESET_EMAIL and RESET_NEW_PASSWORD (min ' + CONFIG.MIN_PASSWORD_LENGTH + ' characters) first.');
  clearRequestCache_();
  const sh = getSpreadsheet_().getSheetByName('Settings');
  const data = sh.getDataRange().getValues();
  const target = RESET_EMAIL.toLowerCase().trim();
  for (let i = 1; i < data.length; i++) {
    const key = String(data[i][0] || '');
    if (key.startsWith('User_') && key.slice(5).toLowerCase().trim() === target) {
      const parts = String(data[i][1] || '').split('|');
      const val = `${parts[0] || 'Admin'}|${parts[1] || target}|${generatePasswordHash_(RESET_NEW_PASSWORD)}|active`;
      sh.getRange(i + 1, 1, 1, 2).setValues([['User_' + target, val]]);   // also repairs a key with stray spaces
      CacheService.getScriptCache().remove(loginFailKey_(target));
      revokeUserTokens_(target);
      Logger.log('✅ Password reset and account activated for ' + target + '. Now blank RESET_EMAIL / RESET_NEW_PASSWORD and save.');
      return;
    }
  }
  Logger.log('❌ No account found for ' + target + '. Run diagnoseLogin to see the exact emails stored.');
}