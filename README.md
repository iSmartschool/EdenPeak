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
│       ├── js/frame-guard.js  ← refuses to run inside another site's frame
│       ├── icons/  vendor/exceljs.min.js
├── apps-script/               ← the Apps Script backend (copy into the Apps Script editor)
│   ├── Code.gs  CanteenModule.gs  PayrollModule.gs  Api.gs  Maintenance.gs
├── scripts/build.mjs          ← build: stamps versions, checks files
├── scripts/make-gas-index.mjs ← builds the Apps Script Index.html from the files above
└── .github/workflows/deploy-pages.yml
```

---

## Setup (about 15 minutes, once)

### 1. Apps Script backend

1. Open your Apps Script project (Extensions → Apps Script from the Sheet).
2. For each file in `apps-script/` (`Code.gs`, `CanteenModule.gs`, `PayrollModule.gs`, `Api.gs`,
   `Maintenance.gs`): open the file of the same name in the Apps Script editor (add it if it is
   missing) and **replace its whole contents**. The repository is the master copy of the backend.
3. Paste the generated `Index.html` (see *Apps Script page generated* below) into the Apps Script
   `Index.html` file.
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
| **Record & save** | Attendance · canteen register · canteen payments & expenses · fee payments · expenses · scores · conduct. They wait in the **outbox** and are sent automatically, in order, when the connection returns. Canteen payments can be taken for **any** student (the account is worked out from the saved balance list). |
| **See correct balances** | Fee and canteen balances on screen already include payments still waiting in the outbox, marked *waiting to send*, so nobody is asked to pay twice. |
| **Slow connection** | A screen that takes more than `slowNetworkSeconds` (8) shows the copy saved on this device straight away; the live answer keeps loading and is saved for next time. Right after you save something, screens always wait for the live answer. |
| **Not offline** | Signing in for the first time, adding/deleting students, rollover, promotion, user & role admin, reversals (fees and canteen), payroll approval, settings. The app says so clearly instead of failing silently. |

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
- **Sessions** end after `TOKEN_EXPIRY_HOURS` (24 h) without use, or
  `REMEMBER_EXPIRY_HOURS` (7 days) on a device where *Keep me signed in* was
  ticked, so a phone used offline over a weekend can still send its changes on
  Monday. A session in use renews itself, but every session ends
  `SESSION_MAX_DAYS` (30) after sign-in. A device opened offline uses the saved
  profile and re-checks it with the server as soon as it is back online.

### Security & maintenance notes (audit update)

- **Sessions:** the Settings sheet now stores only a SHA-256 of each session token, so
  anyone who can open the spreadsheet cannot sign in as somebody else. **After you publish
  this version everyone signs in once more** (old sessions are no longer recognised).
- Changing or resetting a password, deactivating or deleting a user signs that person out
  on every device (the device you change it from stays signed in).
- New passwords must be **8+ characters**; existing passwords keep working.
- `Settings → StudentIdPrefix` (add a row if missing) sets the letters in student IDs
  (default `EPA`, so existing numbering is unchanged).
- Canteen payments taken offline may be dated at most `MAX_BACKDATE_DAYS` (60, in `Code.gs`) back.
- Fee-payment duplicate protection no longer reads the whole ledger on every payment
  (faster, and the lock is held for less time with big schools).
- `maxSavedScreens` in `config.js` caps what is kept on each device; background refreshing
  pauses while the tab is hidden (saves Apps Script daily quota).

- **Apps Script page generated, not hand-kept:** `scripts/make-gas-index.mjs` builds `Index.html` for the
  Apps Script web app from the same files as this site. The deploy workflow runs it and attaches the
  result to the run (Actions → the run → Artifacts → `apps-script-Index.html`). Paste it into Apps Script
  after each change; never edit that file by hand.
- **Payroll is not stored on devices** (salaries, bank details). To allow offline payroll on private devices
  set `cachePayroll: true` in `config.js`.
- **Picture links** (`https://`) for photos/crest are refused unless an administrator adds the Settings row
  `AllowImageLinks` = `true`; uploaded pictures always work.
- Failed sign-ins for an address are slowed down (0.3 s, 0.6 s … up to 2 s per try), on top of the lock-out.
- The canteen balance list is kept in the script cache for up to 5 minutes and refreshed automatically
  after every canteen change (`CanteenLedgerVersion` in Settings). If you edit the canteen sheet by hand,
  the screens catch up within 5 minutes.
- Pop-ups are real dialogs for keyboard and screen-reader users (focus stays inside, Esc closes), fields
  have accessible names, focus is visible, and animations stop for people who ask for reduced motion.
- `.github/dependabot.yml` opens a monthly pull request when a GitHub Action used by the deploy workflow has a
  new release. Actions are referenced by their official version tags (`actions/*@v4`), not by commit hash.

- **Formula safety:** anything typed or uploaded that starts with `=` or `@` (or `+`/`-` followed by more than a
  number) is saved as plain text, so a pupil name like `=HYPERLINK(...)` can never run as a spreadsheet formula.
- **Personal details are limited by role:** address, parent name, phone numbers, medical notes, date of birth and
  scholarship are sent only to roles that have the Students or Fees page. Others (for example a results-only
  teacher) get name, ID, class, gender and status.
- **Rollover is all-or-nothing:** if it fails part-way, students and settings are put back, so running it again can
  never count a term's fees twice. It tells you when no fee items were set up for the new term. Promotion refuses
  to run again at the start of a year if it was already done in Third Term.

- **Sign-in uses a username**, not an e-mail: 3–30 letters, numbers, dots, dashes or underscores (for example
  `kofi.mensah`), not case-sensitive. Accounts created earlier with an e-mail address keep working: they sign in with
  that address. The sign-in screen has a two-panel layout (brand panel plus form; compact on phones), show/hide
  password, Caps Lock warning, and works in light and dark mode.

### Security & offline update (November 2026)

- **Deploy workflow fixed.** The workflow GitHub actually ran (`.github/workflows/`) was an older copy;
  the newer one was in the repository root, where GitHub ignores it, next to a stray
  `deploy-pages (1).yml` that would have made it fail. There is now one workflow, in
  `.github/workflows/`. It gives each job only the permissions it needs (the build job can only read),
  does not keep the checkout credentials, syntax-checks the `apps-script/` files, and keeps the
  generated `Index.html` for 30 days. `dependabot.yml` moved to `.github/`, the only place GitHub reads it.
- **Clickjacking:** `frame-guard.js` hides the app when another site shows it in a frame (GitHub Pages
  cannot send the header that normally prevents this). `allowFraming: true` in `config.js` turns it off.
- **Content-Security-Policy** now also upgrades any `http:` request to `https:`. The inline `onsubmit`
  handlers, which the policy was silently blocking, were removed; the build now refuses inline
  scripts and handlers in `index.html` so this cannot creep back.
- **Shared computers:** a session without *Keep me signed in* signs out after `idleLockMinutes` (30)
  with no activity. Unsent offline changes stay on the device.
- **Session tokens** are longer (244 random bits) and the sign-in rejects over-long input. Sessions
  created before this update keep working.
- **Busy server:** when Apps Script answers "busy" (another update holds the lock, or a Google quota),
  everyday changes stay in the outbox and are retried automatically instead of being marked as
  refused; screens fall back to the saved copy.
- **Canteen corrections:** a wrong canteen payment is *reversed* (kept on record, receipt marked
  REVERSED), a wrong meal is removed. New permissions in Settings → Roles: *reverse canteen payments &
  remove meals*, *delete canteen expenses*, *change canteen settings*. Roles that had the old "Void"
  permission keep the first two.
- **More saved for offline:** each class's subjects (score entry), this month's canteen expenses,
  student search, a single student, one class's canteen balances and fee overview.

### Known limits

- Things entered offline (expenses, scores, conduct, attendance, canteen) are stamped with the term the
  device knew about **when they were made**; the server accepts that only for the current or the
  immediately previous term. **Fee payments are the exception**: money received after a rollover is
  stamped with the term in which it syncs, so it reduces what the student owes now.
- Balances shown include *payments* waiting in the outbox, but not meals from a canteen register
  saved offline (the register itself shows them). A fee item breakdown (which component a
  payment went to) is worked out by the server when the payment arrives.
- An offline canteen account worked out from the saved balance list has no history until the
  device is back online.

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
| The app shows only "Open iSmartSchool in its own window" | It was opened inside another website's frame. Open the link, or set `allowFraming: true` in `config.js` if you embed it on purpose. |
| Signed out after a break | The device was used without *Keep me signed in*: it signs out after `idleLockMinutes` (30) without activity. |
