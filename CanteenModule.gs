// ========================================================================
// iSmartSchool – Canteen Module (Google Apps Script)
// ------------------------------------------------------------------------
// Add this as a SEPARATE script file named CanteenModule.gs next to
// Code.gs. It reuses Code.gs helpers (auth, locks, settings, students),
// so it does not work on its own.
//
// HOW IT WORKS — one running account per student:
//   PAYMENT rows add money   (+)    MEAL rows deduct the daily rate (−)
//   balance > 0  → prepaid days left      balance < 0 → owes (fed on credit)
//
//   • Register: mark each student Present (eats) or Absent (doesn't).
//     A present student is covered by prepaid balance, else pays today,
//     or eats on credit if "Feed on credit, pay later" is ticked.
//   • Payments are money amounts; the system converts them to days
//     (GH₵23 at GH₵5/day = 4 days + GH₵3 credit).
//
// Every name in this file starts with "canteen"/"Canteen"/"CANTEEN_"
// so it can never clash with Code.gs.
// ========================================================================
const CANTEEN_SHEET = 'Canteen_Ledger';
const CANTEEN_HEADERS = ['TxID','Date','StudentID','StudentName','Class','Type','Days','Rate','Amount',
  'Method','Reference','ReceiptNo','Term','AcademicYear','RecordedBy','RecordedAt','Notes','Key'];
const CANTEEN_COL = { TX:0, DATE:1, SID:2, NAME:3, CLASS:4, TYPE:5, DAYS:6, RATE:7, AMT:8, METHOD:9,
  REF:10, RCPT:11, TERM:12, AY:13, BY:14, AT:15, NOTES:16, KEY:17 };
const CANTEEN_METHODS = ['Cash', 'Mobile Money', 'Bank'];

// ==================== STORAGE ====================
function canteenSheet_() {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(CANTEEN_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CANTEEN_SHEET);
    sh.getRange(1, 1, 1, CANTEEN_HEADERS.length).setValues([CANTEEN_HEADERS])
      .setFontWeight('bold').setBackground('#006B3F').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
    // Dates stored as plain yyyy-MM-dd text (no timezone shifts);
    // references as text (MoMo IDs keep leading zeros).
    sh.getRange('B:B').setNumberFormat('@');
    sh.getRange('K:K').setNumberFormat('@');
    trimColumns_(sh, CANTEEN_HEADERS.length);
  }
  return sh;
}
// Per-day, per-class totals of ARCHIVED canteen rows, so reports and the
// Income & Expenditure statement stay complete after old terms are archived.
const CANTEEN_SUMMARY_SHEET = 'Canteen_Summary';
const CANTEEN_SUMMARY_HEADERS = ['Date','Term','AcademicYear','Class','CashReceived','Cash','MobileMoney','Bank','Meals','MealsValue','CreditMeals','Batch'];
function canteenSummarySheet_(create) {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(CANTEEN_SUMMARY_SHEET);
  if (!sh && create !== false) {
    sh = ss.insertSheet(CANTEEN_SUMMARY_SHEET);
    sh.getRange(1, 1, 1, CANTEEN_SUMMARY_HEADERS.length).setValues([CANTEEN_SUMMARY_HEADERS])
      .setFontWeight('bold').setBackground('#006B3F').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('@');
    trimColumns_(sh, CANTEEN_SUMMARY_HEADERS.length);
  }
  return sh || null;
}
function canteenSummaryRows_() {
  const sh = canteenSummarySheet_(false);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, CANTEEN_SUMMARY_HEADERS.length).getValues().filter(r => r[0]).map(r => ({
    date: String(fmtDate_(r[0])).trim(), term: parseInt(r[1], 10), ay: String(r[2] || '').trim(), cls: String(r[3] || ''),
    cash: parseFloat(r[4]) || 0, byMethod: { 'Cash': parseFloat(r[5]) || 0, 'Mobile Money': parseFloat(r[6]) || 0, 'Bank': parseFloat(r[7]) || 0 },
    meals: parseInt(r[8], 10) || 0, mealsValue: parseFloat(r[9]) || 0, creditMeals: parseInt(r[10], 10) || 0
  }));
}
function canteenParseRow_(r, rowNumber) {
  const C = CANTEEN_COL;
  return {
    row: rowNumber, txId: String(r[C.TX]), date: String(fmtDate_(r[C.DATE]) || '').trim(),
    sid: String(r[C.SID] || '').trim(), name: String(r[C.NAME] || ''), cls: String(r[C.CLASS] || ''),
    type: String(r[C.TYPE] || '').toUpperCase(), days: parseFloat(r[C.DAYS]) || 0,
    rate: parseFloat(r[C.RATE]) || 0, amount: parseFloat(r[C.AMT]) || 0,
    method: String(r[C.METHOD] || ''), reference: String(r[C.REF] || '').replace(/^'/, ''),
    receipt: String(r[C.RCPT] || ''), term: r[C.TERM], ay: String(r[C.AY] || '').trim(),
    by: String(r[C.BY] || ''), at: String(fmtDate_(r[C.AT]) || ''), notes: String(r[C.NOTES] || ''),
    key: String(r[C.KEY] || '')
  };
}
// Reads every ledger row once. `create` = false avoids creating the sheet
// just to answer a report.
function canteenReadAll_(create) {
  const sh = create === false ? getSpreadsheet_().getSheetByName(CANTEEN_SHEET) : canteenSheet_();
  if (!sh) return { sh: null, rows: [] };
  const data = sh.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < data.length; i++) if (data[i][0]) rows.push(canteenParseRow_(data[i], i + 1));
  return { sh, rows };
}
// Same rows, but reading ONLY the listed columns (grouped into contiguous
// blocks). The register needs 6 of the 18 columns, so it reads a third of
// the cells. Fields not requested come back empty.
function canteenReadCols_(fields, create) {
  const sh = create === false ? getSpreadsheet_().getSheetByName(CANTEEN_SHEET) : canteenSheet_();
  if (!sh) return { sh: null, rows: [] };
  const n = sh.getLastRow() - 1;
  if (n < 1) return { sh, rows: [] };
  const idx = Array.from(new Set(['TX'].concat(fields).map(f => CANTEEN_COL[f]))).sort((a, b) => a - b);
  const cols = {};
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
    const vals = sh.getRange(2, idx[i] + 1, n, j - i + 1).getValues();
    for (let k = i; k <= j; k++) cols[idx[k]] = vals.map(r => r[k - i]);
    i = j + 1;
  }
  const blank = new Array(CANTEEN_HEADERS.length).fill('');
  const rows = [];
  for (let r = 0; r < n; r++) {
    if (!cols[0][r]) continue;
    const arr = blank.slice();
    idx.forEach(cIdx => { arr[cIdx] = cols[cIdx][r]; });
    rows.push(canteenParseRow_(arr, r + 2));
  }
  return { sh, rows };
}
const CANTEEN_REGISTER_FIELDS = ['DATE', 'SID', 'TYPE', 'AMT', 'NOTES', 'KEY'];
function canteenNewRow_(f) {
  const r = new Array(CANTEEN_HEADERS.length).fill('');
  const C = CANTEEN_COL;
  r[C.TX] = f.txId; r[C.DATE] = f.date; r[C.SID] = f.sid; r[C.NAME] = f.name; r[C.CLASS] = f.cls;
  r[C.TYPE] = f.type; r[C.DAYS] = f.days || 0; r[C.RATE] = f.rate || 0; r[C.AMT] = r2(f.amount);
  r[C.METHOD] = f.method || ''; r[C.REF] = f.reference || ''; r[C.RCPT] = f.receipt || '';
  r[C.TERM] = CONFIG.CURRENT_TERM; r[C.AY] = CONFIG.CURRENT_ACADEMIC_YEAR;
  r[C.BY] = f.by || ''; r[C.AT] = new Date().toISOString(); r[C.NOTES] = f.notes || ''; r[C.KEY] = f.key || '';
  return r;
}
let _canteenTxSeq = 0;
function canteenTxId_(prefix) { return prefix + Date.now() + '_' + (++_canteenTxSeq); }

// ==================== SETTINGS & BALANCES ====================
function canteenSettings_() {
  let classRates = {};
  try { classRates = JSON.parse(getSetting_('CanteenClassRates') || '{}') || {}; } catch (e) { classRates = {}; }
  const allow = getSetting_('CanteenAllowCredit');
  return {
    defaultRate: numSetting_('CanteenDailyRate', 0),
    classRates,
    allowCredit: allow === null || allow === '' ? true : String(allow).toLowerCase() !== 'false',
    creditLimit: numSetting_('CanteenCreditLimit', 0)   // 0 = no limit
  };
}
function canteenRateFor_(settings, classCode) {
  const v = settings.classRates[classCode];
  const n = parseFloat(v);
  return (v !== undefined && v !== null && v !== '' && !isNaN(n) && n >= 0) ? n : settings.defaultRate;
}
function canteenBalances_(rows) {
  const map = {};
  rows.forEach(r => {
    if (!r.sid) return;
    if (r.type === 'PAYMENT') map[r.sid] = r2((map[r.sid] || 0) + r.amount);
    else if (r.type === 'MEAL') map[r.sid] = r2((map[r.sid] || 0) - r.amount);
    else if (r.type === 'OPENING') map[r.sid] = r2((map[r.sid] || 0) + r.amount);   // signed: brought forward
  });
  return map;
}
function canteenStatus_(balance, rate) {
  if (balance < -0.004) return { label: 'Owes', days: rate > 0 ? Math.ceil(-balance / rate - 0.0001) : 0, extra: 0 };
  if (balance > 0.004) { const c = canteenCoverage_(balance, rate); return { label: 'Prepaid', days: c.days, extra: c.extra }; }
  return { label: 'Clear', days: 0, extra: 0 };
}
// Would a meal (or meals) leaving the student at `projected` be allowed?
function canteenCreditCheck_(settings, projected) {
  if (projected >= -0.004) return '';
  if (!settings.allowCredit) return 'credit feeding is switched off and the student has no prepaid balance';
  if (settings.creditLimit > 0 && -projected > settings.creditLimit + 0.004)
    return 'would exceed the credit limit of GH₵' + settings.creditLimit.toFixed(2);
  return '';
}
function canteenValidDate_(date) {
  const s = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !parseYMD_(s)) return { error: 'Please choose a valid date.' };
  if (s > todayStr_()) return { error: 'You cannot record canteen activity for a future date.' };
  const through = String(getSetting_('CanteenArchivedThrough') || '');
  if (through && s <= through) return { error: `Canteen records up to ${through} belong to closed terms that have been archived and can no longer be changed.` };
  return { date: s };
}

// ==================== SETTINGS API ====================
function getCanteenSettings(params) {
  clearRequestCache_();
  requireAccess_((params || {}).token, 'canteen');
  const s = canteenSettings_();
  return Object.assign(s, { classes: getClasses_(), methods: CANTEEN_METHODS });
}
function saveCanteenSettings(params) {
  clearRequestCache_();
  const { token, defaultRate, classRates, allowCredit, creditLimit } = params || {};
  const admin = requireRole(token, ['Admin']);
  const rate = parseFloat(defaultRate);
  if (isNaN(rate) || rate < 0) return { success: false, message: 'Default daily rate must be zero or more.' };
  const limit = parseFloat(creditLimit || 0);
  if (isNaN(limit) || limit < 0) return { success: false, message: 'Credit limit must be zero or more (0 = no limit).' };
  const valid = new Set(getClasses_().map(c => c.code));
  const clean = {};
  Object.keys(classRates || {}).forEach(code => {
    const v = classRates[code];
    if (!valid.has(code) || v === '' || v === null || v === undefined) return;
    const n = parseFloat(v);
    if (!isNaN(n) && n >= 0) clean[code] = r2(n);
  });
  setSetting_('CanteenDailyRate', r2(rate));
  setSetting_('CanteenClassRates', JSON.stringify(clean));
  setSetting_('CanteenAllowCredit', allowCredit ? 'true' : 'false');
  setSetting_('CanteenCreditLimit', r2(limit));
  appendAudit_('CANTEEN_SETTINGS', `Rate ${rate}, class rates ${JSON.stringify(clean)}, credit ${allowCredit ? 'on' : 'off'}, limit ${limit}`, admin.email);
  return { success: true, message: 'Canteen settings saved' };
}

// ==================== BALANCES (payments page & debtors) ====================
function getCanteenBalances(params) {
  clearRequestCache_();
  const { token, classCode } = params || {};
  requireAccess_(token, 'canteen');
  syncConfig_();
  const settings = canteenSettings_();
  const balances = canteenBalances_(canteenReadCols_(['SID', 'TYPE', 'AMT'], false).rows);
  let students = loadStudents_();
  if (classCode && classCode !== 'All') students = students.filter(s => s.Class === classCode);
  return {
    success: true,
    settings: { defaultRate: settings.defaultRate, allowCredit: settings.allowCredit, creditLimit: settings.creditLimit },
    students: students.map(s => {
      const rate = canteenRateFor_(settings, s.Class);
      const bal = balances[s.StudentID] || 0;
      const st = canteenStatus_(bal, rate);
      return { studentID: s.StudentID, name: s.FullName, cls: s.Class, rate, balance: bal, status: st.label, days: st.days, extra: st.extra };
    }).sort((a, b) => String(a.cls).localeCompare(String(b.cls)) || String(a.name).localeCompare(String(b.name)))
  };
}

// ==================== DAILY REGISTER ====================
// Present = the student eats today. How the meal is covered is decided
// automatically, in this order:
//   1. Prepaid  – their balance covers the day's rate → deducted.
//   2. Credit   – "Feed on credit, pay later" ticked  → balance goes negative.
//   3. Charged  – otherwise they pay today; any leftover credit is used first,
//                 so they only pay the shortfall (e.g. GH₵2 credit, rate GH₵5
//                 → pays GH₵3).
// Absent = not eating → no meal, no charge.
function canteenDayState_(rows, date) {
  const meal = {}, pay = {};
  rows.forEach(r => {
    if (r.date !== date) return;
    if (r.type === 'MEAL' && r.key === 'MEAL|' + r.sid + '|' + date) meal[r.sid] = r;
    if (r.type === 'PAYMENT' && r.key === 'DAILYPAY|' + r.sid + '|' + date) pay[r.sid] = r;
  });
  return { meal, pay };
}
// Balance before this date's register entries (so re-saving is idempotent).
function canteenBaseBalance_(balance, meal, pay) {
  return r2((balance || 0) + (meal ? meal.amount : 0) - (pay ? pay.amount : 0));
}
function canteenPlan_(base, rate, credit) {
  if (base >= rate - 0.004) return { mode: 'prepaid', pay: 0 };
  if (credit) return { mode: 'credit', pay: 0 };
  return { mode: 'charged', pay: r2(rate - Math.max(0, base)) };
}
function getCanteenRegister(params) {
  clearRequestCache_();
  const { token, date, classCode } = params || {};
  requireAccess_(token, 'canteen');
  syncConfig_();
  const d = canteenValidDate_(date);
  if (d.error) return { success: false, message: d.error };
  const settings = canteenSettings_();
  const rows = canteenReadCols_(CANTEEN_REGISTER_FIELDS, false).rows;
  const balances = canteenBalances_(rows);
  const day = canteenDayState_(rows, d.date);
  let students = loadStudents_();
  if (classCode && classCode !== 'All') students = students.filter(s => s.Class === classCode);
  students = students.slice().sort((a, b) => String(a.FullName).localeCompare(String(b.FullName)));
  const out = students.map(s => {
    const meal = day.meal[s.StudentID], pay = day.pay[s.StudentID];
    return { studentID: s.StudentID, name: s.FullName, cls: s.Class,
             rate: meal ? meal.amount : canteenRateFor_(settings, s.Class),
             base: canteenBaseBalance_(balances[s.StudentID], meal, pay),
             present: !!meal, credit: !!(meal && meal.notes === 'On credit'), paidToday: pay ? pay.amount : 0 };
  });
  return { success: true, date: d.date, anySaved: out.some(r => r.present),
           settings: { defaultRate: settings.defaultRate, allowCredit: settings.allowCredit, creditLimit: settings.creditLimit },
           rows: out };
}
function saveCanteenRegister(params) {
  clearRequestCache_();
  const { token, date, entries } = params || {};
  const user = requireAccess_(token, 'canteen');
  syncConfig_();
  const d = canteenValidDate_(date);
  if (d.error) return { success: false, message: d.error };
  if (!Array.isArray(entries) || !entries.length) return { success: false, message: 'Nothing to save.' };
  const settings = canteenSettings_();
  return withScriptLock_(30000, () => {
    const { sh, rows } = canteenReadCols_(CANTEEN_REGISTER_FIELDS, true);
    const balances = canteenBalances_(rows);
    const day = canteenDayState_(rows, d.date);
    const inserts = [], deletes = [], noteUpdates = [], blocked = [];
    const tally = { prepaid: 0, charged: 0, credit: 0, absent: 0, cash: 0 };
    const seen = new Set();
    entries.forEach(e => {
      const sid = String(e.studentID || '').trim();
      if (!sid || seen.has(sid)) return;
      seen.add(sid);
      const s = getStudentByIdDirect_(sid);
      if (!s) return;
      const meal = day.meal[sid], pay = day.pay[sid];
      if (!e.present) {
        if (meal) deletes.push(meal.row);
        if (pay) deletes.push(pay.row);
        tally.absent++;
        return;
      }
      const rate = meal ? meal.amount : canteenRateFor_(settings, s.Class);
      if (!(rate > 0)) { blocked.push({ name: s.FullName, reason: 'no canteen rate is set for class ' + s.Class }); return; }
      const base = canteenBaseBalance_(balances[sid], meal, pay);
      const plan = canteenPlan_(base, rate, !!e.credit);
      if (plan.mode === 'credit') {
        const reason = canteenCreditCheck_(settings, r2(base - rate));
        if (reason) { blocked.push({ name: s.FullName, reason }); return; }   // left exactly as it was
      }
      // Today's payment: replace only if the amount needed has changed.
      const curPay = pay ? pay.amount : 0;
      if (Math.abs(curPay - plan.pay) > 0.004) {
        if (pay) deletes.push(pay.row);
        if (plan.pay > 0) inserts.push(canteenNewRow_({ txId: canteenTxId_('CPY'), date: d.date, sid, name: s.FullName, cls: s.Class,
          type: 'PAYMENT', days: 1, rate, amount: plan.pay, method: 'Cash', by: user.email, notes: 'Paid at feeding', key: 'DAILYPAY|' + sid + '|' + d.date }));
      }
      const note = plan.mode === 'prepaid' ? 'Prepaid' : plan.mode === 'credit' ? 'On credit' : 'Paid today';
      if (!meal) {
        inserts.push(canteenNewRow_({ txId: canteenTxId_('CML'), date: d.date, sid, name: s.FullName, cls: s.Class,
          type: 'MEAL', days: 1, rate, amount: rate, by: user.email, notes: note, key: 'MEAL|' + sid + '|' + d.date }));
      } else if (meal.notes !== note) {
        noteUpdates.push({ row: meal.row, note });
      }
      tally[plan.mode]++; tally.cash = r2(tally.cash + plan.pay);
    });
    // Notes first (row numbers still valid), then deletes, then appends.
    noteUpdates.forEach(u => sh.getRange(u.row, CANTEEN_COL.NOTES + 1).setValue(u.note));
    deleteRowsGrouped_(sh, deletes);
    if (inserts.length) appendRows_(sh, inserts);
    const fed = tally.prepaid + tally.charged + tally.credit;
    return { success: true, blocked, tally,
             message: `${fed} fed: ${tally.prepaid} prepaid, ${tally.charged} paid today (GH₵${tally.cash.toFixed(2)} cash), ${tally.credit} on credit. ${tally.absent} absent.` +
                      (blocked.length ? ` ${blocked.length} could NOT be fed — see list.` : '') };
  });
}

// ==================== PAYMENTS ====================
// Payments are MONEY, not days. The system converts the resulting balance
// into days: e.g. GH₵23 at GH₵5/day = 4 days + GH₵3.00 credit. Leftover
// credit is used automatically toward the next meal.
//   mode 'amount' → any amount (default)
//   mode 'debt'   → exactly what the student owes
function canteenCoverage_(balance, rate) {
  if (!(balance > 0) || !(rate > 0)) return { days: 0, extra: balance > 0 ? r2(balance) : 0 };
  const days = Math.floor(balance / rate + 0.0001);
  return { days, extra: r2(Math.max(0, balance - days * rate)) };
}
function recordCanteenPayment(params) {
  clearRequestCache_();
  const { token, studentID, mode, amount, method, reference, notes, idempotencyKey, date } = params || {};
  const user = requireAccess_(token, 'canteen');
  syncConfig_();
  const payMethod = String(method || 'Cash');
  if (!CANTEEN_METHODS.includes(payMethod)) return { success: false, message: 'Invalid payment method.' };
  const ref = String(reference || '').trim();
  if (payMethod === 'Mobile Money' && !ref) return { success: false, message: 'Enter the MoMo transaction ID.' };
  // The day the money was received. The offline app sends it, so a payment
  // taken without internet keeps its real date when it is synced later. A
  // date ahead of the server's day (wrong device clock) is treated as today.
  let payDate = todayStr_();
  if (date !== undefined && date !== null && String(date).trim() !== '') {
    const pd = String(date).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pd) || !parseYMD_(pd)) return { success: false, message: 'Please choose a valid payment date.' };
    if (pd < payDate) payDate = pd;
  }
  const rec = findStudentRecord_(studentID);
  if (!rec) return { success: false, message: 'Student not found' };
  if (String(rec.student.Status || '').toLowerCase() === 'inactive') return { success: false, message: 'This student is inactive.' };
  const settings = canteenSettings_();
  const s = rec.student;
  const rate = canteenRateFor_(settings, s.Class);
  return withScriptLock_(30000, () => {
    const { sh, rows } = canteenReadCols_(['SID', 'TYPE', 'AMT', 'RCPT', 'KEY'], true);
    if (idempotencyKey) {
      const dup = rows.find(r => r.key === 'PAY|' + idempotencyKey);
      if (dup) {
        const nb = canteenBalances_(rows)[s.StudentID] || 0, cov = canteenCoverage_(nb, rate);
        return { success: true, duplicate: true, receiptNumber: dup.receipt, txId: dup.txId, amount: dup.amount, newBalance: nb,
                 coveredDays: cov.days, extra: cov.extra, message: 'Already recorded — duplicate ignored.' };
      }
    }
    const balance = canteenBalances_(rows)[s.StudentID] || 0;
    let amt;
    if (mode === 'debt') {
      if (balance >= -0.004) return { success: false, message: 'This student has no canteen debt.' };
      amt = r2(-balance);
    } else {
      amt = r2(parseFloat(amount));
      if (!(amt > 0)) return { success: false, message: 'Enter an amount greater than 0.' };
    }
    const newBal = r2(balance + amt);
    const cov = canteenCoverage_(newBal, rate);
    const debtPaid = balance < 0 ? r2(Math.min(amt, -balance)) : 0;
    const parts = [];
    if (debtPaid > 0) parts.push(newBal >= -0.004 ? `Cleared debt of GH₵${debtPaid.toFixed(2)}` : `Paid GH₵${debtPaid.toFixed(2)} towards debt`);
    if (newBal > 0.004) parts.push(cov.days > 0
      ? `covers ${cov.days} day(s)` + (cov.extra > 0 ? ` + GH₵${cov.extra.toFixed(2)} credit` : '')
      : `GH₵${cov.extra.toFixed(2)} credit kept for the next meal`);
    if (newBal < -0.004) parts.push(`still owes GH₵${(-newBal).toFixed(2)}`);
    const label = parts.join('; ') || 'Canteen payment';
    const receipt = 'CNT/' + new Date().getFullYear() + '/' + String(incrementSetting_('LastCanteenReceipt')).padStart(4, '0');
    const txId = canteenTxId_('CPY');
    sh.appendRow(canteenNewRow_({ txId, date: payDate, sid: s.StudentID, name: s.FullName, cls: s.Class, type: 'PAYMENT',
      days: cov.days, rate, amount: amt, method: payMethod, reference: ref ? "'" + ref : '', receipt, by: user.email,
      notes: label + (notes ? ' — ' + String(notes).trim() : ''), key: idempotencyKey ? 'PAY|' + idempotencyKey : '' }));
    return { success: true, receiptNumber: receipt, txId, amount: amt, newBalance: newBal, coveredDays: cov.days, extra: cov.extra,
             summary: label, message: 'Canteen payment recorded' };
  });
}
function getCanteenStudentAccount(params) {
  clearRequestCache_();
  const { token, sid } = params || {};
  requireAccess_(token, 'canteen');
  syncConfig_();
  const rec = findStudentRecord_(sid);
  if (!rec) return { success: false, message: 'Student not found' };
  const settings = canteenSettings_();
  const s = rec.student;
  const rate = canteenRateFor_(settings, s.Class);
  const mine = canteenReadCols_(['DATE', 'SID', 'TYPE', 'DAYS', 'AMT', 'METHOD', 'RCPT', 'NOTES', 'AT'], false).rows.filter(r => r.sid === s.StudentID);
  const balance = canteenBalances_(mine)[s.StudentID] || 0;
  const st = canteenStatus_(balance, rate);
  mine.sort((a, b) => (b.date + b.at).localeCompare(a.date + a.at));
  return {
    success: true,
    student: { studentID: s.StudentID, name: s.FullName, cls: s.Class },
    rate, balance, status: st.label, days: st.days, extra: st.extra,
    settings: { allowCredit: settings.allowCredit, creditLimit: settings.creditLimit },
    transactions: mine.slice(0, 200).map(r => ({ txId: r.txId, date: r.date, type: r.type, days: r.days, amount: r.amount,
      method: r.method, receipt: r.receipt, notes: r.notes }))
  };
}
function getCanteenReceipt(params) {
  clearRequestCache_();
  const { token, txId } = params || {};
  const me = requireAccess_(token, 'canteen');
  const rows = canteenReadAll_(false).rows;
  const tx = rows.find(r => r.txId === String(txId) && r.type === 'PAYMENT');
  if (!tx) return null;
  return {
    txId: tx.txId, date: tx.date, studentID: tx.sid, studentName: tx.name, cls: tx.cls, amount: tx.amount, days: tx.days,
    rate: tx.rate, method: tx.method, reference: tx.reference, receipt: tx.receipt, notes: tx.notes,
    balanceNow: canteenBalances_(rows.filter(r => r.sid === tx.sid))[tx.sid] || 0,
    schoolName: getSetting_('SchoolName') || CONFIG.SCHOOL_NAME, schoolMotto: getSetting_('SchoolMotto') || CONFIG.SCHOOL_MOTTO,
    schoolAddress: getSetting_('SchoolAddress') || CONFIG.SCHOOL_ADDRESS, schoolPhone: getSetting_('SchoolPhone') || CONFIG.SCHOOL_PHONE,
    schoolCrest: getSetting_('SchoolCrest') || '', schoolEmail: getSetting_('SchoolEmail') || CONFIG.SCHOOL_EMAIL,
    issuedBy: me.name || me.email
  };
}
// Admin only: removes a wrongly entered payment or meal (audit-logged).
function voidCanteenTransaction(params) {
  clearRequestCache_();
  const { token, txId } = params || {};
  const admin = requireAction_(token, 'canteen.void');
  return withScriptLock_(30000, () => {
    const { sh, rows } = canteenReadAll_(false);
    const tx = rows.find(r => r.txId === String(txId));
    if (!sh || !tx) return { success: false, message: 'Transaction not found' };
    if (tx.type === 'OPENING') return { success: false, message: 'A balance brought forward cannot be voided. Record a payment or contact the Admin to adjust.' };
    appendAudit_('CANTEEN_VOID', `${tx.type} ${tx.receipt || tx.txId} — ${tx.name} (${tx.sid}) GH₵${tx.amount} on ${tx.date}`, admin.email);
    deleteRowSafe_(sh, tx.row);
    return { success: true, message: 'Transaction removed' };
  });
}

// ==================== CANTEEN EXPENSES ====================
// Canteen money is kept apart from the school's finances: canteen income
// (payments) and canteen spending (foodstuff, gas, wages…) are both handled
// only on the Canteen page, and canteen reports show the canteen's net.
const CANTEEN_EXP_SHEET = 'Canteen_Expenses';
const CANTEEN_EXP_HEADERS = ['ExpenseID', 'Date', 'Description', 'Category', 'Amount', 'PaidBy', 'VoucherNumber', 'RecordedBy', 'Notes', 'Term', 'AcademicYear', 'Key'];
const CANTEEN_EXP_DEFAULT_CATEGORIES = ['Foodstuff', 'Gas / Fuel', 'Utensils & Supplies', 'Wages', 'Transport', 'Other'];
function canteenExpSheet_(create) {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(CANTEEN_EXP_SHEET);
  if (!sh && create !== false) {
    sh = ss.insertSheet(CANTEEN_EXP_SHEET);
    sh.getRange(1, 1, 1, CANTEEN_EXP_HEADERS.length).setValues([CANTEEN_EXP_HEADERS]).setFontWeight('bold').setBackground('#006B3F').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
    sh.getRange('B:B').setNumberFormat('@');                 // dates as yyyy-MM-dd text
    trimColumns_(sh, CANTEEN_EXP_HEADERS.length);
  }
  return sh || null;
}
function canteenExpenseRows_() {
  const sh = canteenExpSheet_(false);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, CANTEEN_EXP_HEADERS.length).getValues().map((r, i) => ({
    row: i + 2, id: String(r[0] || ''), date: String(fmtDate_(r[1]) || '').trim(), description: String(r[2] || ''),
    category: String(r[3] || 'Other'), amount: parseFloat(r[4]) || 0, paidBy: String(r[5] || ''), voucher: String(r[6] || ''),
    recordedBy: String(r[7] || ''), notes: String(r[8] || ''), term: r[9], ay: String(r[10] || '').trim(), key: String(r[11] || '')
  })).filter(x => x.id);
}
function canteenExpenseCategories_() {
  const raw = String(getSetting_('CanteenExpenseCategories') || '').trim();
  return raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : CANTEEN_EXP_DEFAULT_CATEGORIES.slice();
}
function getCanteenExpenses(params) {
  clearRequestCache_();
  const { token, startDate, endDate } = params || {};
  requireAccess_(token, 'canteen');
  const s = String(startDate || '') || '0000-01-01', e = String(endDate || '') || '9999-12-31';
  return { success: true, categories: canteenExpenseCategories_(),
           expenses: canteenExpenseRows_().filter(x => x.date >= s && x.date <= e).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
             .map(x => ({ id: x.id, date: x.date, description: x.description, category: x.category, amount: x.amount, paidBy: x.paidBy, voucher: x.voucher, notes: x.notes })) };
}
function canteenExpenseInput_(p) {
  const amount = r2(parseFloat(p.amount));
  if (!(amount > 0)) return { error: 'Please enter an amount greater than 0.' };
  const description = String(p.description || '').trim();
  if (!description) return { error: 'Please enter a description.' };
  const date = String(p.date || '').trim() || todayStr_();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !parseYMD_(date)) return { error: 'Please choose a valid date.' };
  if (date > todayStr_()) return { error: 'An expense cannot be dated in the future.' };
  return { amount, description, date, category: String(p.category || 'Other').trim() || 'Other', paidBy: String(p.paidBy || '').trim(), notes: String(p.notes || '').trim() };
}
function recordCanteenExpense(params) {
  clearRequestCache_();
  const { token, idempotencyKey } = params || {};
  const user = requireAccess_(token, 'canteen');
  syncConfig_();
  const v = canteenExpenseInput_(params || {});
  if (v.error) return { success: false, message: v.error };
  return withScriptLock_(30000, () => {
    const sh = canteenExpSheet_(true);
    if (idempotencyKey) {
      const dup = canteenExpenseRows_().find(x => x.key === idempotencyKey);
      if (dup) return { success: true, duplicate: true, voucherNumber: dup.voucher, message: 'Already recorded — duplicate ignored.' };
    }
    const voucher = 'CVCH/' + new Date().getFullYear() + '/' + String(incrementSetting_('LastCanteenVoucher')).padStart(4, '0');
    appendRows_(sh, [['CEX' + Date.now() + '_' + Utilities.getUuid().slice(0, 6), v.date, v.description, v.category, v.amount, v.paidBy, voucher, user.email, v.notes,
                      CONFIG.CURRENT_TERM, CONFIG.CURRENT_ACADEMIC_YEAR, idempotencyKey || '']]);
    return { success: true, voucherNumber: voucher, message: 'Canteen expense recorded' };
  });
}
function updateCanteenExpense(params) {
  clearRequestCache_();
  const { token, id } = params || {};
  requireAccess_(token, 'canteen');
  const v = canteenExpenseInput_(params || {});
  if (v.error) return { success: false, message: v.error };
  return withScriptLock_(30000, () => {
    const x = canteenExpenseRows_().find(r => r.id === String(id));
    if (!x) return { success: false, message: 'Expense not found' };
    canteenExpSheet_(false).getRange(x.row, 2, 1, 5).setValues([[v.date, v.description, v.category, v.amount, v.paidBy]]);
    canteenExpSheet_(false).getRange(x.row, 9).setValue(v.notes);
    return { success: true, message: 'Canteen expense updated' };
  });
}
function deleteCanteenExpense(params) {
  clearRequestCache_();
  const { token, id } = params || {};
  const user = requireAction_(token, 'canteen.void');
  return withScriptLock_(30000, () => {
    const x = canteenExpenseRows_().find(r => r.id === String(id));
    if (!x) return { success: false, message: 'Expense not found' };
    appendAudit_('CANTEEN_EXPENSE_DELETE', `${x.description} — GH₵${x.amount} (${x.voucher}) on ${x.date}`, user.email);
    deleteRowSafe_(canteenExpSheet_(false), x.row);
    return { success: true, message: 'Canteen expense deleted' };
  });
}
function saveCanteenExpenseCategories(params) {
  clearRequestCache_();
  const { token, categories } = params || {};
  requireAccess_(token, 'canteen');
  const clean = Array.from(new Set((Array.isArray(categories) ? categories : []).map(c => String(c).replace(/,/g, ' ').trim()).filter(Boolean)));
  if (!clean.length) return { success: false, message: 'Keep at least one category.' };
  setSetting_('CanteenExpenseCategories', clean.join(','));
  return { success: true, categories: clean };
}

// ==================== REPORTS ====================
function getCanteenReport(params) {
  clearRequestCache_();
  const { token, startDate, endDate } = params || {};
  requireAccess_(token, 'canteen');
  syncConfig_();
  const start = String(startDate || '').trim() || '0000-01-01';
  const end = String(endDate || '').trim() || todayStr_();
  if (start > end) return { success: false, message: 'The start date must be before the end date.' };
  const rows = canteenReadCols_(['DATE', 'SID', 'CLASS', 'TYPE', 'AMT', 'METHOD', 'NOTES'], false).rows;
  let cash = 0, meals = 0, mealsValue = 0, creditMeals = 0;
  const byMethod = {}, byClass = {}, byDay = {};
  rows.forEach(r => {
    if (r.date < start || r.date > end) return;
    const c = byClass[r.cls] = byClass[r.cls] || { cls: r.cls, meals: 0, mealsValue: 0, cash: 0 };
    const dd = byDay[r.date] = byDay[r.date] || { date: r.date, meals: 0, mealsValue: 0, cash: 0 };
    if (r.type === 'PAYMENT') {
      cash += r.amount; c.cash += r.amount; dd.cash += r.amount;
      byMethod[r.method || 'Cash'] = (byMethod[r.method || 'Cash'] || 0) + r.amount;
    } else if (r.type === 'MEAL') {
      meals++; mealsValue += r.amount; c.meals++; c.mealsValue += r.amount; dd.meals++; dd.mealsValue += r.amount;
      if (r.notes === 'On credit') creditMeals++;
    }
  });
  // Archived terms: add their stored daily totals.
  canteenSummaryRows_().forEach(sr => {
    if (sr.date < start || sr.date > end) return;
    const c = byClass[sr.cls] = byClass[sr.cls] || { cls: sr.cls, meals: 0, mealsValue: 0, cash: 0 };
    const dd = byDay[sr.date] = byDay[sr.date] || { date: sr.date, meals: 0, mealsValue: 0, cash: 0 };
    cash += sr.cash; c.cash += sr.cash; dd.cash += sr.cash;
    Object.keys(sr.byMethod).forEach(m => { if (sr.byMethod[m]) byMethod[m] = (byMethod[m] || 0) + sr.byMethod[m]; });
    meals += sr.meals; c.meals += sr.meals; dd.meals += sr.meals;
    mealsValue += sr.mealsValue; c.mealsValue += sr.mealsValue; dd.mealsValue += sr.mealsValue;
    creditMeals += sr.creditMeals;
  });
  // Canteen spending in the same period.
  let expenses = 0;
  const expByCategory = {};
  canteenExpenseRows_().forEach(x => {
    if (x.date < start || x.date > end) return;
    expenses += x.amount;
    expByCategory[x.category] = r2((expByCategory[x.category] || 0) + x.amount);
    const dd = byDay[x.date] = byDay[x.date] || { date: x.date, meals: 0, mealsValue: 0, cash: 0 };
    dd.expenses = r2((dd.expenses || 0) + x.amount);
  });
  // Position right now (active students only).
  const balances = canteenBalances_(rows);
  let owed = 0, prepaid = 0, debtors = 0;
  loadStudents_().forEach(s => {
    const b = balances[s.StudentID] || 0;
    if (b < 0) { owed += -b; debtors++; } else prepaid += b;
  });
  const fix = o => Object.keys(o).forEach(k => { ['cash','mealsValue'].forEach(f => { if (o[k][f] !== undefined) o[k][f] = r2(o[k][f]); }); });
  fix(byClass); fix(byDay);
  Object.keys(byMethod).forEach(k => { byMethod[k] = r2(byMethod[k]); });
  return {
    success: true, startDate: start === '0000-01-01' ? '' : start, endDate: end,
    cashReceived: r2(cash), mealsServed: meals, mealsValue: r2(mealsValue), creditMeals, byMethod,
    totalExpenses: r2(expenses), expensesByCategory: expByCategory, net: r2(cash - expenses),
    byClass: Object.values(byClass).sort((a, b) => String(a.cls).localeCompare(String(b.cls))),
    byDay: Object.values(byDay).sort((a, b) => b.date.localeCompare(a.date)),
    owedNow: r2(owed), prepaidNow: r2(prepaid), debtorsNow: debtors,
    schoolName: getSetting_('SchoolName') || CONFIG.SCHOOL_NAME
  };
}

// ==================== HOOKS USED BY Code.gs (finance integration) ====================
// Canteen cash received between two Date objects.
function canteenIncomeInRange_(startDate, endDate) {
  const s = fmtDate_(startDate), e = fmtDate_(endDate);
  const live = canteenReadCols_(['DATE', 'TYPE', 'AMT'], false).rows.reduce((t, r) => t + (r.type === 'PAYMENT' && r.date >= s && r.date <= e ? r.amount : 0), 0);
  const archived = canteenSummaryRows_().reduce((t, r) => t + (r.date >= s && r.date <= e ? r.cash : 0), 0);
  return r2(live + archived);
}
// Canteen cash received in an academic year (and optionally one term).
function canteenIncomeForPeriod_(year, term) {
  const y = String(year).trim(), anyTerm = term === null || term === undefined;
  const live = canteenReadCols_(['TYPE', 'AMT', 'TERM', 'AY'], false).rows.reduce((t, r) => t + (r.type === 'PAYMENT' && r.ay === y &&
    (anyTerm || parseInt(r.term, 10) === term) ? r.amount : 0), 0);
  const archived = canteenSummaryRows_().reduce((t, r) => t + (r.ay === y && (anyTerm || r.term === term) ? r.cash : 0), 0);
  return r2(live + archived);
}

// ==================== ARCHIVE HOOK (called by archiveClosedTerms in Code.gs) ====================
// `strRows` are the archived ledger rows (as text). Adds, idempotently per
// batch: one OPENING row per student carrying their balance forward, and
// per-day/per-class summary rows for reports. Safe to call twice.
function canteenCommitArchive_(headers, strRows, batch) {
  const H = n => headers.indexOf(n);
  const iDate = H('Date'), iSid = H('StudentID'), iName = H('StudentName'), iCls = H('Class'), iType = H('Type'),
        iAmt = H('Amount'), iMethod = H('Method'), iTerm = H('Term'), iAy = H('AcademicYear'), iNotes = H('Notes'), iKey = H('Key');
  const delta = {}, who = {}, summary = {};
  let maxDate = '';
  strRows.forEach(r => {
    const sid = String(r[iSid] || '').trim(), type = String(r[iType] || '').toUpperCase(), amt = parseFloat(r[iAmt]) || 0;
    if (!sid) return;
    who[sid] = who[sid] || { name: r[iName], cls: r[iCls] };
    if (type === 'PAYMENT' || type === 'OPENING') delta[sid] = (delta[sid] || 0) + amt;
    else if (type === 'MEAL') delta[sid] = (delta[sid] || 0) - amt;
    if (type !== 'PAYMENT' && type !== 'MEAL') return;
    const date = String(r[iDate] || '');
    // Lock only days that had REGISTER entries (meals / pay-at-register). A
    // normal payment is dated the day it was taken, which may be today.
    const fromRegister = type === 'MEAL' || String(r[iKey] || '').indexOf('DAILYPAY|') === 0;
    if (fromRegister && date > maxDate) maxDate = date;
    const k = [date, r[iTerm], r[iAy], r[iCls]].join('|');
    const s = summary[k] = summary[k] || { date, term: r[iTerm], ay: r[iAy], cls: r[iCls], cash: 0, m: { 'Cash': 0, 'Mobile Money': 0, 'Bank': 0 }, meals: 0, value: 0, credit: 0 };
    if (type === 'PAYMENT') { s.cash += amt; s.m[CANTEEN_METHODS.includes(r[iMethod]) ? r[iMethod] : 'Cash'] += amt; }
    else { s.meals++; s.value += amt; if (String(r[iNotes]) === 'On credit') s.credit++; }
  });
  const sh = canteenSheet_();
  if (!canteenReadCols_(['KEY'], true).rows.some(x => x.key.indexOf('OPEN|' + batch + '|') === 0)) {
    appendRows_(sh, Object.keys(delta).filter(sid => Math.abs(delta[sid]) > 0.004).map(sid => canteenNewRow_({
      txId: canteenTxId_('COB'), date: todayStr_(), sid, name: who[sid].name, cls: who[sid].cls, type: 'OPENING',
      amount: delta[sid], notes: 'Balance brought forward from archived terms', key: 'OPEN|' + batch + '|' + sid })));
  }
  const sumSh = canteenSummarySheet_();
  const already = sumSh.getLastRow() > 1 && sumSh.getRange(2, CANTEEN_SUMMARY_HEADERS.length, sumSh.getLastRow() - 1, 1).getValues().some(v => v[0] === batch);
  if (!already) appendRows_(sumSh, Object.values(summary).map(s => [s.date, s.term, s.ay, s.cls, r2(s.cash), r2(s.m['Cash']),
    r2(s.m['Mobile Money']), r2(s.m['Bank']), s.meals, r2(s.value), s.credit, batch]));
  if (maxDate && maxDate > String(getSetting_('CanteenArchivedThrough') || '')) setSetting_('CanteenArchivedThrough', maxDate);
}