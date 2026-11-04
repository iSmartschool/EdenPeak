#!/usr/bin/env node
// ------------------------------------------------------------------------
// iSmartSchool – build for GitHub Pages
//
//   node scripts/build.mjs            → writes the deployable site to _site/
//
// 1. Copies site/ to _site/.
// 2. If APPS_SCRIPT_URL is set (GitHub repository variable), writes it into
//    config.js so the URL never has to be committed.
// 3. Hashes every file and stamps the service worker with a BUILD_ID and
//    the exact precache list. Any change to any file → new BUILD_ID → the
//    app offers "Update now" and old copies are removed from devices.
// 4. Checks the result (all referenced files exist, config looks right).
// ------------------------------------------------------------------------
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const SRC = join(root, 'site');
const OUT = join(root, '_site');
const fail = (msg) => { console.error('✖ ' + msg); process.exit(1); };

rmSync(OUT, { recursive: true, force: true });
cpSync(SRC, OUT, { recursive: true });

// --- 2. API URL ---------------------------------------------------------
const apiUrl = (process.env.APPS_SCRIPT_URL || '').trim();
const cfgPath = join(OUT, 'config.js');
let cfg = readFileSync(cfgPath, 'utf8');
if (apiUrl) {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(apiUrl)) {
    fail('APPS_SCRIPT_URL must look like https://script.google.com/macros/s/<id>/exec (got: ' + apiUrl + ')');
  }
  cfg = cfg.replace(/apiUrl:\s*'[^']*'/, `apiUrl: '${apiUrl}'`);
  writeFileSync(cfgPath, cfg);
  console.log('✔ API URL set from APPS_SCRIPT_URL');
} else {
  const m = /apiUrl:\s*'([^']*)'/.exec(cfg);
  if (!m || !m[1]) console.warn('⚠ No API URL: set the APPS_SCRIPT_URL repository variable or fill apiUrl in site/config.js. The app will show a "not connected" message.');
  else if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(m[1])) fail('apiUrl in config.js does not look like an Apps Script web app URL ending in /exec');
}

// --- 3. Precache list + build id ---------------------------------------
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const SKIP = new Set(['sw.js', '.nojekyll', '404.html']);
const LAZY = new Set(['assets/vendor/exceljs.min.js']);
const files = walk(OUT).map((p) => relative(OUT, p).split(sep).join('/')).filter((f) => !SKIP.has(f)).sort();
const precache = ['./'].concat(files.filter((f) => !LAZY.has(f)));

const hash = createHash('sha256');
for (const f of files) { hash.update(f); hash.update(readFileSync(join(OUT, f))); }
const buildId = hash.digest('hex').slice(0, 12);

const swPath = join(OUT, 'sw.js');
let sw = readFileSync(swPath, 'utf8');
if (!sw.includes('__BUILD_ID__') || !sw.includes('/*__PRECACHE_LIST__*/')) fail('sw.js is missing its build markers');
sw = sw.replace("'__BUILD_ID__'", JSON.stringify(buildId))
       .replace(/\/\*__PRECACHE_LIST__\*\/[\s\S]*?\/\*__END_PRECACHE_LIST__\*\//, JSON.stringify(precache, null, 2));
writeFileSync(swPath, sw);

// --- 4. Checks ----------------------------------------------------------
const index = readFileSync(join(OUT, 'index.html'), 'utf8');
for (const [, ref] of index.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
  if (!existsSync(join(OUT, ref.split('?')[0]))) fail('index.html references a missing file: ' + ref);
}
const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.webmanifest'), 'utf8'));
for (const icon of manifest.icons) if (!existsSync(join(OUT, icon.src))) fail('manifest icon missing: ' + icon.src);
if (!existsSync(join(OUT, '.nojekyll'))) writeFileSync(join(OUT, '.nojekyll'), '');

const kb = Math.round(files.reduce((t, f) => t + statSync(join(OUT, f)).size, 0) / 1024);
console.log(`✔ Built _site/  build ${buildId}  ·  ${precache.length} files precached  ·  ${kb} KB total`);
