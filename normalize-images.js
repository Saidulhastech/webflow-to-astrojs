/**
 * normalize-images.js
 *
 * Walks {NAME}.webflow/ and replaces literal spaces in image filenames with
 * underscores. Webflow's "Export Code" output preserves CMS asset names
 * including spaces (e.g. `Project Image4.jpg`) — those break srcset parsing
 * in browsers (whitespace = candidate separator) and produce "Dropped srcset
 * candidate" warnings + 404s.
 *
 * Steps:
 *   1. Rename every file in `{NAME}.webflow/images/` containing whitespace.
 *   2. Walk HTML / CSS / JS / MDX files in `{NAME}.webflow/` and rewrite both
 *      literal-space and `%20`-encoded references to use the new names.
 *
 * Idempotent: no spaces left = no-op. Safe to run on every pipeline pass.
 *
 * Usage: node normalize-images.js          (uses project.config.json::name)
 *        node normalize-images.js {NAME}   (override)
 */

const fs   = require('fs');
const path = require('path');

const ROOT = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'));
const NAME   = process.argv[2] || CONFIG.name;
if (!NAME) { console.error('normalize-images.js: missing name'); process.exit(1); }

const SRC     = path.join(ROOT, `${NAME}.webflow`);
const IMG_DIR = path.join(SRC, 'images');

if (!fs.existsSync(IMG_DIR)) {
  console.warn(`normalize-images: ${IMG_DIR} not found — skipping`);
  process.exit(0);
}

function log(m) { process.stdout.write(m + '\n'); }

// 1. Build rename map + apply renames.
const renames = new Map();
for (const f of fs.readdirSync(IMG_DIR)) {
  if (!/\s/.test(f)) continue;
  const newName = f.replace(/\s+/g, '_');
  const oldPath = path.join(IMG_DIR, f);
  const newPath = path.join(IMG_DIR, newName);
  if (fs.existsSync(newPath)) {
    // Collision — keep the older (non-space) version, drop the new.
    fs.unlinkSync(oldPath);
  } else {
    fs.renameSync(oldPath, newPath);
  }
  renames.set(f, newName);
}

if (renames.size === 0) {
  log(`normalize-images: no spaces found, nothing to do`);
  process.exit(0);
}

log(`normalize-images: renamed ${renames.size} file(s)`);

// 2. Rewrite text refs across all HTML/CSS/JS/MDX in {NAME}.webflow/.
const TEXT_EXTS = new Set(['.html', '.css', '.js', '.mjs', '.mdx', '.md', '.json']);
const SKIP_DIRS = new Set(['images', 'fonts', 'js', 'videos', 'node_modules']);

function walkText(dir, fn) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walkText(full, fn);
    } else if (TEXT_EXTS.has(path.extname(e.name).toLowerCase())) {
      fn(full);
    }
  }
}

let touched = 0;
walkText(SRC, file => {
  let content = fs.readFileSync(file, 'utf8');
  let dirty = false;
  for (const [oldN, newN] of renames) {
    // Match plain space + URL-encoded space variants.
    const variants = [oldN, oldN.replace(/ /g, '%20')];
    for (const v of variants) {
      if (content.includes(v)) {
        content = content.split(v).join(newN);
        dirty = true;
      }
    }
  }
  if (dirty) {
    fs.writeFileSync(file, content);
    touched++;
  }
});

log(`normalize-images: rewrote refs in ${touched} text file(s)`);
