// ========================================================================
// iSmartSchool – Payroll Module (Google Apps Script)
// ------------------------------------------------------------------------
// Add this as a SEPARATE script file named PayrollModule.gs next to
// Code.gs. It reuses Code.gs helpers (auth, locks, settings, expenses),
// so it does not work on its own.
//
// HOW IT WORKS
//   1. Staff register: basic salary, fixed allowances, fixed deductions,
//      and whether SSNIT and PAYE apply to that person.
//   2. Each month: "Prepare payroll" builds a DRAFT from the register.
//      Per-month bonus / extra deduction (e.g. salary advance) can be added.
//   3. "Approve & pay" freezes the month and posts it to Expenses:
//        Salaries & Wages  = net pay + other deductions
//        SSNIT & Pension   = employee SSNIT + employer SSNIT
//        PAYE Tax          = PAYE withheld
//      (total = gross pay + employer SSNIT = full cost to the school)
//      Those expense rows are locked on the Expenses page; "Reverse" on the
//      payroll removes them and reopens the month as a draft.
//
// SSNIT and PAYE are OPTIONAL — switched on/off for the whole school in
// Payroll → Settings, and per staff member. Rates and PAYE bands are
// editable there; the defaults are Ghana's rates for 2026.
//
// Every name in this file starts with "payroll"/"Payroll"/"PAYROLL_"
// so it can never clash with Code.gs.
// ========================================================================
const PAYROLL_STAFF_SHEET = 'Payroll_Staff';
const PAYROLL_RUNS_SHEET = 'Payroll_Runs';
const PAYROLL_LINES_SHEET = 'Payroll_Lines';
const PAYROLL_STAFF_HEADERS = ['StaffID','FullName','Position','Phone','Email','PayMethod','AccountDetails','SSNITNumber',
  'GhanaCardTIN','BasicSalary','Allowances','Deductions','SSNITApplies','PAYEApplies','Status','StartDate','Notes','CreatedBy','CreatedDate',
  'Qualification'];
const PAYROLL_RUN_HEADERS = ['RunID','Month','Status','StaffCount','TotalGross','TotalSSNITEmployee','TotalPAYE','TotalOtherDeductions',
  'TotalNet','TotalSSNITEmployer','TotalCost','SettingsJSON','Excluded','PreparedBy','PreparedAt','PaidDate','PayMethod','Reference',
  'PaidBy','PaidAt','Vouchers','Notes'];
const PAYROLL_LINE_HEADERS = ['RunID','Month','StaffID','FullName','Position','PayMethod','AccountDetails','SSNITNumber','Basic',
  'AllowancesJSON','AllowancesTotal','Bonus','Gross','SSNITBase','SSNITEmployee','Taxable','PAYE','DeductionsJSON','ExtraDeduction',
  'OtherDeductions','NetPay','SSNITEmployer','SSNITApplied','PAYEApplied','Note','GhanaCardTIN'];
const PAYROLL_METHODS = ['Bank', 'Mobile Money', 'Cash', 'Cheque'];
const PAYROLL_KEY_PREFIX = 'PAYROLL|';
const PAYROLL_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// Ghana defaults (editable in Payroll → Settings).
//  • SSNIT: employee 5.5%, employer 13% of BASIC salary (18.5% in total:
//    13.5% Tier 1 + 5% Tier 2). Employee SSNIT is deducted before PAYE.
//    Maximum insurable earnings for 2026: GH₵69,000 a month.
//  • PAYE: monthly resident bands under the Income Tax (Amendment) Act,
//    2026 (Act 1178), in force from 1 September 2026.
const PAYROLL_GH_BANDS_2026 = [
  { width: 588, rate: 0 }, { width: 80, rate: 5 }, { width: 100, rate: 10 }, { width: 2900, rate: 17.5 },
  { width: 16000, rate: 25 }, { width: 30332, rate: 30 }, { width: null, rate: 35 }];
const PAYROLL_DEFAULTS = {
  ssnitEnabled: true, payeEnabled: true,
  ssnitEmployeeRate: 5.5, ssnitEmployerRate: 13, ssnitMaxInsurable: 69000,
  payeBands: PAYROLL_GH_BANDS_2026, payeBandsLabel: 'Ghana PAYE — Act 1178 (from 1 Sep 2026)',
  categories: { salaries: 'Salaries & Wages', ssnit: 'SSNIT & Pension', paye: 'PAYE Tax' }
};

// ==================== STORAGE ====================
function payrollSheet_(name, headers, textCols) {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#006B3F').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
    // Months (2026-10), dates, phones, account and SSNIT numbers stay plain
    // text: Sheets would otherwise turn "2026-10" into a date and drop
    // leading zeros.
    (textCols || []).forEach(c => { try { sh.getRange(1, c, sh.getMaxRows(), 1).setNumberFormat('@'); } catch (e) {} });
    trimColumns_(sh, headers.length);
  }
  return sh;
}
function payrollStaffSheet_() {
  const sh = payrollSheet_(PAYROLL_STAFF_SHEET, PAYROLL_STAFF_HEADERS, [1, 4, 7, 8, 9, 16]);
  // Columns added after the first release (e.g. Qualification) are appended
  // to staff sheets that already exist.
  const n = PAYROLL_STAFF_HEADERS.length;
  if (sh.getLastColumn() < n) {
    ensureCols_(sh, n);
    const have = sh.getLastColumn();
    sh.getRange(1, have + 1, 1, n - have).setValues([PAYROLL_STAFF_HEADERS.slice(have)])
      .setFontWeight('bold').setBackground('#006B3F').setFontColor('#FFFFFF');
  }
  return sh;
}
function payrollRunsSheet_() { return payrollSheet_(PAYROLL_RUNS_SHEET, PAYROLL_RUN_HEADERS, [1, 2, 16]); }
function payrollLinesSheet_() { return payrollSheet_(PAYROLL_LINES_SHEET, PAYROLL_LINE_HEADERS, [1, 2, 3, 7, 8, 26]); }

function payrollRows_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
}
function payrollText_(v) { return v === null || v === undefined ? '' : String(v).replace(/^'/, '').trim(); }
// A month cell may come back as a Date if someone typed into the sheet.
function payrollMonthStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, getTz_(), 'yyyy-MM');
  return payrollText_(v);
}
function payrollValidMonth_(m) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || '')); }
function payrollMonthLabel_(m) {
  const p = String(m || '').split('-');
  return (PAYROLL_MONTHS[(+p[1]) - 1] || '') + ' ' + (p[0] || '');
}
function payrollJSON_(v, def) {
  try { const x = JSON.parse(String(v || '')); return x === null || x === undefined ? def : x; } catch (e) { return def; }
}
function payrollYes_(v) { return v === true || /^(yes|true|1|y)$/i.test(String(v || '').trim()); }
// [{name, amount}] with blank / zero lines removed.
function payrollItems_(list) {
  return (Array.isArray(list) ? list : []).map(x => ({ name: sanitize_(x && x.name).slice(0, 60), amount: r2(parseFloat(x && x.amount)) }))
    .filter(x => x.name && x.amount > 0);
}

// ==================== SETTINGS ====================
function payrollSettings_() {
  const saved = payrollJSON_(getSetting_('PayrollSettings'), {}) || {};
  const cfg = JSON.parse(JSON.stringify(PAYROLL_DEFAULTS));
  ['ssnitEnabled', 'payeEnabled'].forEach(k => { if (typeof saved[k] === 'boolean') cfg[k] = saved[k]; });
  ['ssnitEmployeeRate', 'ssnitEmployerRate', 'ssnitMaxInsurable'].forEach(k => {
    const n = parseFloat(saved[k]); if (!isNaN(n) && n >= 0) cfg[k] = n;
  });
  if (Array.isArray(saved.payeBands) && saved.payeBands.length) cfg.payeBands = saved.payeBands;
  if (saved.payeBandsLabel) cfg.payeBandsLabel = String(saved.payeBandsLabel);
  if (saved.categories && typeof saved.categories === 'object')
    ['salaries', 'ssnit', 'paye'].forEach(k => { if (saved.categories[k]) cfg.categories[k] = String(saved.categories[k]); });
  return cfg;
}
// Bands: every band but the last has a width; the last is "everything above".
function payrollCleanBands_(bands) {
  if (!Array.isArray(bands) || !bands.length) return { error: 'Add at least one PAYE band.' };
  const out = [];
  for (let i = 0; i < bands.length; i++) {
    const isLast = i === bands.length - 1;
    const rate = parseFloat(bands[i].rate);
    if (isNaN(rate) || rate < 0 || rate > 100) return { error: `Band ${i + 1}: the rate must be between 0 and 100%.` };
    if (isLast) { out.push({ width: null, rate }); break; }
    const width = r2(parseFloat(bands[i].width));
    if (!(width > 0)) return { error: `Band ${i + 1}: enter the amount (GH₵) taxed at ${rate}%.` };
    out.push({ width, rate });
  }
  return { bands: out };
}
function getPayrollSettings(params) {
  clearRequestCache_();
  requireAccess_((params || {}).token, 'payroll');
  return Object.assign(payrollSettings_(), { defaults: PAYROLL_DEFAULTS });
}
function savePayrollSettings(params) {
  clearRequestCache_();
  const { token, settings, resetDefaults } = params || {};
  const user = requireAction_(token, 'payroll.pay');
  if (resetDefaults) {
    setSetting_('PayrollSettings', JSON.stringify(PAYROLL_DEFAULTS));
    appendAudit_('PAYROLL_SETTINGS', 'Reset to Ghana 2026 defaults', user.email);
    return { success: true, settings: payrollSettings_() };
  }
  const s = settings || {};
  const num = (v, label, max) => {
    const n = parseFloat(v);
    if (isNaN(n) || n < 0 || (max !== undefined && n > max)) throw new Error(label);
    return r2(n);
  };
  let clean;
  try {
    const bands = payrollCleanBands_(s.payeBands);
    if (bands.error) return { success: false, message: bands.error };
    const cats = s.categories || {};
    clean = {
      ssnitEnabled: s.ssnitEnabled === true || s.ssnitEnabled === 'true',
      payeEnabled: s.payeEnabled === true || s.payeEnabled === 'true',
      ssnitEmployeeRate: num(s.ssnitEmployeeRate, 'Employee SSNIT rate must be between 0 and 100%.', 100),
      ssnitEmployerRate: num(s.ssnitEmployerRate, 'Employer SSNIT rate must be between 0 and 100%.', 100),
      ssnitMaxInsurable: num(s.ssnitMaxInsurable || 0, 'Maximum insurable salary must be 0 (no cap) or more.'),
      payeBands: bands.bands,
      payeBandsLabel: sanitize_(s.payeBandsLabel || 'Custom PAYE bands').slice(0, 80),
      categories: {
        salaries: sanitize_(cats.salaries || PAYROLL_DEFAULTS.categories.salaries).replace(/,/g, ' ').slice(0, 40),
        ssnit: sanitize_(cats.ssnit || PAYROLL_DEFAULTS.categories.ssnit).replace(/,/g, ' ').slice(0, 40),
        paye: sanitize_(cats.paye || PAYROLL_DEFAULTS.categories.paye).replace(/,/g, ' ').slice(0, 40)
      }
    };
  } catch (e) { return { success: false, message: e.message }; }
  setSetting_('PayrollSettings', JSON.stringify(clean));
  appendAudit_('PAYROLL_SETTINGS', `SSNIT ${clean.ssnitEnabled ? 'on' : 'off'}, PAYE ${clean.payeEnabled ? 'on' : 'off'}`, user.email);
  return { success: true, settings: payrollSettings_() };
}

// ==================== CALCULATION ====================
function payrollPaye_(taxable, bands) {
  let left = Math.max(0, r2(taxable)), tax = 0;
  for (let i = 0; i < bands.length && left > 0; i++) {
    const w = bands[i].width === null || bands[i].width === undefined || i === bands.length - 1 ? left : Math.min(left, bands[i].width);
    tax += w * (parseFloat(bands[i].rate) || 0) / 100;
    left = r2(left - w);
  }
  return r2(tax);
}
// staff: register record; adj: { bonus, extraDeduction, note }; cfg: settings.
function payrollComputeLine_(staff, adj, cfg) {
  adj = adj || {};
  const basic = r2(staff.basicSalary);
  const allowances = payrollItems_(staff.allowances);
  const allowTotal = r2(allowances.reduce((a, x) => a + x.amount, 0));
  const bonus = Math.max(0, r2(adj.bonus));
  const gross = r2(basic + allowTotal + bonus);
  const ssnitOn = !!cfg.ssnitEnabled && staff.ssnitApplies !== false;
  const payeOn = !!cfg.payeEnabled && staff.payeApplies !== false;
  const cap = parseFloat(cfg.ssnitMaxInsurable) || 0;
  const ssnitBase = ssnitOn ? r2(cap > 0 ? Math.min(basic, cap) : basic) : 0;
  const ssnitEmployee = ssnitOn ? r2(ssnitBase * cfg.ssnitEmployeeRate / 100) : 0;
  const ssnitEmployer = ssnitOn ? r2(ssnitBase * cfg.ssnitEmployerRate / 100) : 0;
  const taxable = r2(Math.max(0, gross - ssnitEmployee));
  const paye = payeOn ? payrollPaye_(taxable, cfg.payeBands) : 0;
  const deductions = payrollItems_(staff.deductions);
  const extra = Math.max(0, r2(adj.extraDeduction));
  const other = r2(deductions.reduce((a, x) => a + x.amount, 0) + extra);
  const net = r2(gross - ssnitEmployee - paye - other);
  return {
    staffID: staff.staffID, fullName: staff.fullName, position: staff.position || '', payMethod: staff.payMethod || '',
    accountDetails: staff.accountDetails || '', ssnitNumber: staff.ssnitNumber || '', ghanaCardTIN: staff.ghanaCardTIN || '',
    basic, allowances, allowancesTotal: allowTotal, bonus, gross, ssnitBase, ssnitEmployee, taxable, paye,
    deductions, extraDeduction: extra, otherDeductions: other, netPay: net, ssnitEmployer,
    ssnitApplied: ssnitOn, payeApplied: payeOn, note: sanitize_(adj.note || '').slice(0, 120)
  };
}
// Quick calculator for the staff form (no saving).
function previewPayrollLine(params) {
  clearRequestCache_();
  const { token, staff } = params || {};
  requireAccess_(token, 'payroll');
  const s = payrollStaffFromInput_(staff || {});
  return payrollComputeLine_(s, {}, payrollSettings_());
}

// ==================== STAFF REGISTER ====================
function payrollStaffFromRow_(r) {
  return {
    staffID: payrollText_(r[0]), fullName: payrollText_(r[1]), position: payrollText_(r[2]), phone: payrollText_(r[3]),
    email: payrollText_(r[4]), payMethod: payrollText_(r[5]), accountDetails: payrollText_(r[6]), ssnitNumber: payrollText_(r[7]),
    ghanaCardTIN: payrollText_(r[8]), basicSalary: r2(r[9]), allowances: payrollItems_(payrollJSON_(r[10], [])),
    deductions: payrollItems_(payrollJSON_(r[11], [])), ssnitApplies: payrollYes_(r[12]), payeApplies: payrollYes_(r[13]),
    status: payrollText_(r[14]) || 'Active', startDate: payrollText_(fmtDate_(r[15])), notes: payrollText_(r[16]),
    qualification: payrollText_(r[19])
  };
}
function payrollLoadStaff_() {
  return payrollRows_(payrollStaffSheet_()).filter(r => payrollText_(r[0])).map(payrollStaffFromRow_);
}
function payrollStaffFromInput_(d) {
  return {
    staffID: payrollText_(d.staffID), fullName: sanitize_(d.fullName).replace(/\s+/g, ' ').slice(0, 80),
    position: sanitize_(d.position).slice(0, 60), phone: sanitize_(d.phone).slice(0, 20), email: sanitize_(d.email).slice(0, 80),
    payMethod: PAYROLL_METHODS.indexOf(d.payMethod) >= 0 ? d.payMethod : 'Bank',
    accountDetails: sanitize_(d.accountDetails).slice(0, 120), ssnitNumber: sanitize_(d.ssnitNumber).slice(0, 30),
    ghanaCardTIN: sanitize_(d.ghanaCardTIN).slice(0, 30), basicSalary: r2(parseFloat(d.basicSalary)),
    allowances: payrollItems_(d.allowances), deductions: payrollItems_(d.deductions),
    ssnitApplies: d.ssnitApplies !== false && d.ssnitApplies !== 'false',
    payeApplies: d.payeApplies !== false && d.payeApplies !== 'false',
    status: d.status === 'Inactive' ? 'Inactive' : 'Active',
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(String(d.startDate || '')) ? String(d.startDate) : '',
    notes: sanitize_(d.notes).slice(0, 200),
    qualification: sanitize_(d.qualification).slice(0, 80)
  };
}
function payrollStaffToRow_(s, createdBy, createdDate) {
  return [s.staffID, s.fullName, s.position, textCell_(s.phone), s.email, s.payMethod, textCell_(s.accountDetails), textCell_(s.ssnitNumber), textCell_(s.ghanaCardTIN),
    s.basicSalary, JSON.stringify(s.allowances), JSON.stringify(s.deductions), s.ssnitApplies ? 'Yes' : 'No',
    s.payeApplies ? 'Yes' : 'No', s.status, s.startDate, s.notes, createdBy, createdDate, s.qualification];
}
function getPayrollStaff(params) {
  clearRequestCache_();
  requireAccess_((params || {}).token, 'payroll');
  return payrollLoadStaff_().sort((a, b) => (a.status === b.status ? 0 : a.status === 'Active' ? -1 : 1) || a.fullName.localeCompare(b.fullName));
}
// Adds a staff member (no staffID) or updates one.
function savePayrollStaff(params) {
  clearRequestCache_();
  const { token, staff, idempotencyKey, confirmDuplicate } = params || {};
  const user = requireAccess_(token, 'payroll');
  const s = payrollStaffFromInput_(staff || {});
  if (!s.fullName) return { success: false, message: 'Please enter the staff member\'s full name.' };
  const rawBasic = parseFloat((staff || {}).basicSalary);
  if (isNaN(rawBasic) || rawBasic < 0) return { success: false, message: 'Basic salary must be zero or more.' };
  const bad = [].concat((staff || {}).allowances || [], (staff || {}).deductions || [])
    .find(x => x && (parseFloat(x.amount) < 0 || (sanitize_(x.name) && isNaN(parseFloat(x.amount)))));
  if (bad) return { success: false, message: `"${sanitize_(bad.name) || 'Item'}" needs an amount of zero or more.` };
  if (s.email && !isValidEmail_(s.email)) return { success: false, message: 'The email address is not valid.' };
  const key = idempotencyKey ? 'payStaff_' + String(idempotencyKey) : '';
  return withScriptLock_(30000, () => {
    const cache = CacheService.getScriptCache();
    if (key && !s.staffID) {
      const prev = cache.get(key);
      if (prev) return { success: true, duplicate: true, staffID: prev, message: 'This staff member was already added — the repeated submission was ignored.' };
    }
    const sh = payrollStaffSheet_();
    const rows = payrollRows_(sh);
    const norm = n => String(n || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (s.staffID) {
      const i = rows.findIndex(r => payrollText_(r[0]) === s.staffID);
      if (i < 0) return { success: false, message: 'Staff member not found.' };
      sh.getRange(i + 2, 1, 1, PAYROLL_STAFF_HEADERS.length).setValues(fxRows_([payrollStaffToRow_(s, rows[i][17], fmtDate_(rows[i][18]))]));
      return { success: true, staffID: s.staffID, message: 'Staff details updated.' };
    }
    if (!confirmDuplicate) {
      const twin = rows.find(r => norm(r[1]) === norm(s.fullName));
      if (twin) return { success: false, possibleDuplicate: true,
        message: `${payrollText_(twin[1])} (${payrollText_(twin[0])}${twin[2] ? ', ' + payrollText_(twin[2]) : ''}) is already on the staff list.` };
    }
    s.staffID = 'STF/' + String(incrementSetting_('LastStaffID')).padStart(3, '0');
    appendRows_(sh, [payrollStaffToRow_(s, user.email, todayStr_())]);
    if (key) cache.put(key, s.staffID, 21600);
    return { success: true, staffID: s.staffID, message: `${s.fullName} added (${s.staffID}).` };
  });
}
// Staff who were ever paid keep their record (payslip history); they can only be deactivated.
function deletePayrollStaff(params) {
  clearRequestCache_();
  const { token, staffID } = params || {};
  const user = requireAccess_(token, 'payroll');
  return withScriptLock_(30000, () => {
    const used = payrollRows_(payrollLinesSheet_()).some(r => payrollText_(r[2]) === String(staffID));
    if (used) return { success: false, message: 'This staff member appears on a payroll, so the record is kept for payslip history. Mark them Inactive instead.' };
    const sh = payrollStaffSheet_();
    const rows = payrollRows_(sh);
    const i = rows.findIndex(r => payrollText_(r[0]) === String(staffID));
    if (i < 0) return { success: false, message: 'Staff member not found.' };
    appendAudit_('PAYROLL_DELETE_STAFF', `${rows[i][1]} (${staffID})`, user.email);
    deleteRowSafe_(sh, i + 2);
    return { success: true };
  });
}

// ==================== RUNS ====================
function payrollRunFromRow_(r) {
  return {
    runID: payrollText_(r[0]), month: payrollMonthStr_(r[1]), status: payrollText_(r[2]) || 'Draft', staffCount: parseInt(r[3], 10) || 0,
    totalGross: r2(r[4]), totalSSNITEmployee: r2(r[5]), totalPAYE: r2(r[6]), totalOtherDeductions: r2(r[7]), totalNet: r2(r[8]),
    totalSSNITEmployer: r2(r[9]), totalCost: r2(r[10]), settings: payrollJSON_(r[11], null), excluded: payrollJSON_(r[12], []),
    preparedBy: payrollText_(r[13]), preparedAt: payrollText_(fmtDate_(r[14])), paidDate: payrollText_(fmtDate_(r[15])),
    payMethod: payrollText_(r[16]), reference: payrollText_(r[17]), paidBy: payrollText_(r[18]), paidAt: payrollText_(fmtDate_(r[19])),
    vouchers: payrollText_(r[20]), notes: payrollText_(r[21])
  };
}
function payrollRunToRow_(x) {
  return [x.runID, x.month, x.status, x.staffCount, x.totalGross, x.totalSSNITEmployee, x.totalPAYE, x.totalOtherDeductions,
    x.totalNet, x.totalSSNITEmployer, x.totalCost, JSON.stringify(x.settings || null), JSON.stringify(x.excluded || []),
    x.preparedBy, x.preparedAt, x.paidDate || '', x.payMethod || '', x.reference || '', x.paidBy || '', x.paidAt || '', x.vouchers || '', x.notes || ''];
}
function payrollLineFromRow_(r) {
  return {
    runID: payrollText_(r[0]), month: payrollMonthStr_(r[1]), staffID: payrollText_(r[2]), fullName: payrollText_(r[3]),
    position: payrollText_(r[4]), payMethod: payrollText_(r[5]), accountDetails: payrollText_(r[6]), ssnitNumber: payrollText_(r[7]),
    basic: r2(r[8]), allowances: payrollJSON_(r[9], []), allowancesTotal: r2(r[10]), bonus: r2(r[11]), gross: r2(r[12]),
    ssnitBase: r2(r[13]), ssnitEmployee: r2(r[14]), taxable: r2(r[15]), paye: r2(r[16]), deductions: payrollJSON_(r[17], []),
    extraDeduction: r2(r[18]), otherDeductions: r2(r[19]), netPay: r2(r[20]), ssnitEmployer: r2(r[21]),
    ssnitApplied: payrollYes_(r[22]), payeApplied: payrollYes_(r[23]), note: payrollText_(r[24]), ghanaCardTIN: payrollText_(r[25])
  };
}
function payrollLineToRow_(runID, month, l) {
  return [runID, month, l.staffID, l.fullName, l.position, l.payMethod, textCell_(l.accountDetails), textCell_(l.ssnitNumber), l.basic,
    JSON.stringify(l.allowances), l.allowancesTotal, l.bonus, l.gross, l.ssnitBase, l.ssnitEmployee, l.taxable, l.paye,
    JSON.stringify(l.deductions), l.extraDeduction, l.otherDeductions, l.netPay, l.ssnitEmployer,
    l.ssnitApplied ? 'Yes' : 'No', l.payeApplied ? 'Yes' : 'No', l.note, textCell_(l.ghanaCardTIN)];
}
function payrollFindRun_(month) {
  const sh = payrollRunsSheet_();
  const rows = payrollRows_(sh);
  for (let i = 0; i < rows.length; i++)
    if (payrollMonthStr_(rows[i][1]) === month && payrollText_(rows[i][0])) return { sh, rowNumber: i + 2, run: payrollRunFromRow_(rows[i]) };
  return null;
}
function payrollRunLines_(month) {
  return payrollRows_(payrollLinesSheet_()).filter(r => payrollMonthStr_(r[1]) === month).map(payrollLineFromRow_)
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}
function payrollTotals_(lines) {
  const t = { staffCount: lines.length, totalGross: 0, totalSSNITEmployee: 0, totalPAYE: 0, totalOtherDeductions: 0, totalNet: 0, totalSSNITEmployer: 0 };
  lines.forEach(l => {
    t.totalGross += l.gross; t.totalSSNITEmployee += l.ssnitEmployee; t.totalPAYE += l.paye;
    t.totalOtherDeductions += l.otherDeductions; t.totalNet += l.netPay; t.totalSSNITEmployer += l.ssnitEmployer;
  });
  Object.keys(t).forEach(k => { if (k !== 'staffCount') t[k] = r2(t[k]); });
  t.totalCost = r2(t.totalGross + t.totalSSNITEmployer);
  return t;
}
// Rebuilds a DRAFT month from the current staff register and settings,
// keeping each person's bonus / extra deduction / note for that month.
function payrollRebuildDraft_(month, user, keepAdj) {
  const found = payrollFindRun_(month);
  if (found && found.run.status === 'Paid') throw new Error(`${payrollMonthLabel_(month)} payroll is already paid.`);
  const cfg = payrollSettings_();
  const excluded = found ? (found.run.excluded || []) : [];
  const linesSh = payrollLinesSheet_();
  const allLines = payrollRows_(linesSh);
  const adj = {};
  const oldRows = [];
  allLines.forEach((r, i) => {
    if (payrollMonthStr_(r[1]) !== month) return;
    oldRows.push(i + 2);
    const l = payrollLineFromRow_(r);
    adj[l.staffID] = { bonus: l.bonus, extraDeduction: l.extraDeduction, note: l.note };
  });
  Object.keys(keepAdj || {}).forEach(k => { adj[k] = keepAdj[k]; });
  const staff = payrollLoadStaff_().filter(s => s.status === 'Active' && excluded.indexOf(s.staffID) < 0);
  const lines = staff.map(s => payrollComputeLine_(s, adj[s.staffID], cfg)).sort((a, b) => a.fullName.localeCompare(b.fullName));
  const runID = found ? found.run.runID : 'PR-' + month;
  deleteRowsGrouped_(linesSh, oldRows);
  appendRows_(linesSh, lines.map(l => payrollLineToRow_(runID, month, l)));
  const run = Object.assign(found ? found.run : { runID, month, preparedBy: user.email, excluded: [] },
    payrollTotals_(lines), { status: 'Draft', settings: cfg, excluded, preparedAt: todayStr_() });
  run.preparedBy = user.email;
  if (found) found.sh.getRange(found.rowNumber, 1, 1, PAYROLL_RUN_HEADERS.length).setValues(fxRows_([payrollRunToRow_(run)]));
  else appendRows_(payrollRunsSheet_(), [payrollRunToRow_(run)]);
  return { run, lines };
}
function payrollRunPayload_(run, lines) {
  const staff = payrollLoadStaff_();
  const onRun = new Set(lines.map(l => l.staffID));
  return {
    success: true, run, lines,
    monthLabel: payrollMonthLabel_(run.month),
    negative: lines.filter(l => l.netPay < 0).map(l => l.fullName),
    available: run.status === 'Draft' ? staff.filter(s => s.status === 'Active' && !onRun.has(s.staffID)).map(s => ({ staffID: s.staffID, fullName: s.fullName })) : [],
    school: {
      name: getSetting_('SchoolName') || CONFIG.SCHOOL_NAME, motto: getSetting_('SchoolMotto') || CONFIG.SCHOOL_MOTTO,
      address: getSetting_('SchoolAddress') || CONFIG.SCHOOL_ADDRESS, phone: getSetting_('SchoolPhone') || CONFIG.SCHOOL_PHONE,
      email: getSetting_('SchoolEmail') || CONFIG.SCHOOL_EMAIL, crest: getSetting_('SchoolCrest') || ''
    }
  };
}
function getPayrollRuns(params) {
  clearRequestCache_();
  requireAccess_((params || {}).token, 'payroll');
  return payrollRows_(payrollRunsSheet_()).filter(r => payrollText_(r[0])).map(payrollRunFromRow_)
    .map(r => { delete r.settings; r.monthLabel = payrollMonthLabel_(r.month); return r; })
    .sort((a, b) => b.month.localeCompare(a.month));
}
function getPayrollRun(params) {
  clearRequestCache_();
  const { token, month } = params || {};
  requireAccess_(token, 'payroll');
  if (!payrollValidMonth_(month)) return { success: false, message: 'Choose a month.' };
  const found = payrollFindRun_(month);
  if (!found) return { success: true, run: null, monthLabel: payrollMonthLabel_(month) };
  return payrollRunPayload_(found.run, payrollRunLines_(month));
}
function preparePayrollRun(params) {
  clearRequestCache_();
  const { token, month } = params || {};
  const user = requireAccess_(token, 'payroll');
  if (!payrollValidMonth_(month)) return { success: false, message: 'Choose a valid month.' };
  const now = todayStr_().slice(0, 7);
  const [y, m] = now.split('-').map(Number);
  const next = m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0');
  if (month > next) return { success: false, message: 'Payroll can be prepared up to next month only.' };
  return withScriptLock_(30000, () => {
    const found = payrollFindRun_(month);
    if (found && found.run.status === 'Paid') return Object.assign(payrollRunPayload_(found.run, payrollRunLines_(month)), { alreadyPaid: true });
    if (!payrollLoadStaff_().some(s => s.status === 'Active')) return { success: false, message: 'Add your staff first (Staff tab).' };
    const res = payrollRebuildDraft_(month, user);
    return Object.assign(payrollRunPayload_(res.run, res.lines), { message: found ? 'Payroll recalculated from the latest staff details.' : 'Draft payroll prepared.' });
  });
}
// Per-month changes on a DRAFT: bonus, extra deduction, note, or leave someone out / bring them back.
function updatePayrollLine(params) {
  clearRequestCache_();
  const { token, month, staffID, bonus, extraDeduction, note, exclude, include } = params || {};
  const user = requireAccess_(token, 'payroll');
  if (!payrollValidMonth_(month)) return { success: false, message: 'Choose a month.' };
  const b = bonus === undefined || bonus === '' ? 0 : parseFloat(bonus);
  const x = extraDeduction === undefined || extraDeduction === '' ? 0 : parseFloat(extraDeduction);
  if (isNaN(b) || b < 0 || isNaN(x) || x < 0) return { success: false, message: 'Bonus and deductions must be zero or more.' };
  return withScriptLock_(30000, () => {
    const found = payrollFindRun_(month);
    if (!found) return { success: false, message: 'Prepare this month\'s payroll first.' };
    if (found.run.status === 'Paid') return { success: false, message: 'This payroll is already paid. Reverse it first to make changes.' };
    const ex = (found.run.excluded || []).slice();
    const keep = {};
    if (exclude) { if (ex.indexOf(staffID) < 0) ex.push(staffID); }
    else if (include) { const i = ex.indexOf(staffID); if (i >= 0) ex.splice(i, 1); }
    else keep[staffID] = { bonus: b, extraDeduction: x, note: note || '' };
    if (exclude || include) {
      found.run.excluded = ex;
      found.sh.getRange(found.rowNumber, 1, 1, PAYROLL_RUN_HEADERS.length).setValues(fxRows_([payrollRunToRow_(found.run)]));
    }
    const res = payrollRebuildDraft_(month, user, keep);
    return payrollRunPayload_(res.run, res.lines);
  });
}
function deletePayrollRun(params) {
  clearRequestCache_();
  const { token, month } = params || {};
  const user = requireAccess_(token, 'payroll');
  return withScriptLock_(30000, () => {
    const found = payrollFindRun_(month);
    if (!found) return { success: false, message: 'No payroll for that month.' };
    if (found.run.status === 'Paid') return { success: false, message: 'A paid payroll cannot be deleted. Reverse it first.' };
    const linesSh = payrollLinesSheet_();
    const rows = [];
    payrollRows_(linesSh).forEach((r, i) => { if (payrollMonthStr_(r[1]) === month) rows.push(i + 2); });
    deleteRowsGrouped_(linesSh, rows);
    deleteRowSafe_(found.sh, found.rowNumber);
    appendAudit_('PAYROLL_DELETE_DRAFT', payrollMonthLabel_(month), user.email);
    return { success: true };
  });
}

// ==================== PAY → EXPENSES ====================
function payrollExpenseKeys_(month) {
  return { net: PAYROLL_KEY_PREFIX + month + '|NET', ssnit: PAYROLL_KEY_PREFIX + month + '|SSNIT', paye: PAYROLL_KEY_PREFIX + month + '|PAYE' };
}
function isPayrollExpenseKey_(key) { return String(key || '').indexOf(PAYROLL_KEY_PREFIX) === 0; }
// expectedNet / expectedCount: what the person approving saw. If staff details
// changed since, the draft is refreshed and the payment is NOT made, so
// nobody approves one figure and pays another.
function payPayrollRun(params) {
  clearRequestCache_();
  const { token, month, paymentDate, payMethod, reference, expectedNet, expectedCount } = params || {};
  const user = requireAction_(token, 'payroll.pay');
  syncConfig_();
  if (!payrollValidMonth_(month)) return { success: false, message: 'Choose a month.' };
  const date = String(paymentDate || todayStr_()).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { success: false, message: 'Enter the payment date.' };
  if (date > todayStr_()) return { success: false, message: 'The payment date cannot be in the future.' };
  const method = PAYROLL_METHODS.indexOf(payMethod) >= 0 ? payMethod : 'Bank';
  return withScriptLock_(60000, () => {
    const found = payrollFindRun_(month);
    if (!found) return { success: false, message: 'Prepare this month\'s payroll first.' };
    if (found.run.status === 'Paid')
      return Object.assign(payrollRunPayload_(found.run, payrollRunLines_(month)), { duplicate: true, message: `${payrollMonthLabel_(month)} payroll was already paid — nothing was posted twice.` });
    const fresh = payrollRebuildDraft_(month, user);
    if (!fresh.lines.length) return { success: false, message: 'There is nobody on this payroll.' };
    if ((expectedNet !== undefined && Math.abs(r2(expectedNet) - fresh.run.totalNet) > 0.004) ||
        (expectedCount !== undefined && parseInt(expectedCount, 10) !== fresh.run.staffCount))
      return Object.assign(payrollRunPayload_(fresh.run, fresh.lines), { success: false, changed: true,
        message: 'Staff details or payroll settings changed since this page was loaded. The figures have been updated — please check them and approve again.' });
    const neg = fresh.lines.filter(l => l.netPay < 0);
    if (neg.length) return { success: false, message: `Net pay is below zero for ${neg.map(l => l.fullName).join(', ')}. Reduce their deductions first.` };
    const t = fresh.run, cfg = t.settings, label = payrollMonthLabel_(month), keys = payrollExpenseKeys_(month);
    ensureExpensesTermColumns_();
    const sh = getSpreadsheet_().getSheetByName('Expenses');
    const existing = new Set(payrollRows_(sh).map(r => String(r[11] || '')));
    const posts = [
      { key: keys.net, cat: cfg.categories.salaries, amt: r2(t.totalNet + t.totalOtherDeductions),
        desc: `Salaries — ${label} (${t.staffCount} staff)`,
        notes: `Net pay ${r2(t.totalNet).toFixed(2)}` + (t.totalOtherDeductions > 0 ? ` + other deductions ${t.totalOtherDeductions.toFixed(2)}` : '') + ` · gross ${t.totalGross.toFixed(2)}` },
      { key: keys.ssnit, cat: cfg.categories.ssnit, amt: r2(t.totalSSNITEmployee + t.totalSSNITEmployer),
        desc: `SSNIT contributions — ${label}`,
        notes: `Employee ${t.totalSSNITEmployee.toFixed(2)} + employer ${t.totalSSNITEmployer.toFixed(2)}` },
      { key: keys.paye, cat: cfg.categories.paye, amt: r2(t.totalPAYE), desc: `PAYE tax — ${label}`, notes: 'PAYE withheld from staff salaries (due to GRA)' }
    ].filter(p => p.amt > 0);
    const nowMs = Date.now(), vouchers = [], rows = [];
    posts.forEach((p, i) => {
      if (existing.has(p.key)) return;
      const vn = getNextVoucherNumber_();
      vouchers.push(vn);
      rows.push(['PRX' + nowMs + '_' + i, date, p.desc, p.cat, p.amt, `Payroll (${method})`, vn, user.email,
        p.notes + (reference ? ` · ref ${sanitize_(reference)}` : ''), CONFIG.CURRENT_TERM, CONFIG.CURRENT_ACADEMIC_YEAR, p.key]);
    });
    appendRows_(sh, rows);
    // Payroll categories appear in the Expenses category list too.
    const cats = String(getSetting_('ExpenseCategories') || '').split(',').map(c => c.trim()).filter(Boolean);
    const add = [cfg.categories.salaries, cfg.categories.ssnit, cfg.categories.paye].filter(c => cats.indexOf(c) < 0);
    if (cats.length && add.length) setSetting_('ExpenseCategories', cats.concat(add).join(','));
    const run = Object.assign(t, { status: 'Paid', paidDate: date, payMethod: method, reference: sanitize_(reference).slice(0, 60),
      paidBy: user.email, paidAt: new Date().toISOString(), vouchers: vouchers.join(', ') });
    found.sh.getRange(found.rowNumber, 1, 1, PAYROLL_RUN_HEADERS.length).setValues(fxRows_([payrollRunToRow_(run)]));
    appendAudit_('PAYROLL_PAID', `${label}: ${t.staffCount} staff, net ${t.totalNet.toFixed(2)}, total cost ${t.totalCost.toFixed(2)} (${vouchers.join(', ')})`, user.email);
    return Object.assign(payrollRunPayload_(run, fresh.lines), { message: `${label} payroll paid and posted to Expenses (${vouchers.join(', ') || 'no amounts'}).` });
  });
}
// Removes the payroll's expense rows and reopens the month as a draft.
function reversePayrollRun(params) {
  clearRequestCache_();
  const { token, month, reason } = params || {};
  const user = requireAction_(token, 'payroll.pay');
  const why = sanitize_(reason);
  if (!why) return { success: false, message: 'Please give a reason for reversing.' };
  return withScriptLock_(60000, () => {
    const found = payrollFindRun_(month);
    if (!found) return { success: false, message: 'No payroll for that month.' };
    if (found.run.status !== 'Paid') return { success: false, message: 'This payroll is not paid.' };
    const sh = getSpreadsheet_().getSheetByName('Expenses');
    const prefix = PAYROLL_KEY_PREFIX + month + '|';
    const del = [];
    let amount = 0;
    if (sh) payrollRows_(sh).forEach((r, i) => { if (String(r[11] || '').indexOf(prefix) === 0) { del.push(i + 2); amount += parseFloat(r[4]) || 0; } });
    deleteRowsGrouped_(sh, del);
    const run = Object.assign(found.run, { status: 'Draft', paidDate: '', payMethod: '', reference: '', paidBy: '', paidAt: '', vouchers: '',
      notes: `Reversed ${todayStr_()} by ${user.email}: ${why}`.slice(0, 300) });
    found.sh.getRange(found.rowNumber, 1, 1, PAYROLL_RUN_HEADERS.length).setValues(fxRows_([payrollRunToRow_(run)]));
    appendAudit_('PAYROLL_REVERSED', `${payrollMonthLabel_(month)}: removed ${del.length} expense rows (GH₵${r2(amount).toFixed(2)}). Reason: ${why}`, user.email);
    return Object.assign(payrollRunPayload_(run, payrollRunLines_(month)), { message: `Payroll reversed: ${del.length} expense entr${del.length === 1 ? 'y' : 'ies'} removed. The month is a draft again.` });
  });
}

// ==================== REPORTS ====================
// Year-to-date totals per staff member (for SSNIT / GRA annual returns).
function getPayrollYearSummary(params) {
  clearRequestCache_();
  const { token, year } = params || {};
  requireAccess_(token, 'payroll');
  const y = String(year || todayStr_().slice(0, 4));
  const paid = new Set(payrollRows_(payrollRunsSheet_()).map(payrollRunFromRow_).filter(r => r.status === 'Paid' && r.month.indexOf(y + '-') === 0).map(r => r.month));
  const by = {};
  payrollRows_(payrollLinesSheet_()).map(payrollLineFromRow_).filter(l => paid.has(l.month)).forEach(l => {
    const o = by[l.staffID] || (by[l.staffID] = { staffID: l.staffID, fullName: l.fullName, ssnitNumber: l.ssnitNumber, ghanaCardTIN: l.ghanaCardTIN,
      months: 0, gross: 0, ssnitEmployee: 0, ssnitEmployer: 0, paye: 0, otherDeductions: 0, netPay: 0 });
    o.fullName = l.fullName; o.months++;
    ['gross', 'ssnitEmployee', 'ssnitEmployer', 'paye', 'otherDeductions', 'netPay'].forEach(k => { o[k] = r2(o[k] + l[k]); });
  });
  const rows = Object.keys(by).map(k => by[k]).sort((a, b) => a.fullName.localeCompare(b.fullName));
  const totals = {};
  ['gross', 'ssnitEmployee', 'ssnitEmployer', 'paye', 'otherDeductions', 'netPay'].forEach(k => { totals[k] = r2(rows.reduce((a, x) => a + x[k], 0)); });
  return { year: y, monthsPaid: Array.from(paid).sort(), rows, totals };
}