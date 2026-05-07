/**
 * convert-html-to-astro.mjs
 *
 * Bootstraps a fresh Astro project from post-processed Webflow HTML.
 *
 * Pipeline assumed:
 *   1. fetch-cms.js          → {NAME}.webflow/  + cms-dump.json
 *   2. build-maps.js         → JSONs + tailwind.config.js
 *   3. transform-tw-v4.js    → output-{NAME}-tailwind-v4/
 *   4. THIS SCRIPT           → astro-{NAME}/
 *
 * Reads:
 *   - project.config.json
 *   - cms-dump.json
 *   - SOURCE = output-{NAME}-tailwind-v4/   (override: argv[2])
 *
 * Emits TARGET = astro-{NAME}/  (override: argv[3]):
 *   - package.json, astro.config.mjs, tsconfig.json, tailwind.config.js
 *   - src/layouts/BaseLayout.astro
 *   - src/components/{SEO,SiteHeader,SiteFooter}.astro
 *   - src/pages/index.astro + per-page astro files
 *   - src/pages/{collection}/index.astro + [slug].astro per CMS collection
 *   - src/assets/images/   (for future <Image> imports)
 *   - src/styles/{custom,tailwind}.css
 *   - src/content.config.ts + src/content/{collection}/*.mdx (Astro 5 typed collections)
 *   - public/assets/{images,js}/, public/fonts/, public/favicon.*
 *
 * SEO best practices baked in:
 *   - canonical, OpenGraph, Twitter Card, JSON-LD per page-type
 *   - sitemap (via @astrojs/sitemap), prefetch on viewport, ViewTransitions
 *   - explicit width/height on every img (CLS), loading=lazy + decoding=async
 *   - LCP images (matched by config.lcpClasses) get loading=eager + fetchpriority=high
 *   - rel=noopener noreferrer on target=_blank links
 *   - 401/404 marked noindex
 *
 * Idempotent: wipes src/ + public/ + config files on each run; preserves
 * node_modules + .git + .env.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import sharp from 'sharp';

// ─── PATHS / CONFIG ───────────────────────────────────────────────────────────
const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, 'project.config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('convert-html-to-astro.mjs: project.config.json not found in cwd');
  process.exit(1);
}
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const NAME   = CONFIG.name;

const SOURCE = process.argv[2] || path.join(ROOT, `output-${NAME}-tailwind-v4`);
const TARGET = process.argv[3] || path.join(ROOT, `astro-${NAME}`);
if (!fs.existsSync(SOURCE)) {
  console.error(`convert: SOURCE not found: ${SOURCE}`);
  console.error(`         run transform-tw-v4.js first`);
  process.exit(1);
}

const CMS_DUMP_PATH = path.join(ROOT, 'cms-dump.json');
const CMS = fs.existsSync(CMS_DUMP_PATH)
  ? JSON.parse(fs.readFileSync(CMS_DUMP_PATH, 'utf8'))
  : { collections: {}, rootPages: [] };

// Output paths
const SRC        = path.join(TARGET, 'src');
const PAGES      = path.join(SRC, 'pages');
const LAYOUTS    = path.join(SRC, 'layouts');
const COMPONENTS = path.join(SRC, 'components');
const ASSETS_DIR = path.join(SRC, 'assets');
const STYLES     = path.join(SRC, 'styles');
const CONTENT    = path.join(SRC, 'content');  // Astro 5 typed content collections (mdx files per item)
const PUBLIC     = path.join(TARGET, 'public');
const PUB_ASSETS = path.join(PUBLIC, 'assets');

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function log(msg) { process.stdout.write(msg + '\n'); }
function posix(p) { return p.split(path.sep).join('/'); }
function copyDir(src, dst) {
  ensureDir(dst);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
function relImport(fromFile, toFile) {
  let r = posix(path.relative(path.dirname(fromFile), toFile));
  if (!r.startsWith('.')) r = './' + r;
  return r;
}
function escAttr(v) { return String(v).replace(/'/g, "\\'").replace(/\r?\n/g, ' '); }
function reEsc(s)  { return s.replace(/[/.\-?+()[\]{}|*\\^$]/g, '\\$&'); }

function walkHtml(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!['css','js','images','fonts','videos'].includes(e.name)) walkHtml(full, base, out);
    } else if (e.name.endsWith('.html')) out.push(posix(path.relative(base, full)));
  }
  return out;
}

// Image dimension cache (sharp.metadata is slow; run once per image)
const imageDims = new Map();
async function getImageDims(absPath) {
  if (imageDims.has(absPath)) return imageDims.get(absPath);
  if (!fs.existsSync(absPath)) { imageDims.set(absPath, null); return null; }
  try {
    const m = await sharp(absPath).metadata();
    const dims = { w: m.width, h: m.height };
    imageDims.set(absPath, dims);
    return dims;
  } catch {
    imageDims.set(absPath, null);
    return null;
  }
}

// ─── ROUTE MAPPER (source rel → Astro URL) ────────────────────────────────────
const homePromoteRel = (CONFIG.homePromote || '').replace(/\/+$/, '') + '.html'; // e.g. "home/home-one.html"

let listMapRef  = {};   // collection → list-page rel (e.g. "post" → "blog.html")
let altMapRef   = {};   // collection → alt-layout rel (e.g. "project" → "works-two.html")

function routeForRel(rel) {
  if (rel === homePromoteRel)        return '/';
  if (rel === 'index.html')          return '/'; // legacy showcase, dropped — but route still resolves home
  // Sibling home variants are flattened on disk (home/home-two.html → pages/home-two.astro);
  // route must follow the flatten rule, otherwise nav links 404.
  if (rel.startsWith('home/') && rel !== homePromoteRel) {
    return `/${path.basename(rel, '.html')}/`;
  }
  // Collection list page (e.g. blog.html → /post/, works-one.html → /project/)
  for (const [col, listRel] of Object.entries(listMapRef)) {
    if (rel === listRel) return `/${col}/`;
  }
  // Detail page in a known collection (post/foo.html → /post/foo/)
  const segs = rel.split('/');
  if (segs.length >= 2) {
    const col = segs[0];
    if (CMS.collections?.[col]) {
      const slug = segs.slice(1).join('/').replace(/\.html$/, '');
      return `/${col}/${slug}/`;
    }
  }
  // Alt-layout standalone (works-two.html → /works-two/)
  // Falls through to default below.
  return `/${rel.replace(/\.html$/, '')}/`;
}

// ─── ASSET PATH NORMALIZER + LINK REWRITER ───────────────────────────────────
function normalizeAssetPaths(html) {
  // ../images/foo.webp  OR  images/foo.webp  →  /assets/images/foo.webp
  return html
    .replace(/(["'(])(?:\.\.\/)+(images|fonts|js|css)\//g, '$1/assets/$2/')
    .replace(/(["'(])(images|fonts|js|css)\//g, '$1/assets/$2/');
}

// CSS-side: url(../fonts/x.woff2) → url(/fonts/x.woff2) (since fonts go to public/fonts/, not /assets/fonts/)
function rewriteCssAssetPaths(css) {
  const NAME_ICONS = `${NAME}-icons`;
  return css
    .replace(/url\((['"]?)(?:\.\.\/)+fonts\//g,  'url($1/fonts/')
    .replace(/url\((['"]?)(?:\.\.\/)+images\//g, 'url($1/assets/images/')
    .replace(/url\((['"]?)fonts\//g,  'url($1/fonts/')
    .replace(/url\((['"]?)images\//g, 'url($1/assets/images/')
    // Drop .webflow-badge rules (visual-only watermark)
    .replace(/\.w-webflow-badge[\s\S]*?\}\s*/g, '')
    // Resale-safety: strip Webflow CDN refs + rename Webflow icon font.
    .replace(/url\((['"]?)https:\/\/d3e54v103j8qbb\.cloudfront\.net\/static\/custom-checkbox-checkmark\.589d534424\.svg\1\)/gi,
      'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%2712%27 viewBox=%270 0 12 12%27%3E%3Cpath fill=%27%23fff%27 d=%27M3.532 4.81 1.65 6.69l3.182 3.183 5.524-5.524-1.882-1.882-3.642 3.643z%27/%3E%3C/svg%3E")')
    .replace(/url\(([^)]*)https:\/\/cdn\.prod\.website-files\.com\/[a-f0-9]+\//gi, 'url($1/assets/images/')
    .replace(/url\(([^)]*)https:\/\/uploads-ssl\.webflow\.com\/[a-f0-9]+\//gi, 'url($1/assets/images/')
    .replace(/(['"])webflow-icons\1/g, `$1${NAME_ICONS}$1`);
}

function rewriteInternalLinks(html) {
  // Map every href that ends in .html to its Astro route.
  return html.replace(/\bhref="([^"#?]+\.html)([?#][^"]*)?"/g, (_m, target, suffix = '') => {
    const norm = target.replace(/^\.\.\/+/, '').replace(/^\.\//, '').replace(/^\/+/, '');
    const route = routeForRel(norm);
    return `href="${route}${suffix}"`;
  });
}

// ─── REBRAND + SKIP-LINK STRIPS ──────────────────────────────────────────────
function rebrandHtml(html) {
  for (const r of (CONFIG.rebrand?.footerCredit || [])) {
    html = html.replace(
      new RegExp(`href="${reEsc(r.fromUrl)}"([^>]*)>${reEsc(r.fromText)}</a>`, 'g'),
      `href="${r.toUrl}"$1>${r.toText}</a>`
    );
  }
  return html;
}

function stripSkippedLinks(html) {
  for (const sp of (CONFIG.skipPaths || [])) {
    const escSp = reEsc(sp.replace(/\/+$/, ''));
    // Drop entire <a> tag pointing to a skipped path (e.g. /template-info/...)
    html = html.replace(
      new RegExp(`<a\\b[^>]*\\bhref="${escSp}[^"]*"[^>]*>[\\s\\S]*?</a>`, 'g'),
      ''
    );
  }
  // Drop empty footer-link wrapper left behind after link removal.
  return html
    .replace(/<div class="footer-link-wrapper">\s*<\/div>/g, '')
    .replace(/<div class="footer-link-wrapper">\s*(?:&nbsp;|\s)*<\/div>/g, '');
}

// ─── IMAGE ENRICHMENT ────────────────────────────────────────────────────────
function normalizeImgSrc(url) {
  if (!url || url.startsWith('data:') || url.startsWith('http')) return url;
  if (url.startsWith('/assets/images/')) return url;
  if (url.startsWith('/images/'))        return '/assets/images/' + url.slice('/images/'.length);
  if (url.includes('/images/'))          return '/assets/images/' + url.split('/images/').pop();
  if (url.startsWith('images/'))         return '/assets/images/' + url.slice('images/'.length);
  return url;
}

async function enrichImages(html) {
  // 3rd arg `false` = fragment mode — cheerio won't add <html><head><body>.
  const $ = cheerio.load(html, { decodeEntities: false }, false);
  const lcpClasses = CONFIG.lcpClasses || [];

  for (const el of $('img').toArray()) {
    const $el = $(el);
    let src = $el.attr('src') || '';
    if (src && !src.startsWith('data:')) {
      src = normalizeImgSrc(src);
      $el.attr('src', src);
    }

    // srcset rewrite (Webflow leaves "images/foo.jpg 800w" alongside fully-qualified entries).
    const srcset = $el.attr('srcset');
    if (srcset) {
      const fixed = srcset.split(',').map(part => {
        const trimmed = part.trim();
        if (!trimmed) return '';
        const [u, ...rest] = trimmed.split(/\s+/);
        return [normalizeImgSrc(u), ...rest].join(' ');
      }).filter(Boolean).join(', ');
      $el.attr('srcset', fixed);
    }

    // CLS prevention: explicit width/height from sharp metadata.
    if (src && !src.startsWith('data:') && !src.startsWith('http')) {
      const filename = src.replace(/^\/assets\/images\//, '');
      const localPath = path.join(PUB_ASSETS, 'images', filename);
      const dims = await getImageDims(localPath);
      if (dims) {
        if (!$el.attr('width'))  $el.attr('width',  String(dims.w));
        if (!$el.attr('height')) $el.attr('height', String(dims.h));
      }
    }

    // LCP marker.
    const cls = $el.attr('class') || '';
    const isLcp = lcpClasses.some(c => cls.split(/\s+/).includes(c));
    if (isLcp) {
      $el.attr('loading', 'eager');
      $el.attr('fetchpriority', 'high');
    } else if (!$el.attr('loading')) {
      $el.attr('loading', 'lazy');
    }
    if (!$el.attr('decoding')) $el.attr('decoding', 'async');
  }

  // <source srcset> in <picture> — same treatment.
  $('source[srcset]').each((_, el) => {
    const $el = $(el);
    const srcset = $el.attr('srcset') || '';
    const fixed = srcset.split(',').map(part => {
      const trimmed = part.trim();
      if (!trimmed) return '';
      const [u, ...rest] = trimmed.split(/\s+/);
      return [normalizeImgSrc(u), ...rest].join(' ');
    }).filter(Boolean).join(', ');
    $el.attr('srcset', fixed);
  });

  // External-link safety.
  $('a[target="_blank"]').each((_, el) => {
    const $el = $(el);
    if (!$el.attr('rel')) $el.attr('rel', 'noopener noreferrer');
  });

  return $.html();
}

// ─── HTML SLICERS ────────────────────────────────────────────────────────────
function extractBody(html) {
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return m ? m[1] : html;
}
function extractTitle(html) {
  return (html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '')
    .replace(/\s*[-|–—]?\s*Webflow\s+HTML\s+(?:Website\s+)?Template\s*$/i, '')
    .replace(/\s*-\s*Webflow\s+Template\s*$/i, '')
    .trim();
}
function extractDesc(html) {
  return (html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1]
       || html.match(/<meta\s+content="([^"]*)"\s+name="description"/i)?.[1]
       || '').trim();
}
function splitParts(body) {
  const headerStart = body.indexOf('<header');
  const headerEnd   = headerStart >= 0
    ? body.indexOf('</header>', headerStart) + '</header>'.length : -1;
  const footerStart = body.lastIndexOf('<footer');
  const footerEnd   = footerStart >= 0
    ? body.indexOf('</footer>', footerStart) + '</footer>'.length : -1;
  let middle       = (headerEnd >= 0 && footerStart >= 0)
    ? body.slice(headerEnd, footerStart)
    : body;
  // Strip outer <main ...> wrapper — BaseLayout provides its own <main>.
  // Match: optional whitespace, opening <main ...>, capture inner, closing </main>.
  const mainMatch = middle.match(/^\s*<main\b[^>]*>([\s\S]*)<\/main>\s*$/i);
  if (mainMatch) middle = mainMatch[1];
  return {
    header:  headerStart >= 0 ? body.slice(headerStart, headerEnd) : '',
    content: middle,
    footer:  footerStart >= 0 ? body.slice(footerStart, footerEnd) : '',
  };
}

// Defense-in-depth: drop any lingering Webflow-only data-attrs on body/html/script tags
// (data-wf-domain, data-wf-status, data-wf-page-id, ...) — works for every project.
// Excludes `data-wf-page` and `data-wf-site` because webflow.js IX2 events bind
// to them (target.id = "<page>|<element>"); stripping kills every animation.
function stripWebflowDataAttrs(html) {
  if (CONFIG.keepWebflowJs !== false) {
    return html.replace(/\s+data-wf-(?!page\b|site\b)[a-z0-9-]+\s*=\s*("[^"]*"|'[^']*'|\S+)/gi, '');
  }
  return html.replace(/\s+data-wf-[a-z0-9-]+\s*=\s*("[^"]*"|'[^']*'|\S+)/gi, '');
}

// Resale-safety scrub: remove any third-party Webflow runtime + IP markers so
// the Astro template can be sold without bundling Webflow-owned assets or
// leaking the source webflow.io site identity.
//   - drops <script> tags pointing at d3e54v103j8qbb.cloudfront.net (Webflow CDN jQuery)
//   - drops <script> tags loading the legacy `webflow.js` runtime
//   - removes <html data-site> / <html data-page> page-id attrs
//   - replaces hardcoded https://{NAME}.webflow.io links with relative paths
//   - rewrites Webflow asset CDN URLs (cdn.prod.website-files.com / uploads-ssl.webflow.com / assets-global.website-files.com) to /assets/images/
//   - strips `<!-- Last Published: ... -->` Webflow build banner
//   - sanitises page <title> tags by removing trailing "— Webflow HTML Website Template"
//   - swaps inline base64 url() reference to Webflow's checkbox SVG with a self-hosted equivalent
//   - rewrites `webflow-icons` font-family name to `{NAME}-icons`
function sanitizeWebflowResale(html) {
  const NAME_ICONS = `${NAME}-icons`;
  const stripMarketing = (t) => t
    .replace(/\s*[-|–—]?\s*Webflow\s+HTML\s+(?:Website\s+)?Template/gi, '')
    .replace(/\s*-\s*Webflow\s+Template\s*$/i, '')
    .trim();
  return html
    .replace(/<script\b[^>]*\bsrc=["'][^"']*\bd3e54v103j8qbb\.cloudfront\.net[^"']*["'][^>]*><\/script>\s*/gi, '')
    .replace(/<script\b[^>]*\bsrc=["'][^"']*\/(?:js\/)?webflow\.js(?:\?[^"']*)?["'][^>]*><\/script>\s*/gi, '')
    .replace(/<link\b[^>]*\bhref=["']https:\/\/cdn\.prod\.website-files\.com[^"']*["'][^>]*>\s*/gi, '')
    .replace(/<link\b[^>]*\bhref=["']https:\/\/d3e54v103j8qbb\.cloudfront\.net[^"']*["'][^>]*>\s*/gi, '')
    .replace(/<!--\s*Last Published:[\s\S]*?-->\s*/gi, '')
    // Keep data-wf-page / data-wf-site — webflow.js IX2 events bind to them.
    // (Stripping breaks every animation; the IDs are also baked into the
    // webflow.js bundle so removing from HTML alone is security theatre.)
    // CDN refs: literal /, URL-encoded %2F, and double-URL-encoded.
    .replace(/https:\/\/cdn\.prod\.website-files\.com\/[a-f0-9]+(?:\/|%2F)/gi, '/assets/images/')
    .replace(/https:\/\/uploads-ssl\.webflow\.com\/[a-f0-9]+(?:\/|%2F)/gi, '/assets/images/')
    .replace(/https:\/\/assets-global\.website-files\.com\/[a-f0-9]+(?:\/|%2F)/gi, '/assets/images/')
    .replace(/https%3A%2F%2Fcdn\.prod\.website-files\.com%2F[a-f0-9]+%2F/gi, '%2Fassets%2Fimages%2F')
    .replace(/https%3A%2F%2Fuploads-ssl\.webflow\.com%2F[a-f0-9]+%2F/gi, '%2Fassets%2Fimages%2F')
    // Inline-style url() with site-id segment: images/{id}/foo.jpg → images/foo.jpg
    .replace(/(["'(]|&quot;)((?:\.\.\/)?(?:\/?assets\/)?images\/)[a-f0-9]{16,}\//gi, '$1$2')
    .replace(new RegExp(`https://${reEsc(NAME)}\\.webflow\\.io/(blog|services|projects|home|projects?-categories|blog-categories)/([A-Za-z0-9_-]+)`, 'g'), '/$1/$2/')
    .replace(new RegExp(`https://${reEsc(NAME)}\\.webflow\\.io/(401|404)\\b`, 'g'), '/$1/')
    .replace(new RegExp(`https://${reEsc(NAME)}\\.webflow\\.io/?`, 'g'), '/')
    .replace(/<title>([^<]*)<\/title>/gi, (_m, t) => `<title>${stripMarketing(t)}</title>`)
    .replace(/<meta\s+content="([^"]*)"\s+property="(og:title|twitter:title)"/gi,
      (_m, c, p) => `<meta content="${stripMarketing(c)}" property="${p}"`)
    .replace(/<meta\s+property="(og:title|twitter:title)"\s+content="([^"]*)"/gi,
      (_m, p, c) => `<meta property="${p}" content="${stripMarketing(c)}"`)
    .replace(/url\((['"]?)https:\/\/d3e54v103j8qbb\.cloudfront\.net\/static\/custom-checkbox-checkmark\.589d534424\.svg\1\)/gi,
      'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%2712%27 viewBox=%270 0 12 12%27%3E%3Cpath fill=%27%23fff%27 d=%27M3.532 4.81 1.65 6.69l3.182 3.183 5.524-5.524-1.882-1.882-3.642 3.643z%27/%3E%3C/svg%3E")')
    .replace(/(['"])webflow-icons\1/g, `$1${NAME_ICONS}$1`);
}

async function processFragment(rawHtml) {
  let h = normalizeAssetPaths(rawHtml);
  h = rewriteInternalLinks(h);
  h = rebrandHtml(h);
  h = stripSkippedLinks(h);
  h = stripWebflowDataAttrs(h);
  h = sanitizeWebflowResale(h);
  h = await enrichImages(h);
  return h;
}

// ─── PROJECT BOOTSTRAP ────────────────────────────────────────────────────────
function bootstrapAstro() {
  log(`\n📦 Bootstrapping Astro project at ${posix(path.relative(ROOT, TARGET)) || '.'}/`);

  // Wipe regenerated dirs/files. Preserve node_modules, .git, .env, package-lock.
  for (const sub of ['src', 'public']) {
    const p = path.join(TARGET, sub);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }
  for (const f of ['astro.config.mjs','tsconfig.json','tailwind.config.js','tailwind.config.cjs','package.json','README.md','LICENSE']) {
    const p = path.join(TARGET, f);
    if (fs.existsSync(p)) fs.rmSync(p);
  }

  ensureDir(SRC); ensureDir(PAGES); ensureDir(LAYOUTS); ensureDir(COMPONENTS);
  ensureDir(ASSETS_DIR); ensureDir(STYLES); ensureDir(CONTENT);
  ensureDir(PUBLIC); ensureDir(PUB_ASSETS);

  // package.json
  const pkg = {
    name: `astro-${NAME}`,
    version: '0.1.0',
    type: 'module',
    private: true,
    scripts: {
      dev: 'astro dev',
      start: 'astro dev',
      build: 'astro build',
      preview: 'astro preview',
      astro: 'astro',
    },
    dependencies: {
      astro: '^6.0.0',
      '@astrojs/sitemap': '^3.7.0',
      '@astrojs/mdx': '^5.0.0',
      sharp: '^0.34.0',
    },
    // Pin Vite 7 — Astro 6 doesn't support Vite 8 yet, npm pulls v8 transitively otherwise.
    overrides: {
      vite: '^7',
    },
  };
  fs.writeFileSync(path.join(TARGET, 'package.json'), JSON.stringify(pkg, null, 2));

  // astro.config.mjs
  // purgecss runs LAST and ONLY in `astro build` (skipped in `astro dev` to avoid
  // page-scan warnings on every content sync). Safelist preserves Webflow-runtime
  // classes (added by webflow.js at runtime, never in source HTML).
  const astroConfig = `import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import mdx from '@astrojs/mdx';

export default defineConfig({
  site: ${JSON.stringify(CONFIG.site || `https://${NAME}.com`)},
  trailingSlash: 'always',
  output: 'static',
  prefetch: { defaultStrategy: 'viewport' },
  // Tailwind utility CSS is shipped pre-built from transform-tw-v4 as a static
  // asset (public/styles/tailwind.css) — bypasses Vite/PostCSS so the project's
  // custom v3 spacing/font/color scale survives intact. No purgecss either:
  // transform-tw-v4 already ran tailwind's content-aware purge during build,
  // so a second purge pass would risk stripping classes that webflow.js adds at
  // runtime (slider/tabs/dropdown state classes never appear in source HTML).
  integrations: [
    sitemap(),
    mdx(),
  ],
  image: { service: { entrypoint: 'astro/assets/services/sharp' } },
});
`;
  fs.writeFileSync(path.join(TARGET, 'astro.config.mjs'), astroConfig);

  // tsconfig.json
  fs.writeFileSync(path.join(TARGET, 'tsconfig.json'), JSON.stringify({
    extends: 'astro/tsconfigs/strict',
    include: ['.astro/types.d.ts', '**/*'],
    exclude: ['dist'],
    compilerOptions: { baseUrl: '.', paths: { '~/*': ['src/*'] } },
  }, null, 2));

  // Tailwind v4 uses CSS-first config (@theme {} blocks inside src/styles/tailwind.css)
  // and the @tailwindcss/vite plugin auto-scans src/**/*. No tailwind.config.js needed.

  // site.config.ts (subset of project.config exposed at runtime)
  fs.writeFileSync(path.join(SRC, 'site.config.ts'),
    `// Auto-generated by convert-html-to-astro.mjs\n` +
    `export const siteConfig = ${JSON.stringify(CONFIG, null, 2)} as const;\n`);

  // cms-dump.json copy
  fs.writeFileSync(path.join(CONTENT, 'cms-dump.json'), JSON.stringify(CMS, null, 2));

  // robots.txt — sitemap-aware, allows everything by default
  const siteUrl = (CONFIG.site || `https://${NAME}.com`).replace(/\/+$/, '');
  fs.writeFileSync(path.join(PUBLIC, 'robots.txt'),
    `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap-index.xml\n`);

  // manifest.webmanifest — minimum PWA-friendly metadata
  fs.writeFileSync(path.join(PUBLIC, 'manifest.webmanifest'), JSON.stringify({
    name: CONFIG.title || NAME,
    short_name: NAME,
    description: CONFIG.description || '',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: CONFIG.themeColor || '#ffffff',
    theme_color: CONFIG.themeColor || '#000000',
    // Only declare icons whose intrinsic size is known. favicon.png with
    // sizes:"any" trips browsers ("Resource size is not correct in Manifest").
    // apple-touch-icon is fixed at 180x180 by Apple convention.
    icons: [
      { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  }, null, 2));

  // README — marketplace expects clear setup instructions
  const readme = `# ${CONFIG.title || NAME}

${CONFIG.description || ''}

Astro 5 theme generated from a Webflow export. Static-by-default, content collections (\`md\`/\`mdx\`), Tailwind, sitemap, ClientRouter view transitions, JSON-LD per page-type.

## Quick start

\`\`\`bash
npm install
npm run dev      # http://localhost:4321
npm run build    # → dist/
npm run preview
\`\`\`

## Project structure

\`\`\`
src/
  components/    SEO, SiteHeader, SiteFooter
  content/       Astro 5 typed collections (mdx)
  content.config.ts
  layouts/       BaseLayout (SEO + ClientRouter wired)
  pages/         routes — static + dynamic [slug] per collection
  styles/        custom.css (theme) + tailwind.css (utility)
  site.config.ts site metadata exposed to components
public/
  assets/images  CDN images referenced by absolute paths
  assets/js      jQuery + webflow.js (UI interactions)
  fonts          @font-face sources
  favicon.*  manifest.webmanifest  robots.txt
\`\`\`

## Configuration

Edit the project root \`project.config.json\` and re-run \`node build.js --only=astro\` to regenerate this folder. Values:

- \`name\`, \`site\`, \`title\`, \`description\` — site identity
- \`lang\` (default \`en\`), \`themeColor\`, \`locale\` — i18n + branding
- \`social.twitter\`, \`social.ogImage\` — social cards
- \`lcpClasses\` — class names whose images get \`fetchpriority=high\`
- \`keepWebflowJs\` — keep jQuery + webflow.js (set \`false\` once interactions are ported)

## License

MIT — see \`LICENSE\`.
`;
  fs.writeFileSync(path.join(TARGET, 'README.md'), readme);

  // LICENSE — MIT default (override via CONFIG.license)
  const year = new Date().getFullYear();
  const author = CONFIG.author || NAME;
  const licenseText = (CONFIG.license === 'commercial')
    ? `Copyright (c) ${year} ${author}. All rights reserved.\n\nCommercial license — see https://${NAME}.com for terms.\n`
    : `MIT License\n\nCopyright (c) ${year} ${author}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.\n`;
  fs.writeFileSync(path.join(TARGET, 'LICENSE'), licenseText);
}

// ─── COPY ASSETS + STYLES ─────────────────────────────────────────────────────
function copyAssets() {
  log(`\n📁 Copying assets...`);

  // Images: public/assets/images/ only — pages reference them via direct /assets/images/ paths.
  // (Mirroring into src/assets/images/ doubled disk footprint without being imported anywhere;
  // re-enable if/when pages migrate to <Image src={import('~/assets/...')} />.)
  const imgSrc = path.join(SOURCE, 'images');
  if (fs.existsSync(imgSrc)) {
    copyDir(imgSrc, path.join(PUB_ASSETS, 'images'));
    log(`   ✓ images → public/assets/images/`);
  }

  // JS: public/assets/js/ (served as /assets/js/...)
  const jsSrc = path.join(SOURCE, 'js');
  const pubJs = path.join(PUB_ASSETS, 'js');
  if (fs.existsSync(jsSrc)) {
    copyDir(jsSrc, pubJs);
    log(`   ✓ js → public/assets/js/`);
  } else {
    ensureDir(pubJs);
  }
  // keepWebflowJs:true (default) ships the MIT-licensed webflow.js bundle
  // alongside site-ui.js for pixel-perfect IX2 + slider/tabs/dropdown/nav.
  // keepWebflowJs:false drops it (vanilla mode = site-ui.js only, no IX2).
  const KEEP_WF = CONFIG.keepWebflowJs !== false;
  const pubWf   = path.join(pubJs, 'webflow.js');
  const repoWf  = path.join(ROOT, 'webflow.js');
  if (!KEEP_WF) {
    if (fs.existsSync(pubWf)) { fs.rmSync(pubWf); log(`   ✓ removed public/assets/js/webflow.js (keepWebflowJs:false)`); }
  } else {
    if (!fs.existsSync(pubWf) && fs.existsSync(repoWf)) {
      fs.copyFileSync(repoWf, pubWf);
      log(`   ✓ webflow.js → public/assets/js/  (MIT-licensed Webflow runtime)`);
    }
  }
  // Stage site-ui.js into public/assets/js/ (sourced from repo root so a
  // future fresh build still gets it after `src/public` are wiped).
  const uiSrcRoot = path.join(ROOT, 'site-ui.js');
  const uiSrcAlt  = path.join(ROOT, 'astro-' + NAME, 'public', 'assets', 'js', 'site-ui.js');
  const uiSrc     = fs.existsSync(uiSrcRoot) ? uiSrcRoot : (fs.existsSync(uiSrcAlt) ? uiSrcAlt : null);
  if (uiSrc) {
    fs.copyFileSync(uiSrc, path.join(pubJs, 'site-ui.js'));
    log(`   ✓ site-ui.js → public/assets/js/`);
  }
  // Stage jQuery from repo (or astro-prolio cache) into public/assets/js/.
  const jqSrcRoot = path.join(ROOT, 'jquery.min.js');
  const jqSrcAlt  = path.join(ROOT, 'astro-' + NAME, 'public', 'assets', 'js', 'jquery.min.js');
  const jqSrc     = fs.existsSync(jqSrcRoot) ? jqSrcRoot : (fs.existsSync(jqSrcAlt) ? jqSrcAlt : null);
  if (jqSrc && CONFIG.loadJquery !== false) {
    fs.copyFileSync(jqSrc, path.join(pubJs, 'jquery.min.js'));
    log(`   ✓ jquery.min.js → public/assets/js/`);
  }

  // Fonts: public/fonts/ (served as /fonts/... — matches CSS @font-face after rewrite)
  const fontsSrc = path.join(SOURCE, 'fonts');
  if (fs.existsSync(fontsSrc)) {
    copyDir(fontsSrc, path.join(PUBLIC, 'fonts'));
    log(`   ✓ fonts → public/fonts/`);
  }

  // CSS:
  //   • custom.css → src/styles/  (imported via BaseLayout → Vite processes @import / asset URLs)
  //   • tailwind.css → public/styles/  (served as static, bypasses Vite/PostCSS so the
  //     pre-built v3 utility CSS is shipped verbatim — preserves the project-specific
  //     spacing/font/color scale built by transform-tw-v4)
  const cssSrc = path.join(SOURCE, 'css');
  if (fs.existsSync(cssSrc)) {
    const pubStyles = path.join(PUBLIC, 'styles');
    ensureDir(pubStyles);
    for (const f of fs.readdirSync(cssSrc)) {
      const raw = fs.readFileSync(path.join(cssSrc, f), 'utf8');
      const rewritten = rewriteCssAssetPaths(raw);
      if (f === 'tailwind.css') {
        fs.writeFileSync(path.join(pubStyles, f), rewritten);
      } else {
        fs.writeFileSync(path.join(STYLES, f), rewritten);
      }
    }
    log(`   ✓ custom.css → src/styles/   tailwind.css → public/styles/  (asset paths rewritten)`);
  }

  // Favicon best-effort
  for (const f of ['favicon.ico','favicon.png','apple-touch-icon.png']) {
    const src = path.join(SOURCE, 'images', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(PUBLIC, f));
  }
}

// ─── COMPONENTS ──────────────────────────────────────────────────────────────
function writeSeoComponent() {
  const code = `---
// Auto-generated by convert-html-to-astro.mjs
import { siteConfig } from '../site.config.ts';

export interface Props {
  title: string;
  description?: string;
  image?: string;
  noindex?: boolean;
  wfPage?: string;
  wfSite?: string;
  pageType?: 'website' | 'article' | 'service' | 'collection' | 'contact' | 'about';
  jsonLdExtra?: Record<string, unknown>;
  publishedTime?: string;
  modifiedTime?: string;
  author?: string;
}

const {
  title,
  description = siteConfig.description,
  image = siteConfig.social?.ogImage || '/og-default.webp',
  noindex = false,
  pageType = 'website',
  jsonLdExtra,
  publishedTime,
  modifiedTime,
  author,
} = Astro.props;

const canonical = new URL(Astro.url.pathname, Astro.site).href;
const ogImage   = new URL(image, Astro.site).href;
const locale    = (siteConfig as any).locale ?? 'en_US';

const ld: Record<string, unknown> = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  url: canonical,
  name: title,
  description,
  inLanguage: locale.replace('_', '-'),
  isPartOf: { '@type': 'WebSite', name: siteConfig.title, url: siteConfig.site },
};
if (pageType === 'article') {
  ld['@type'] = 'BlogPosting';
  ld.headline = title;
  ld.image = ogImage;
  if (publishedTime) ld.datePublished = publishedTime;
  if (modifiedTime)  ld.dateModified  = modifiedTime;
  if (author)        ld.author = { '@type': 'Person', name: author };
}
if (pageType === 'service')    ld['@type'] = 'Service';
if (pageType === 'collection') ld['@type'] = 'CollectionPage';
if (pageType === 'contact')    ld['@type'] = 'ContactPage';
if (pageType === 'about')      ld['@type'] = 'AboutPage';

const jsonLd = jsonLdExtra ? { ...ld, ...jsonLdExtra } : ld;
---

<title>{title}</title>
<meta name="description" content={description} />
<meta name="generator" content={Astro.generator} />
<link rel="canonical" href={canonical} />
<meta name="robots" content={noindex ? 'noindex,nofollow' : 'index,follow,max-image-preview:large'} />

<meta property="og:title" content={title} />
<meta property="og:description" content={description} />
<meta property="og:url" content={canonical} />
<meta property="og:image" content={ogImage} />
<meta property="og:type" content={pageType === 'article' ? 'article' : 'website'} />
<meta property="og:site_name" content={siteConfig.title} />
<meta property="og:locale" content={locale} />
{publishedTime && <meta property="article:published_time" content={publishedTime} />}
{modifiedTime  && <meta property="article:modified_time"  content={modifiedTime} />}

<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content={title} />
<meta name="twitter:description" content={description} />
<meta name="twitter:image" content={ogImage} />
{siteConfig.social?.twitter && <meta name="twitter:site" content={siteConfig.social.twitter} />}
{siteConfig.social?.twitter && <meta name="twitter:creator" content={siteConfig.social.twitter} />}

<script type="application/ld+json" set:html={JSON.stringify(jsonLd)} />
`;
  fs.writeFileSync(path.join(COMPONENTS, 'SEO.astro'), code);
}

function writeBaseLayout() {
  const lang       = CONFIG.lang || 'en';
  const themeColor = CONFIG.themeColor || '#000000';
  const code = `---
// Auto-generated by convert-html-to-astro.mjs
import SEO          from '../components/SEO.astro';
import SiteHeader   from '../components/SiteHeader.astro';
import SiteFooter   from '../components/SiteFooter.astro';
import { ClientRouter } from 'astro:transitions';
import '../styles/custom.css';
// Note: tailwind.css is the pre-built TW v3 utility CSS from transform-tw-v4 —
// served as a static asset from public/styles/ (linked via <link> below) so its
// project-tuned spacing/font/color scale ships verbatim. Bypasses Vite/PostCSS
// to avoid double-emit and @layer parsing errors.

export interface Props {
  title: string;
  description?: string;
  image?: string;
  noindex?: boolean;
  wfPage?: string;
  wfSite?: string;
  pageType?: 'website' | 'article' | 'service' | 'collection' | 'contact' | 'about';
  jsonLdExtra?: Record<string, unknown>;
  publishedTime?: string;
  modifiedTime?: string;
  author?: string;
}

const KEEP_WEBFLOW_JS = ${JSON.stringify(CONFIG.keepWebflowJs ?? true)};
const LOAD_JQUERY     = ${JSON.stringify(CONFIG.loadJquery ?? true)};
const UI_SCRIPT       = ${JSON.stringify(CONFIG.uiScript ?? '/assets/js/site-ui.js')};
const seoProps = Astro.props;
const wfPage = Astro.props.wfPage || '';
const wfSite = Astro.props.wfSite || '';
---

<!DOCTYPE html>
<html lang=${JSON.stringify(lang)} data-wf-page={wfPage || undefined} data-wf-site={wfSite || undefined}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <meta name="theme-color" content=${JSON.stringify(themeColor)} />
    <meta name="format-detection" content="telephone=no" />
    <link rel="icon" type="image/x-icon" href="/favicon.ico" />
    <link rel="icon" type="image/png" href="/favicon.png" sizes="any" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="sitemap" href="/sitemap-index.xml" />
    <link rel="stylesheet" href="/styles/tailwind.css" />
    <ClientRouter />
    <SEO {...seoProps} />
    <slot name="head" />
  </head>
  <body>
    <a href="#main" class="sr-only focus:not-sr-only">Skip to main content</a>
    <SiteHeader />
    <main id="main">
      <slot />
    </main>
    <SiteFooter />
    {LOAD_JQUERY && (
      <script src="/assets/js/jquery.min.js" is:inline defer></script>
    )}
    {KEEP_WEBFLOW_JS && (
      <script src="/assets/js/webflow.js" is:inline defer></script>
    )}
    {UI_SCRIPT && (
      <script src={UI_SCRIPT} is:inline defer></script>
    )}
  </body>
</html>
`;
  fs.writeFileSync(path.join(LAYOUTS, 'BaseLayout.astro'), code);
}

async function writeHeaderFooter() {
  // Pick a canonical page that has BOTH <header> and <footer>.
  const candidates = ['about.html', 'contact.html', homePromoteRel, 'index.html'];
  let canonical = null;
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(SOURCE, c))) {
      const html = fs.readFileSync(path.join(SOURCE, c), 'utf8');
      if (html.includes('<header') && html.includes('<footer')) { canonical = c; break; }
    }
  }
  if (!canonical) {
    log('   ⚠ no canonical page with header+footer — emitting empty stubs');
    fs.writeFileSync(path.join(COMPONENTS, 'SiteHeader.astro'), `---\n---\n<header></header>\n`);
    fs.writeFileSync(path.join(COMPONENTS, 'SiteFooter.astro'), `---\n---\n<footer></footer>\n`);
    return;
  }
  const html = fs.readFileSync(path.join(SOURCE, canonical), 'utf8');
  const { header, footer } = splitParts(extractBody(html));

  for (const [name, raw] of [['SiteHeader', header], ['SiteFooter', footer]]) {
    if (!raw) continue;
    const processed = await processFragment(raw);
    const code = `---\n// Auto-generated from ${canonical}\n---\n\n${processed}\n`;
    fs.writeFileSync(path.join(COMPONENTS, `${name}.astro`), code);
    log(`   ✓ components/${name}.astro  (from ${canonical})`);
  }
}

// ─── PAGE EMITTERS ───────────────────────────────────────────────────────────
function extractWfIds(html) {
  return {
    wfPage: (html.match(/<html\b[^>]*\bdata-wf-page="([^"]+)"/i)?.[1] || '').trim(),
    wfSite: (html.match(/<html\b[^>]*\bdata-wf-site="([^"]+)"/i)?.[1] || '').trim(),
  };
}

async function emitStaticPage(rel, destRel, opts = {}) {
  const html = fs.readFileSync(path.join(SOURCE, rel), 'utf8');
  const body = extractBody(html);
  const { content } = splitParts(body);
  const title       = opts.title       || extractTitle(html) || CONFIG.title;
  const description = opts.description || extractDesc(html)  || CONFIG.description;
  const { wfPage, wfSite } = extractWfIds(html);

  const processed = await processFragment(content);

  const pagePath = path.join(PAGES, destRel);
  ensureDir(path.dirname(pagePath));

  const noindexAttr = opts.noindex ? `\n  noindex={true}` : '';
  const pageType = opts.pageType || 'website';
  const wfAttrs = (wfPage || wfSite)
    ? `\n  wfPage='${escAttr(wfPage)}'\n  wfSite='${escAttr(wfSite)}'`
    : '';

  const code = `---
import BaseLayout from '${relImport(pagePath, path.join(LAYOUTS, 'BaseLayout.astro'))}';
---

<BaseLayout
  title='${escAttr(title)}'
  description='${escAttr(description)}'
  pageType='${pageType}'${noindexAttr}${wfAttrs}
>
${processed}
</BaseLayout>
`;
  fs.writeFileSync(pagePath, code);
  log(`   ✓ pages/${posix(destRel)}`);
}

// MDX-safe escape — `{` and `}` open JSX expressions in MDX, so encode them.
// Also self-close every HTML void element (img/br/hr/input/etc.) — MDX uses an
// XHTML-strict parser and rejects bare `<img src="...">` without the trailing slash.
const VOID_ELEMENTS = ['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr'];
const VOID_RX = new RegExp(
  `<(${VOID_ELEMENTS.join('|')})\\b([^>]*?)(?<!/)>`,
  'gi'
);
function selfCloseVoid(html) {
  return html.replace(VOID_RX, (_m, tag, attrs) => `<${tag}${attrs} />`);
}

function mdxEscapeBody(html) {
  // MDX's mdast parser ends paragraphs on blank lines and trips on multi-line
  // raw HTML (esp. multi-line <svg>). Flatten all newlines + collapse runs of
  // whitespace so each fragment is a single line of HTML.
  const flattened = html.replace(/\s*\r?\n\s*/g, ' ').replace(/  +/g, ' ');
  return selfCloseVoid(flattened)
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;');
}

// YAML-safe scalar — single-line strings only; CMS title/description never contain newlines.
function yamlStr(s) {
  return JSON.stringify(String(s ?? ''));
}

async function emitCollection(col, items) {
  const dir = path.join(PAGES, col);
  ensureDir(dir);

  // Detail .mdx files → src/content/{col}/{slug}.mdx (frontmatter + sanitized HTML body)
  const colContentDir = path.join(CONTENT, col);
  ensureDir(colContentDir);
  let written = 0;
  for (const item of items) {
    const detailSrc = path.join(SOURCE, item.outRel);
    if (!fs.existsSync(detailSrc)) continue;
    const html = fs.readFileSync(detailSrc, 'utf8');
    const { content } = splitParts(extractBody(html));
    const processed = await processFragment(content);
    const safeBody = mdxEscapeBody(processed);
    const fmLines = [
      '---',
      `title: ${yamlStr(item.title)}`,
      `description: ${yamlStr(item.description)}`,
      `slug: ${yamlStr(item.slug)}`,
    ];
    if (item.image)    fmLines.push(`image: ${yamlStr(normalizeImgSrc(item.image))}`);
    if (item.date)     fmLines.push(`date: ${yamlStr(item.date)}`);
    if (item.author)   fmLines.push(`author: ${yamlStr(item.author)}`);
    if (item.category) fmLines.push(`category: ${yamlStr(item.category)}`);
    if (Array.isArray(item.tags) && item.tags.length) {
      fmLines.push('tags:');
      for (const t of item.tags) fmLines.push(`  - ${yamlStr(t)}`);
    }
    fmLines.push('---', '');
    const fm = fmLines.join('\n');
    fs.writeFileSync(path.join(colContentDir, `${item.slug}.mdx`), fm + safeBody + '\n');
    written++;
  }
  log(`   ✓ content/${col}/  (${written} mdx entries)`);

  // List index.astro (from listMapRef[col] if found)
  const listRel = listMapRef[col];
  if (listRel && fs.existsSync(path.join(SOURCE, listRel))) {
    const html = fs.readFileSync(path.join(SOURCE, listRel), 'utf8');
    const { content } = splitParts(extractBody(html));
    const title = extractTitle(html) || `${col} | ${CONFIG.title}`;
    const description = extractDesc(html) || CONFIG.description;
    const { wfPage, wfSite } = extractWfIds(html);
    const processed = await processFragment(content);

    const indexPath = path.join(dir, 'index.astro');
    const wfAttrs = (wfPage || wfSite)
      ? `\n  wfPage='${escAttr(wfPage)}'\n  wfSite='${escAttr(wfSite)}'`
      : '';
    const code = `---
import BaseLayout from '${relImport(indexPath, path.join(LAYOUTS, 'BaseLayout.astro'))}';
---

<BaseLayout
  title='${escAttr(title)}'
  description='${escAttr(description)}'
  pageType='collection'${wfAttrs}
>
${processed}
</BaseLayout>
`;
    fs.writeFileSync(indexPath, code);
    log(`   ✓ pages/${col}/index.astro  (list, from ${listRel})`);
  } else {
    log(`   ⚠ pages/${col}/index.astro NOT emitted (no list page detected)`);
  }

  // [slug].astro — Astro 5 content collections (getCollection + render)
  const pageType =
    col === 'post'              ? 'article' :
    col === 'service'           ? 'service' :
    col === 'blog-categories'   ? 'collection' : 'website';

  // Pull wfPage/wfSite from any CMS item HTML (all items in a collection share
  // the detail-template page ID — Webflow generates one IX2 binding for the
  // template, applied per slug).
  let detailWfPage = '', detailWfSite = '';
  for (const item of items) {
    const itemSrc = path.join(SOURCE, item.outRel);
    if (fs.existsSync(itemSrc)) {
      const itemHtml = fs.readFileSync(itemSrc, 'utf8');
      const ids = extractWfIds(itemHtml);
      if (ids.wfPage) { detailWfPage = ids.wfPage; detailWfSite = ids.wfSite; break; }
    }
  }

  const slugPath = path.join(dir, '[slug].astro');
  const wfAttrs = (detailWfPage || detailWfSite)
    ? `\n  wfPage='${escAttr(detailWfPage)}'\n  wfSite='${escAttr(detailWfSite)}'`
    : '';
  const code = `---
import BaseLayout from '${relImport(slugPath, path.join(LAYOUTS, 'BaseLayout.astro'))}';
import { getCollection, render } from 'astro:content';

export async function getStaticPaths() {
  const entries = await getCollection(${JSON.stringify(col)});
  return entries.map((entry) => ({
    params: { slug: entry.data.slug ?? entry.id },
    props:  { entry },
  }));
}

const { entry } = Astro.props;
const { Content } = await render(entry);
---

<BaseLayout
  title={entry.data.title}
  description={entry.data.description ?? ''}
  pageType='${pageType}'${wfAttrs}
>
  <article>
    <Content />
  </article>
</BaseLayout>
`;
  fs.writeFileSync(slugPath, code);
  log(`   ✓ pages/${col}/[slug].astro  (${items.length} routes via content collection)`);
}

// Generate src/content.config.ts with one defineCollection per detected col.
function writeContentConfig(collectionNames) {
  if (!collectionNames.length) return;
  const lines = [
    `// Auto-generated by convert-html-to-astro.mjs`,
    `import { defineCollection, z } from 'astro:content';`,
    `import { glob } from 'astro/loaders';`,
    ``,
    `const baseSchema = z.object({`,
    `  title: z.string(),`,
    `  description: z.string().optional().default(''),`,
    `  image: z.string().optional(),`,
    `  date: z.coerce.date().optional(),`,
    `  author: z.string().optional(),`,
    `  category: z.string().optional(),`,
    `  tags: z.array(z.string()).optional(),`,
    `  slug: z.string().optional(),`,
    `});`,
    ``,
  ];
  const entries = [];
  for (const col of collectionNames) {
    const ident = col.replace(/[^a-zA-Z0-9]/g, '_');
    lines.push(
      `const ${ident} = defineCollection({`,
      `  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/${col}' }),`,
      `  schema: baseSchema,`,
      `});`,
      ``
    );
    entries.push(`  ${JSON.stringify(col)}: ${ident},`);
  }
  lines.push(`export const collections = {`, ...entries, `};`, ``);
  fs.writeFileSync(path.join(SRC, 'content.config.ts'), lines.join('\n'));
  log(`   ✓ src/content.config.ts  (${collectionNames.length} collections registered)`);
}

// ─── COLLECTION DETECTION ────────────────────────────────────────────────────
function detectCollections(allRels) {
  const collections = {};
  for (const [k, items] of Object.entries(CMS.collections || {})) {
    if (k === 'home') continue; // home pages handled separately
    if (!items?.length) continue;
    collections[k] = items;
  }

  const listMap = {};
  const altMap  = {};
  const rootRels = allRels.filter(r => !r.includes('/'));

  // List page heuristic: count detail-link occurrences (nav menus only have ONE
  // link per collection; CMS w-dyn-list blocks emit one <a> per item — usually
  // 3+). Page with the most matches wins; needs ≥2 to qualify.
  const htmlCache = new Map();
  function readRoot(p) {
    if (!htmlCache.has(p)) htmlCache.set(p, fs.readFileSync(path.join(SOURCE, p), 'utf8'));
    return htmlCache.get(p);
  }

  for (const col of Object.keys(collections)) {
    const linkPat = new RegExp(`href="(?:\\.\\.\\/|/)*${col}\\/[^"#?]+\\.html"`, 'g');
    const counts  = rootRels.map(p => [p, (readRoot(p).match(linkPat) || []).length]);
    counts.sort((a, b) => b[1] - a[1]);
    const [best, bestCount] = counts[0] || [null, 0];
    if (!best || bestCount < 2) continue;

    listMap[col] = best;

    // Alt-layout: if list page name matches *-one.html (or *-1.html), look for *-two sibling.
    const oneM = best.match(/^(.+)-(?:one|1)\.html$/);
    if (oneM) {
      const altCandidate = `${oneM[1]}-two.html`;
      const alt2Candidate = `${oneM[1]}-2.html`;
      if (rootRels.includes(altCandidate))      altMap[col] = altCandidate;
      else if (rootRels.includes(alt2Candidate)) altMap[col] = alt2Candidate;
    }
  }

  // Two collections may map to the same list page when the source has only one
  // list per pair (e.g. works-one renders both project + post links). Resolve
  // by giving the page to the collection with the highest count for it.
  const usedListRels = new Map(); // listRel → col
  for (const [col, rel] of Object.entries(listMap)) {
    if (!usedListRels.has(rel)) { usedListRels.set(rel, col); continue; }
    const prevCol = usedListRels.get(rel);
    const linkPat = (c) => new RegExp(`href="(?:\\.\\.\\/|/)*${c}\\/[^"#?]+\\.html"`, 'g');
    const html = readRoot(rel);
    const prevCount = (html.match(linkPat(prevCol)) || []).length;
    const curCount  = (html.match(linkPat(col))     || []).length;
    if (curCount > prevCount) {
      delete listMap[prevCol];
      delete altMap[prevCol];
      usedListRels.set(rel, col);
    } else {
      delete listMap[col];
      delete altMap[col];
    }
  }
  return { collections, listMap, altMap };
}

// ─── SKIP RULES ──────────────────────────────────────────────────────────────
function isSkipped(rel) {
  if (rel === 'index.html') return true; // landing showcase
  // Webflow exports CMS-detail templates as `detail_{collection}.html` —
  // they're per-template stubs, not real routes. The dynamic [slug].astro
  // handles all collection detail rendering.
  if (path.basename(rel).startsWith('detail_')) return true;
  for (const sp of (CONFIG.skipPaths || [])) {
    const p = sp.replace(/^\/+/, '').replace(/\/+$/, '');
    if (rel === `${p}.html` || rel.startsWith(`${p}/`)) return true;
  }
  return false;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async function main() {
  log(`\n🚀 convert-html-to-astro — project "${NAME}"`);
  log(`   SOURCE: ${posix(path.relative(ROOT, SOURCE))}`);
  log(`   TARGET: ${posix(path.relative(ROOT, TARGET))}`);

  bootstrapAstro();
  copyAssets();

  log(`\n🎨 Writing Astro shells...`);
  writeSeoComponent();
  writeBaseLayout();
  await writeHeaderFooter();

  // Collect all source HTML files + detect collections + list/alt mapping.
  const allRels = walkHtml(SOURCE);
  const { collections, listMap, altMap } = detectCollections(allRels);
  listMapRef = listMap;
  altMapRef  = altMap;

  log(`\n📚 Collections detected: ${Object.keys(collections).join(', ') || '(none)'}`);
  for (const col of Object.keys(collections)) {
    log(`     • ${col}: list=${listMap[col] || '?'} alt=${altMap[col] || '-'} (${collections[col].length} items)`);
  }

  const consumedListRels = new Set(Object.values(listMap));
  const consumedAltRels  = new Set(Object.values(altMap));

  log(`\n📄 Emitting static pages...`);
  for (const rel of allRels) {
    if (isSkipped(rel)) continue;

    // Home promotion: home/home-one.html → index.astro
    if (rel === homePromoteRel) {
      await emitStaticPage(rel, 'index.astro');
      continue;
    }

    // Sibling home variants: home/home-two.html → home-two.astro (flattened).
    if (rel.startsWith('home/') && rel !== homePromoteRel) {
      const flatName = path.basename(rel, '.html') + '.astro';
      await emitStaticPage(rel, flatName);
      continue;
    }

    // Detail page in a known collection — handled by emitCollection
    const segs = rel.split('/');
    if (segs.length >= 2 && collections[segs[0]]) continue;

    // List page consumed by collection — skip (becomes {col}/index.astro)
    if (consumedListRels.has(rel)) continue;

    // Alt-layout page → standalone route
    if (consumedAltRels.has(rel)) {
      const destRel = rel.replace(/\.html$/, '.astro');
      await emitStaticPage(rel, destRel);
      continue;
    }

    // Generic static page
    const baseName = path.basename(rel, '.html');
    const pageType =
      baseName === 'about'   ? 'about'   :
      baseName === 'contact' ? 'contact' : 'website';
    const noindex = ['401','404'].includes(baseName);

    const destRel = baseName === '404' ? '404.astro' : rel.replace(/\.html$/, '.astro');
    await emitStaticPage(rel, destRel, { pageType, noindex });
  }

  log(`\n🗂  Emitting collections...`);
  writeContentConfig(Object.keys(collections));
  for (const [col, items] of Object.entries(collections)) {
    await emitCollection(col, items);
  }

  log(`\n✅ Astro project ready at ${posix(path.relative(ROOT, TARGET))}/`);
  log(`   cd ${posix(path.relative(ROOT, TARGET))} && npm install && npm run dev\n`);
})().catch(e => { console.error(e); process.exit(1); });
