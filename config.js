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
  prefetchEveryMinutes: 10
};
