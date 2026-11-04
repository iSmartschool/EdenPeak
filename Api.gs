// ========================================================================
// iSmartSchool – JSON API for the GitHub Pages frontend (Google Apps Script)
// ------------------------------------------------------------------------
// Add this as a SEPARATE script file named Api.gs next to Code.gs,
// CanteenModule.gs and PayrollModule.gs. Nothing else needs to change in
// those files (CanteenModule.gs has one small optional update — see README).
//
// The app hosted on GitHub Pages sends:
//     POST <web app URL>     body: {"fn":"getClasses","params":{...},"v":1}
// and gets back:
//     {"ok":true,"result":...}            or
//     {"ok":false,"error":"Session expired","code":"ERROR"}
//
// Only the functions listed in API_FUNCTIONS can be called — the same ones
// the app already used through google.script.run. Helpers (names ending
// in "_"), doGet/doPost and the editor-only recovery tools
// (diagnoseLogin, resetUserPassword) can never be reached from the web.
// Every function still checks the caller's session token itself, exactly
// as before.
//
// DEPLOY: Deploy → New deployment → Web app
//         Execute as: Me      Who has access: Anyone
//         Copy the Web app URL (ends in /exec) into the frontend config.
//         After changing any .gs file: Deploy → Manage deployments → ✏️ →
//         Version: New version → Deploy (the URL stays the same).
// ========================================================================
const API_VERSION = 1;
const API_FUNCTIONS = Object.freeze([
  // session & users
  'apiPing', 'getPublicConfig', 'needsFirstTimeSetup', 'registerFirstAdmin', 'loginUser', 'logoutUser', 'validateSession',
  'changePassword', 'getAllUsers', 'addUser', 'updateUser', 'removeUser', 'setUserStatus',
  'getRolePermissions', 'getRoleNames', 'saveRole', 'deleteRole', 'createDatabaseSchema',
  // school settings
  'getSchoolConfig', 'updateSchoolConfig', 'getSchoolName', 'getSchoolCrest', 'uploadSchoolCrest',
  'getScoreWeights', 'updateScoreWeights', 'getDashboardStats',
  // classes, subjects, fee items
  'getClasses', 'addClass', 'updateClass', 'moveClass', 'deleteClass',
  'getSubjects', 'addSubject', 'updateSubject', 'deleteSubject', 'getGESSubjects',
  'getFeeItems', 'addFeeItem', 'updateFeeItem', 'deleteFeeItem', 'copyFeeItemsToNewTerm',
  // students
  'getAllStudents', 'searchStudents', 'getStudentById', 'getAllStudentsIncludingInactive', 'addStudent', 'updateStudent',
  'deactivateStudent', 'reactivateStudent', 'deleteStudent', 'bulkDeleteStudents', 'bulkUploadStudents', 'uploadStudentPhoto',
  // fees & finance
  'getAllFeeOverview', 'getClassFeeOverview', 'getStudentFeeSummary', 'saveStudentFeeOverrides', 'recordFeePayment',
  'getPrintableReceipt', 'getStudentPaymentHistory', 'reverseFeePayment', 'getFinancialSummary', 'getFinancialReport',
  'getIncomeExpenditureStatement',
  // expenses
  'getExpenses', 'recordExpense', 'updateExpense', 'deleteExpense', 'getExpenseCategories', 'saveExpenseCategories',
  // results, conduct, report cards, promotion
  'recordSubjectScoreBatch', 'getStudentResults', 'getClassBroadsheet', 'getClassResultsTemplate', 'uploadClassResults',
  'getConductOptions', 'getStudentConduct', 'saveStudentConduct', 'generateReportCard', 'generateReportCardsBatch',
  'getPromotionDecision', 'savePromotionDecision', 'promoteAllClasses', 'processRollover',
  // attendance
  'getAttendanceForDate', 'markAttendanceBatch',
  // data maintenance
  'getDataHealth', 'compactSheets', 'archiveClosedTerms', 'getArchiveStatus',
  // canteen (CanteenModule.gs)
  'getCanteenSettings', 'saveCanteenSettings', 'getCanteenBalances', 'getCanteenRegister', 'saveCanteenRegister',
  'recordCanteenPayment', 'getCanteenStudentAccount', 'getCanteenReceipt', 'voidCanteenTransaction',
  'getCanteenExpenses', 'recordCanteenExpense', 'updateCanteenExpense', 'deleteCanteenExpense', 'saveCanteenExpenseCategories',
  'getCanteenReport',
  // payroll (PayrollModule.gs)
  'getPayrollSettings', 'savePayrollSettings', 'previewPayrollLine', 'getPayrollStaff', 'savePayrollStaff', 'deletePayrollStaff',
  'getPayrollRuns', 'getPayrollRun', 'preparePayrollRun', 'updatePayrollLine', 'deletePayrollRun', 'payPayrollRun',
  'reversePayrollRun', 'getPayrollYearSummary'
]);
const API_ALLOWED_ = (function () { const m = {}; API_FUNCTIONS.forEach(n => { m[n] = true; }); return m; })();
const API_GLOBAL_ = (typeof globalThis !== 'undefined') ? globalThis : this;   // top-level functions of all .gs files

// Connectivity check used by the app ("are we online?"). Touches nothing.
function apiPing() {
  return { ok: true, service: 'iSmartSchool', api: API_VERSION, time: new Date().toISOString() };
}

function apiJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '');
  } catch (err) {
    return apiJson_({ ok: false, code: 'BAD_REQUEST', error: 'The request could not be read.' });
  }
  const fn = String((req && req.fn) || '');
  if (!Object.prototype.hasOwnProperty.call(API_ALLOWED_, fn) || typeof API_GLOBAL_[fn] !== 'function') {
    return apiJson_({ ok: false, code: 'UNKNOWN_FUNCTION', error: 'Unknown action: ' + fn.slice(0, 60) +
      '. If the app was just updated, publish a new version of the Apps Script deployment.' });
  }
  const params = req.params && typeof req.params === 'object' && !Array.isArray(req.params) ? req.params : {};
  try {
    const result = API_GLOBAL_[fn](params);
    // Round-trip through JSON so Dates become ISO strings exactly as
    // google.script.run would have delivered them.
    return apiJson_({ ok: true, api: API_VERSION, result: result === undefined ? null : result });
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    // Expected refusals (session, permission, busy) are not logged as faults.
    if (!/Session expired|Not authenticated|Permission denied|system is busy/i.test(msg)) console.error('API ' + fn + ' failed: ' + (err && err.stack ? err.stack : msg));
    return apiJson_({ ok: false, code: 'ERROR', error: msg });
  }
}
