/* ------------------------------------------------------------------------
 * iSmartSchool – deployment settings
 *
 * apiUrl: the "Web app" URL of your Apps Script deployment (ends in /exec).
 *         Apps Script → Deploy → Manage deployments → copy "Web app URL".
 *
 * You can either type it here, or leave it empty and set the repository
 * variable APPS_SCRIPT_URL (Settings → Secrets and variables → Actions →
 * Variables). The GitHub Actions build writes it into this file.
 * ------------------------------------------------------------------------ */
window.ISS_CONFIG = {
  apiUrl: '',

  // Screens saved for offline use are kept this many days, then removed.
  offlineCacheDays: 30,

  // How often (minutes) the app refreshes its offline copy of everyday
  // screens while online. 0 turns automatic refreshing off.
  prefetchEveryMinutes: 10,

  // Most saved screens kept on a device (oldest removed first). A school with
  // many students saves one answer per student and screen; this stops it
  // growing without limit.
  maxSavedScreens: 600,

  // Payroll screens (salaries, bank details) are not kept on devices. Set to true only if every
  // device that opens the app is private to the person using it.
  cachePayroll: false,

  // On a slow connection, after this many seconds a screen shows the copy saved on this
  // device while the live answer keeps loading (it is saved for next time). 0 = always wait.
  slowNetworkSeconds: 8,

  // Shared computers: a session WITHOUT "Keep me signed in" is signed out after this many
  // minutes with no activity (minimum 5). 0 turns it off. Devices that keep the sign-in are
  // never signed out this way, so they still open offline.
  idleLockMinutes: 30,

  // Leave false. true lets other websites show this app inside a frame (only needed if you
  // embed it on purpose, e.g. in Google Sites).
  allowFraming: false
};
