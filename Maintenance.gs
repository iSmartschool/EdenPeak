// ========================================================================
// iSmartSchool – Weekly automatic Compact (Google Apps Script)
// ------------------------------------------------------------------------
// Add this as a SEPARATE script file named Maintenance.gs next to Code.gs.
//
// Every Sunday at about 2 a.m. (the spreadsheet's time zone) it does the
// same as Settings → Data → "Compact sheets": removes empty columns to the
// right of the data and empty rows below it (keeping 50 spare rows), on
// the app's own sheets only. It never touches a cell that holds data.
//
// SWITCH ON (once): in the editor toolbar choose  setupWeeklyCompact  and
//   click Run. Approve the permission request ("run when you are not
//   present"). Check: the clock icon (Triggers) on the left lists it.
// SWITCH OFF: choose  removeWeeklyCompact  and click Run.
// TRY IT NOW: choose  runCompactNow  and click Run, then see View → Logs.
//
// None of these can be called from the web app: they are not in Api.gs's
// list, and each one checks that it is running from the editor (as the
// script owner) or from its own scheduled trigger.
// ========================================================================
const AUTO_COMPACT_HANDLER = 'autoCompactSheets';
const AUTO_COMPACT_SPARE_ROWS = 50;

// Called by the weekly trigger.
function autoCompactSheets(e) {
  if (!(e && e.triggerUid) && !isScriptOwnerRunning_()) throw new Error('This runs from its weekly schedule or the Apps Script editor only.');
  const lock = LockService.getScriptLock();
  // If staff are saving something at that moment, wait up to 2 minutes;
  // if the system stays busy, skip this week rather than get in the way.
  if (!lock.tryLock(120000)) { console.warn('Weekly compact skipped: the system was busy.'); return; }
  _lockDepth = 1;       // lets helpers in Code.gs see that the lock is held
  try {
    clearRequestCache_();
    const freed = autoCompactAppSheets_();
    appendAudit_('COMPACT_AUTO', `Weekly automatic compact freed ${freed} empty cells`, 'Scheduled task');
    console.log('Weekly compact freed ' + freed + ' empty cells.');
    return freed;
  } catch (err) {
    console.error('Weekly compact failed: ' + (err && err.stack ? err.stack : err));
    throw err;           // shows as "Failed" in Executions so the owner is emailed
  } finally {
    _lockDepth = 0;
    lock.releaseLock();
  }
}

// Same rules as compactSheets() in Code.gs.
function autoCompactAppSheets_() {
  const ss = getSpreadsheet_();
  let freed = 0;
  APP_SHEETS.forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    const before = sh.getMaxRows() * sh.getMaxColumns();
    trimColumns_(sh, Math.max(1, sh.getLastColumn()));
    const keepRows = Math.max(sh.getLastRow(), sh.getFrozenRows() + 1, 2) + AUTO_COMPACT_SPARE_ROWS;
    if (sh.getMaxRows() > keepRows) sh.deleteRows(keepRows + 1, sh.getMaxRows() - keepRows);
    freed += before - sh.getMaxRows() * sh.getMaxColumns();
  });
  return freed;
}

// Run once from the editor to switch the weekly schedule on.
function setupWeeklyCompact() {
  if (!isScriptOwnerRunning_()) throw new Error('Run this from the Apps Script editor as the script owner.');
  removeCompactTriggers_();
  ScriptApp.newTrigger(AUTO_COMPACT_HANDLER).timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(2).inTimezone(getTz_()).create();
  Logger.log('✅ Weekly compact switched on: every Sunday at about 2 a.m. (' + getTz_() + ').');
}

// Run from the editor to switch it off.
function removeWeeklyCompact() {
  if (!isScriptOwnerRunning_()) throw new Error('Run this from the Apps Script editor as the script owner.');
  const n = removeCompactTriggers_();
  Logger.log(n ? '✅ Weekly compact switched off.' : 'The weekly compact was not switched on.');
}

// Run from the editor to compact right away (same as the weekly run).
function runCompactNow() {
  if (!isScriptOwnerRunning_()) throw new Error('Run this from the Apps Script editor as the script owner.');
  autoCompactSheets();
}

function removeCompactTriggers_() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === AUTO_COMPACT_HANDLER) { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}