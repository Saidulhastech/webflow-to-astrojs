#!/usr/bin/env node
/**
 * build.js — single-command pipeline.
 *
 * Reads project.config.json (any project name) and runs every stage in order:
 *
 *   1a. fetch-cms.js  OR  synthesize-cms.js   → cms-dump.json (+ live download in fetch mode)
 *   2.  build-maps.js                          → class-tw-* JSONs + tailwind.config.js
 *   3.  transform-tw-v4.js                     → output-{NAME}-tailwind-v4/
 *   4.  post-process.js                        → strip w- framework prefix in v4 output
 *   5.  convert-html-to-astro.mjs              → astro-{NAME}/  (typed content collections, mdx)
 *   6.  optimize-assets.mjs                    → webp/woff2 inside astro-{NAME}/   (optional)
 *   7.  cd astro-{NAME} && npm install && npm run build|dev
 *
 * Source mode is auto-detected:
 *   • if `{NAME}.webflow/css/` is missing AND the user supplied no --local,
 *     run the live fetch-cms crawler.
 *   • if a `*.webflow/` folder is present locally with a `css/` subfolder
 *     (Webflow "Export Code" output), run synthesize-cms instead — no
 *     network calls, derive cms-dump.json from the on-disk file tree.
 *   • If the local folder's basename ≠ project.config.json::name, the
 *     mismatch is auto-resolved by writing the new name back to the config.
 *
 * Flags:
 *   --local         force local-export mode (synthesize-cms)
 *   --fetch         force live fetch mode (fetch-cms) even if local present
 *   --skip-fetch    skip stage 1 entirely (use existing cms-dump.json)
 *   --skip-optimize skip stage 6
 *   --no-build      stop after stage 6
 *   --dev           after pipeline, run `npm run dev` instead of `npm run build`
 *   --only=<step>   run a single stage (fetch|local|maps|tw|post|astro|optimize|astrobuild|astrodev)
 */

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'project.config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('build.js: project.config.json not found at', CONFIG_PATH);
  process.exit(1);
}
let CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const argv = process.argv.slice(2);
const has  = (f) => argv.includes(f);
const only = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;

// ─── AUTO-DETECT WEBFLOW SOURCE FOLDER ───────────────────────────────────────
// If a *.webflow/ folder is on disk and project.config.json::name doesn't
// match its basename, sync the config to the folder so a freshly-dropped
// export "just works" without manual editing.
function findLocalWebflowDir() {
  const dirs = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.endsWith('.webflow'))
    .map(e => e.name);
  if (!dirs.length) return null;
  const expected = `${CONFIG.name}.webflow`;
  if (dirs.includes(expected)) return expected;
  if (dirs.length === 1) return dirs[0];          // single candidate → use it
  // Multiple candidates and none match — let user resolve.
  console.warn(`build.js: multiple *.webflow/ folders found (${dirs.join(', ')}) — none match config.name "${CONFIG.name}"`);
  return null;
}

function syncConfigName(folderName) {
  const detected = folderName.replace(/\.webflow$/, '');
  if (detected === CONFIG.name) return;
  console.log(`▶ Detected local export "${folderName}" — updating project.config.json::name "${CONFIG.name}" → "${detected}"`);
  CONFIG = { ...CONFIG, name: detected };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2) + '\n');
}

const localDir = findLocalWebflowDir();
if (localDir) syncConfigName(localDir);

const NAME = CONFIG.name;
if (!NAME) { console.error('build.js: project.config.json missing "name"'); process.exit(1); }

const SRC_DIR     = path.join(ROOT, `${NAME}.webflow`);
const SRC_CSS_DIR = path.join(SRC_DIR, 'css');
const TW4_OUT     = path.join(ROOT, `output-${NAME}-tailwind-v4`);
const ASTRO_DIR   = path.join(ROOT, `astro-${NAME}`);
const OPT_PATH    = path.join(ROOT, 'optimize-assets.mjs');

// Local mode is preferred when a local export with css/ is present —
// it skips network entirely. Override with --fetch.
const localExportPresent = fs.existsSync(SRC_DIR) && fs.existsSync(SRC_CSS_DIR);
const useLocal = has('--local') || (localExportPresent && !has('--fetch'));

function step(label, cmd, args, opts = {}) {
  const t0 = Date.now();
  process.stdout.write(`\n━━━ ${label} ━━━\n`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd || ROOT, shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`\n✗ ${label} failed (exit ${r.status})`);
    process.exit(r.status || 1);
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(`✓ ${label}  (${dt}s)\n`);
}

function ensureAstroInstall() {
  if (!fs.existsSync(ASTRO_DIR)) {
    console.error('build.js: astro dir missing, run --only=astro first');
    process.exit(1);
  }
  step('7a/7 npm install (astro)', 'npm', ['install', '--no-audit', '--no-fund'], { cwd: ASTRO_DIR });
}

const stages = {
  fetch:    () => step('1/7 fetch-cms (live)',     'node', ['fetch-cms.js']),
  local:    () => step('1/7 synthesize-cms (local)','node', ['synthesize-cms.js']),
  norm:     () => step('1b/7 normalize-images',    'node', ['normalize-images.js']),
  maps:     () => step('2/7 build-maps',           'node', ['build-maps.js']),
  tw:       () => step('3/7 transform-tw-v4',      'node', ['transform-tw-v4.js']),
  post:     () => step('4/7 post-process',         'node', ['post-process.js', TW4_OUT]),
  astro:    () => step('5/7 convert-html-to-astro','node', ['convert-html-to-astro.mjs']),
  optimize: () => {
    if (!fs.existsSync(ASTRO_DIR)) { console.error('build.js: astro dir missing, run --only=astro first'); process.exit(1); }
    if (!fs.existsSync(OPT_PATH))  { console.warn('build.js: optimize-assets.mjs missing — skipping'); return; }
    step('6/7 optimize-assets', 'node', ['optimize-assets.mjs']);
  },
  astrobuild: () => { ensureAstroInstall(); step('7b/7 npm run build (astro)', 'npm', ['run','build'], { cwd: ASTRO_DIR }); },
  astrodev:   () => { ensureAstroInstall(); step('7b/7 npm run dev (astro)',   'npm', ['run','dev'],   { cwd: ASTRO_DIR }); },
};

console.log(`▶ build.js — project "${NAME}"  (mode: ${useLocal ? 'local-export' : 'live-fetch'})`);

if (only) {
  if (!stages[only]) { console.error(`build.js: unknown --only=${only} (valid: ${Object.keys(stages).join('|')})`); process.exit(1); }
  // Auto-redirect source stage to match detected mode so `npm run fetch`
  // works in pipelines regardless of whether a local export is present.
  let resolved = only;
  if (only === 'fetch' && useLocal) {
    console.log('  (local export detected — running synthesize-cms instead of fetch-cms)');
    resolved = 'local';
  } else if (only === 'local' && !useLocal) {
    console.log('  (no local export — running fetch-cms instead of synthesize-cms)');
    resolved = 'fetch';
  }
  stages[resolved]();
  console.log('\n✓ done');
  process.exit(0);
}

if (!has('--skip-fetch')) {
  if (useLocal) stages.local();
  else          stages.fetch();
}
stages.norm();
stages.maps();
stages.tw();
stages.post();
stages.astro();
if (!has('--skip-optimize')) stages.optimize();

if (has('--no-build')) {
  console.log(`\n✓ pipeline complete (no-build) — astro-${NAME}/ ready`);
  console.log(`  cd astro-${NAME} && npm install && npm run ${has('--dev') ? 'dev' : 'build'}`);
  process.exit(0);
}

if (has('--dev')) stages.astrodev();
else              stages.astrobuild();

console.log(`\n✓ pipeline complete — astro-${NAME}/${has('--dev') ? '' : 'dist/'}`);
