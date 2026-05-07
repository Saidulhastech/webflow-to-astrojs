/**
 * synthesize-cms.js
 *
 * Local-export mode replacement for fetch-cms.js.
 *
 * Reads a pre-extracted Webflow ZIP folder ({NAME}.webflow/) and emits
 * cms-dump.json + the same skeleton fetch-cms produces, WITHOUT any
 * network calls. Use when the user dropped Webflow's "Export Code" output
 * into the repo instead of crawling the live site.
 *
 * Discovers:
 *   • Top-level *.html  → rootPages entries
 *   • {col}/{slug}.html → collection items (col = 1st path segment)
 *
 * Reads each HTML file with a tiny regex pass to pick:
 *   • <title>...</title>                       → title
 *   • <meta name="description" content="...">  → description
 *   • data-wf-item-slug="..."                  → slug override (rare)
 *
 * Output schema matches fetch-cms.js so downstream scripts don't change.
 *
 * Usage: node synthesize-cms.js          (uses project.config.json::name)
 *        node synthesize-cms.js {NAME}   (override)
 */

const fs   = require('fs');
const path = require('path');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'project.config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('synthesize-cms.js: project.config.json not found');
  process.exit(1);
}
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const NAME   = process.argv[2] || CONFIG.name;
if (!NAME) { console.error('synthesize-cms.js: missing NAME'); process.exit(1); }

const SRC = path.join(ROOT, `${NAME}.webflow`);
if (!fs.existsSync(SRC)) {
  console.error(`synthesize-cms.js: source folder not found: ${SRC}`);
  process.exit(1);
}

function log(msg) { process.stdout.write(msg + '\n'); }
function ext(s, re, idx = 1) { const m = s.match(re); return m ? m[idx].trim() : ''; }
function decode(s) { return String(s || '').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>'); }

function walkHtml(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!['css','js','images','fonts','videos'].includes(e.name)) walkHtml(full, base, out);
    } else if (e.name.endsWith('.html')) {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out;
}

// Strip resale-unsafe Webflow marketing suffix from titles emitted by
// `Export Code` (e.g. "Home | Prolio - Webflow HTML Website Template").
function sanitizeTitle(t) {
  return t
    .replace(/\s*[-|–—]?\s*Webflow\s+HTML\s+(?:Website\s+)?Template\s*$/i, '')
    .replace(/\s*-\s*Webflow\s+Template\s*$/i, '')
    .trim();
}

function readMeta(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const title       = sanitizeTitle(decode(ext(html, /<title>([\s\S]*?)<\/title>/i)));
  const description = decode(
       ext(html, /<meta\s+name="description"\s+content="([^"]*)"/i)
    || ext(html, /<meta\s+content="([^"]*)"\s+name="description"/i)
    || ext(html, /<meta\s+property="og:description"\s+content="([^"]*)"/i)
  );
  const wfSlug = ext(html, /\bdata-wf-item-slug="([^"]+)"/i);
  return { title, description, wfSlug };
}

const SKIP_PATHS = (CONFIG.skipPaths || []).map(p => p.replace(/\/+$/, '').replace(/^\/+/, ''));
function isSkipped(rel) {
  if (rel === 'index.html') return true;                       // landing showcase
  if (path.basename(rel).startsWith('detail_')) return true;   // CMS-detail templates
  for (const sp of SKIP_PATHS) {
    if (rel === `${sp}.html` || rel.startsWith(`${sp}/`)) return true;
  }
  return false;
}

(function main() {
  log(`\n🔍 synthesize-cms — project "${NAME}"`);
  log(`   SOURCE: ${SRC}`);

  const allRels = walkHtml(SRC).filter(r => !isSkipped(r));
  const collections = {};
  const rootPages = [];

  for (const rel of allRels) {
    const segs = rel.split('/');
    const meta = readMeta(path.join(SRC, rel));
    const slug = meta.wfSlug || path.basename(rel, '.html');

    if (segs.length === 1) {
      rootPages.push({
        url: '/' + path.basename(rel, '.html'),
        outRel: rel,
        title: meta.title,
        description: meta.description,
      });
    } else {
      const col = segs[0];
      collections[col] ||= [];
      collections[col].push({
        slug,
        outRel: rel,
        title: meta.title,
        description: meta.description,
      });
    }
  }

  // De-dupe collection items by slug, sort alphabetically
  for (const c of Object.keys(collections)) {
    const seen = new Set();
    collections[c] = collections[c]
      .filter(it => (seen.has(it.slug) ? false : (seen.add(it.slug), true)))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  const dump = {
    name: NAME,
    site: CONFIG.site || `https://${NAME}.com`,
    source: 'local-export',
    generatedAt: new Date().toISOString(),
    rootPages: rootPages.sort((a, b) => a.outRel.localeCompare(b.outRel)),
    collections,
  };

  const dumpPath = path.join(ROOT, 'cms-dump.json');
  fs.writeFileSync(dumpPath, JSON.stringify(dump, null, 2));
  log(`\n📦 cms-dump.json — ${rootPages.length} root pages, ${Object.keys(collections).length} collection(s)`);
  for (const [c, items] of Object.entries(collections)) log(`     • ${c}/  (${items.length})`);
  log(`\n✅ synthesize-cms complete.\n`);
})();
