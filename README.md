# iSmartSchool — GitHub Pages frontend with offline support

The iSmartSchool app, hosted on **GitHub Pages** and talking to your existing
**Google Apps Script** backend (the Google Sheet stays the database). It can be
installed like an app on phones and computers and **keeps working without
internet**: screens open from the last saved copy, and everyday records made
offline are sent automatically when the connection returns.

```
.
├── site/                      ← the app (published to GitHub Pages)
│   ├── index.html
│   ├── config.js              ← Apps Script URL (or set it as a repo variable)
│   ├── manifest.webmanifest   ← makes it installable
│   ├── sw.js                  ← service worker: keeps the app on the device
│   └── assets/
│       ├── css/app.css, offline.css
│       ├── js/api.js          ← server calls, offline copy, outbox, sync
│       ├── js/app.js          ← all screens (your existing app)
│       ├── js/sync-ui.js      ← status pill, banner, Sync Center
│       ├── js/pwa.js          ← install button, "Update now"
│       ├── icons/  vendor/exceljs.min.js
├── apps-script/
│   ├── Api.gs                 ← NEW: JSON API for the Pages app
│   └── CanteenModule.gs       ← updated (offline payments keep their date)
├── scripts/build.mjs          ← build: stamps versions, checks files
└── .github/workflows/deploy-pages.yml
```

---

## Setup (about 15 minutes, once)

### 1. Apps Script backend

1. Open your Apps Script project (Extensions → Apps Script from the Sheet).
2. **Add** a script file named `Api.gs` and paste `apps-script/Api.gs` into it.
3. **Replace** the contents of `CanteenModule.gs` with `apps-script/CanteenModule.gs`.
   (Only `recordCanteenPayment` changed: it accepts the date a payment was
   taken, so offline payments synced the next day keep the right date.)
   `Code.gs` and `PayrollModule.gs` do **not** change.
4. **Deploy → Manage deployments** → edit (✏️) your existing web-app deployment
   → **Version: New version** → **Deploy**.
   If you have no deployment yet: **Deploy → New deployment → Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy the **Web app URL** — it ends in `/exec`.

> "Anyone" is required so the browser can reach the API without a Google
> sign-in. It is the same setting the app already used: every function still
> checks the user's own iSmartSchool session, and only the functions the app
> uses are reachable (see `API_FUNCTIONS` in `Api.gs`). Editor-only tools such
> as `resetUserPassword` are never exposed.

### 2. GitHub repository

1. Create a repository (private is fine on paid plans; public on free plans)
   and push this folder to the `main` branch.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Settings → Secrets and variables → Actions → Variables → New repository
   variable**: name `APPS_SCRIPT_URL`, value = the `/exec` URL from step 1.5.
   (Alternatively type it into `site/config.js` and commit.)
4. **Actions → Deploy to GitHub Pages → Run workflow** (later pushes to `main`
   deploy automatically).
5. Your app is at `https://<user>.github.io/<repository>/`. Open it, sign in
   with your existing account — users, roles and data are unchanged.

The old Apps Script link keeps working; retire it whenever you like.

---

## How offline works (for staff)

| When offline you can… | |
|---|---|
| **Open the app** | From its icon or bookmark, if you ticked **Keep me signed in on this device** when you last signed in. |
| **See screens** | Any screen opened on this device while online (dashboard, students, classes, today's attendance and canteen register, fee overview, expenses, payroll staff… are refreshed automatically in the background). The banner shows when the copy was saved. |
| **Record & save** | Attendance · canteen register · canteen payments & expenses · fee payments · expenses · scores · conduct. They wait in the **outbox** and are sent automatically, in order, when the connection returns. |
| **Not offline** | Signing in for the first time, adding/deleting students, rollover, promotion, user & role admin, reversals, payroll approval, settings. The app says so clearly instead of failing silently. |

- The **status pill** (top right / top bar) shows *Online*, *Offline*,
  *N to send* or *N to review*. Tap it for the **Sync Center**: what is
  waiting, what the server did not accept (with the reason, **Retry** or
  **Remove**), what was recently sent, and storage on this device.
- **Nothing is ever charged twice.** Each payment/expense carries a unique
  key and attendance/register/scores overwrite rather than add, so a
  change sent twice (e.g. a dropped connection) is recorded once.
- Changes belong to the person who made them and are only sent with that
  person's session. If the session expired, they wait until that person signs
  in again on that device.
- A receipt number is issued when an offline payment reaches the server; print
  the receipt afterwards from Payment History / the canteen account.
- **Logging out** removes that user's saved screens from the device; unsent
  changes are kept (the app warns first).
- On a **shared computer**, do not tick *Keep me signed in*.

### Updates

Pushing to `main` publishes a new version. Open apps show **"A new version is
ready — Update now"** instead of switching code under someone mid-task;
unsent offline changes are kept across updates. Every build gets a content
hash, so devices never mix old and new files.

After changing any `.gs` file, publish a **new version** of the existing
deployment (step 1.4) — the URL stays the same.

---

## Technical notes

- **Transport:** `POST <exec URL>` with body `{"fn","params","v"}` as
  `text/plain` (a "simple" request — Apps Script cannot answer CORS
  pre-flights). Replies are `{"ok":true,"result":…}` or
  `{"ok":false,"error":…}`; errors reach the screens exactly as
  `google.script.run` failures did before.
- **Offline data:** IndexedDB (`iss-offline`): `cache` (per-user saved
  answers, removed after `offlineCacheDays`, default 30), `outbox`, `meta`.
  Saved answers are refreshed on every successful online read and in the
  background every `prefetchEveryMinutes` (default 10; skipped on Data Saver).
- **Ordering:** before any online change, older outbox items are sent first,
  so a newer change can never be overwritten by an older one. Only one tab
  sends at a time (Web Locks); tabs share outbox state (BroadcastChannel).
- **Service worker** caches only the app's own files. API traffic is never
  cached by the service worker. Background Sync (Chrome/Edge/Android) nudges
  open windows to send; every browser also sends on reconnect, on returning
  to the tab, and every minute while changes are waiting.
- **Security:** strict Content-Security-Policy (no inline or third-party
  scripts; ExcelJS is served from this site); the session token — never the
  password — is kept in `sessionStorage`, or `localStorage` only when *Keep me
  signed in* is ticked. GitHub Pages cannot send custom HTTP headers, so
  framing protection (`frame-ancestors`) is not available there; put a CDN
  such as Cloudflare in front of a custom domain if you need it.
- **Sessions** last `TOKEN_EXPIRY_HOURS` (24 h in `Code.gs`). A device opened
  offline uses the saved profile and re-checks it with the server as soon as
  it is back online.

### Known limits

- Scores entered offline are saved into whatever term is current **when they
  sync** — sync before running the term rollover (the outbox count is on the
  status pill).
- Fee overview and balances shown offline do not include payments still in
  the outbox (the outbox and its count are shown instead).

### Test locally

```bash
node scripts/build.mjs                  # → _site/
cd _site && python3 -m http.server 8080 # open http://localhost:8080
```
`localhost` counts as a secure origin, so the service worker and install
work. The browser DevTools → Network → *Offline* switch simulates no internet.

### Troubleshooting

| Symptom | Fix |
|---|---|
| Pill says **No server** while internet works | Wrong URL in `APPS_SCRIPT_URL`/`config.js`, deployment access not **Anyone**, or `Api.gs` not deployed (publish a new version). |
| "Unknown action: …" | The backend is older than the app: publish a new deployment version. |
| "This app isn't connected to its server yet" | No URL configured — see setup step 2.3. |
| Offline the app shows the sign-in page | *Keep me signed in* was not ticked at the last sign-in (by design for shared devices). |
