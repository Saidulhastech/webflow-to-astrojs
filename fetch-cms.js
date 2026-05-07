/**
 * fetch-cms.js
 *
 * Multi-project Webflow site mirror.
 *
 * Reads project.config.json → resolves SITE = https://{name}.webflow.io
 * → fetches sitemap.xml → enumerates URLs → applies skipPaths + homePromote
 * → downloads each page + every CDN image → rewrites internal links via
 * URL→outRel map (no per-collection regex anywhere).
 *
 * Emits {name}.webflow/ folder (consumed by transform-tw-v4 etc.) AND
 * cms-dump.json (consumed by convert-html-to-astro for dynamic routes).
 */

const fs   = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const sharp   = require('sharp');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'project.config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`fetch-cms.js: project.config.json not found at ${CONFIG_PATH}`);
  process.exit(1);
}
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
if (!CONFIG.name) {
  console.error('fetch-cms.js: project.config.json must define "name"');
  process.exit(1);
}

const NAME         = CONFIG.name;
// Host is resolved at runtime via resolveSite() — some Webflow templates
// publish at "{name}-template.webflow.io" instead of "{name}.webflow.io",
// so we probe both before failing. SITE / EFFECTIVE_HOST are mutated by
// resolveSite() and read by the link rewriter + crawler.
let EFFECTIVE_HOST = `${NAME}.webflow.io`;
let SITE           = `https://${EFFECTIVE_HOST}`;
const OUT          = path.join(__dirname, `${NAME}.webflow`);
const SKIP_PATHS   = Array.isArray(CONFIG.skipPaths) ? CONFIG.skipPaths : [];
const HOME_PROMOTE = (CONFIG.homePromote || '').replace(/^\/+|\/+$/g, '') || null; // "home/home-one"
const EXTRA_PAGES  = Array.isArray(CONFIG.extraPages) ? CONFIG.extraPages : [];

const downloadedImages = new Map(); // remoteUrl → localFileName

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function log(msg)     { process.stdout.write(msg + '\n'); }

async function fetchText(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.text();
}

async function fetchBuffer(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

function safeFileName(url) {
  // Webflow CDN URLs look like:
  //   .../67839d3ebd2c1504a5c14932_og-image.webp
  //   .../67839d3ebd2c1504a5c14932_og-image-p-2000.webp  (responsive variant)
  //   .../66bc51a5c08ca51ab9bd0a94_Intro Image.png        (literal spaces!)
  // Drop the -p-{N} suffix and replace any whitespace with `_` so
  // srcset/href parsing in the browser doesn't split on it.
  const tail = decodeURIComponent(url.split('/').pop() || 'image').split('?')[0];
  return tail.replace(/-p-\d+(?=\.[a-z0-9]+$)/i, '').replace(/\s+/g, '_');
}

async function optimize(buf, outPath) {
  const ext = path.extname(outPath).toLowerCase();
  if (ext === '.svg' || ext === '.gif') {
    fs.writeFileSync(outPath, buf);
    return;
  }
  try {
    let img = sharp(buf, { failOn: 'none' });
    if (ext === '.png')        img = img.png({ compressionLevel: 9, palette: true });
    else if (ext === '.webp')  img = img.webp({ quality: 82 });
    else if (ext === '.avif')  img = img.avif({ quality: 60 });
    else                       img = img.jpeg({ quality: 82, mozjpeg: true });
    const out = await img.toBuffer();
    fs.writeFileSync(outPath, out.length < buf.length ? out : buf);
  } catch {
    fs.writeFileSync(outPath, buf);
  }
}

async function downloadImage(url) {
  if (downloadedImages.has(url)) return downloadedImages.get(url);
  const fileName = safeFileName(url);
  const localPath = path.join(OUT, 'images', fileName);
  if (!fs.existsSync(localPath)) {
    try {
      const buf = await fetchBuffer(url);
      ensureDir(path.dirname(localPath));
      await optimize(buf, localPath);
      log(`   ↓ ${fileName}`);
    } catch (e) {
      log(`   ✗ ${url} (${e.message})`);
      downloadedImages.set(url, null);
      return null;
    }
  }
  downloadedImages.set(url, fileName);
  return fileName;
}

function isCdnImage(u) {
  if (!u) return false;
  if (u.startsWith('data:')) return false;
  return /^https?:\/\//.test(u) && /\.(png|jpg|jpeg|gif|webp|avif|svg)(\?|$)/i.test(u);
}

function isCdnVideo(u) {
  if (!u) return false;
  if (u.startsWith('data:')) return false;
  return /^https?:\/\//.test(u) && /\.(mp4|webm|mov|m4v)(\?|$)/i.test(u);
}

// Mirror of downloadImage but writes to videos/ instead of images/.
const downloadedVideos = new Map();
async function downloadVideo(url) {
  if (!url) return null;
  if (downloadedVideos.has(url)) return downloadedVideos.get(url);
  const fileName = safeFileName(url);
  const localPath = path.join(OUT, 'videos', fileName);
  if (!fs.existsSync(localPath)) {
    try {
      const buf = await fetchBuffer(url);
      ensureDir(path.dirname(localPath));
      fs.writeFileSync(localPath, buf);
      log(`   ↓ videos/${fileName}`);
    } catch (e) {
      log(`   ✗ video ${url} (${e.message})`);
      downloadedVideos.set(url, null);
      return null;
    }
  }
  downloadedVideos.set(url, fileName);
  return fileName;
}

async function localizeImages(html, outRel) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const depth = outRel.split('/').length - 1;
  const prefix = depth > 0 ? '../'.repeat(depth) : '';

  async function rewriteUrl(u) {
    if (!isCdnImage(u)) return u;
    const local = await downloadImage(u);
    return local ? `${prefix}images/${local}` : u;
  }

  const targets = [
    'img[src]', 'source[src]',
    'link[rel="icon"]', 'link[rel="shortcut icon"]', 'link[rel="apple-touch-icon"]',
    'meta[property="og:image"]', 'meta[property="og:image:secure_url"]',
    'meta[property="twitter:image"]', 'meta[name="twitter:image"]',
    'meta[property="og:image:url"]',
  ];
  for (const el of $(targets.join(', ')).toArray()) {
    const $el = $(el);
    const tag = el.tagName.toLowerCase();
    const attr = (tag === 'meta') ? 'content' : (tag === 'link' ? 'href' : 'src');
    const u = $el.attr(attr);
    const local = await rewriteUrl(u);
    if (local !== u) $el.attr(attr, local);
  }

  // srcset (img + source)
  for (const el of $('img[srcset], source[srcset]').toArray()) {
    const $el = $(el);
    const srcset = $el.attr('srcset') || '';
    const parts = srcset.split(',').map(s => s.trim()).filter(Boolean);
    const newParts = [];
    for (const p of parts) {
      const [u, ...rest] = p.split(/\s+/);
      const local = await rewriteUrl(u);
      newParts.push([local, ...rest].join(' '));
    }
    $el.attr('srcset', newParts.join(', '));
  }

  // background-image inline styles
  for (const el of $('[style*="url("]').toArray()) {
    const $el = $(el);
    let style = $el.attr('style') || '';
    const matches = [...style.matchAll(/url\((['"]?)(https?:[^)'"]+)\1\)/g)];
    for (const m of matches) {
      const u = m[2];
      const local = await rewriteUrl(u);
      if (local !== u) style = style.split(m[0]).join(`url(${m[1]}${local}${m[1]})`);
    }
    $el.attr('style', style);
  }

  // Webflow background-video atom: <div data-poster-url="..." data-video-urls="mp4,webm">
  // and <video><source src="https://cdn..."> — neither is in `targets` above.
  for (const el of $('[data-poster-url]').toArray()) {
    const $el = $(el);
    const u = $el.attr('data-poster-url');
    if (!u) continue;
    // Decode %2F before isCdnImage check (Webflow encodes site-id boundary).
    const decoded = u.replace(/%2F/gi, '/');
    if (isCdnImage(decoded)) {
      const local = await downloadImage(decoded);
      if (local) $el.attr('data-poster-url', `${prefix}images/${local}`);
    }
  }
  for (const el of $('[data-video-urls]').toArray()) {
    const $el = $(el);
    const raw = $el.attr('data-video-urls') || '';
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
    const out = [];
    for (const u of parts) {
      const decoded = u.replace(/%2F/gi, '/');
      if (isCdnVideo(decoded)) {
        const local = await downloadVideo(decoded);
        out.push(local ? `${prefix}videos/${local}` : u);
      } else {
        out.push(u);
      }
    }
    $el.attr('data-video-urls', out.join(','));
  }
  for (const el of $('source[src], video[src]').toArray()) {
    const $el = $(el);
    const u = $el.attr('src');
    if (!u) continue;
    const decoded = u.replace(/%2F/gi, '/');
    if (isCdnVideo(decoded)) {
      const local = await downloadVideo(decoded);
      if (local) $el.attr('src', `${prefix}videos/${local}`);
    }
  }

  return $.html();
}

// ─── URL → outRel ─────────────────────────────────────────────────────────────
function urlToOutRel(urlPath) {
  const p = urlPath.replace(/^\/+|\/+$/g, '');
  if (!p) return 'index.html';
  return `${p}.html`;
}

function shouldSkip(urlPath) {
  for (const skip of SKIP_PATHS) {
    if (skip === urlPath) return true;
    if (skip.endsWith('/') && (urlPath === skip.replace(/\/$/, '') || urlPath.startsWith(skip))) return true;
    if (urlPath === skip || urlPath.startsWith(skip + '/')) return true;
  }
  return false;
}

// ─── HOST RESOLUTION ──────────────────────────────────────────────────────────
// Try the canonical "{name}.webflow.io" first; if its sitemap 404s, retry with
// the "{name}-template.webflow.io" variant Webflow uses for marketplace
// templates. Mutates SITE + EFFECTIVE_HOST in place so the rest of the script
// (asset probe, crawler, link rewriter) picks up the resolved host.
async function resolveSite() {
  // Try the configured name first, then the inverse "-template" variant —
  // either direction:
  //   "arenax"          → also try "arenax-template.webflow.io"
  //   "arenax-template" → also try "arenax.webflow.io"
  const variant = NAME.endsWith('-template')
    ? NAME.replace(/-template$/, '')
    : `${NAME}-template`;
  const candidates = [
    `${NAME}.webflow.io`,
    `${variant}.webflow.io`,
  ];
  let lastErr = null;
  for (const host of candidates) {
    const url = `https://${host}/sitemap.xml`;
    try {
      const r = await fetch(url, { redirect: 'follow' });
      if (r.ok) {
        if (host !== EFFECTIVE_HOST) {
          log(`   ⚠ ${EFFECTIVE_HOST} sitemap 404 — falling back to ${host}`);
        }
        EFFECTIVE_HOST = host;
        SITE = `https://${host}`;
        return;
      }
      lastErr = `${url} → HTTP ${r.status}`;
      log(`   ✗ ${lastErr}`);
    } catch (e) {
      lastErr = `${url} (${e.message})`;
      log(`   ✗ ${lastErr}`);
    }
  }
  console.error(`fetch-cms.js: no reachable sitemap (tried ${candidates.map(h => h + '/sitemap.xml').join(', ')})`);
  process.exit(1);
}

// ─── SITEMAP DISCOVERY ────────────────────────────────────────────────────────
async function fetchSitemapUrls(sitemapUrl) {
  const xml = await fetchText(sitemapUrl);
  const subSitemaps = [...xml.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
  if (subSitemaps.length) {
    const all = [];
    for (const s of subSitemaps) {
      try { all.push(...(await fetchSitemapUrls(s))); }
      catch (e) { log(`   ✗ sub-sitemap ${s} (${e.message})`); }
    }
    return all;
  }
  return [...xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
}

async function discoverUrls() {
  const sitemapUrl = `${SITE}/sitemap.xml`;
  log(`📍 Sitemap: ${sitemapUrl}`);
  let entries;
  try { entries = await fetchSitemapUrls(sitemapUrl); }
  catch (e) {
    console.error(`fetch-cms.js: failed to read sitemap (${e.message})`);
    process.exit(1);
  }
  const paths = [];
  for (const full of entries) {
    let urlPath;
    try {
      const u = new URL(full);
      urlPath = u.pathname.replace(/\/+$/, '') || '/';
    } catch { continue; }
    paths.push(urlPath);
  }
  // Append extras (e.g. /401, /404 — usually absent from sitemap).
  for (const e of EXTRA_PAGES) paths.push(e.replace(/\/+$/, '') || '/');
  return [...new Set(paths)];
}

// ─── INTERNAL LINK REWRITER ───────────────────────────────────────────────────
function buildLinkRewriter(urlMap, currentOutRel) {
  const depth    = currentOutRel.split('/').length - 1;
  const upPrefix = depth > 0 ? '../'.repeat(depth) : '';
  const escapedHost = EFFECTIVE_HOST.replace(/\./g, '\\.');
  const sitePat  = new RegExp(`href="https?:\\/\\/${escapedHost}(\\/[^"]*)?"`, 'g');

  return function rewrite(html) {
    // Strip the project's own webflow.io domain → leave path-only.
    html = html.replace(sitePat, (_m, p) => `href="${p || '/'}"`);

    // href="/foo" / href="/foo/" / href="/" → look up in URL map.
    html = html.replace(/href="\/([^"#?]*)([?#][^"]*)?"/g, (m, body, suffix = '') => {
      const cleanPath = '/' + body.replace(/\/+$/, '');
      const lookup    = (cleanPath === '/' || cleanPath === '') ? '/' : cleanPath;
      const out       = urlMap.get(lookup);
      if (!out) return m;
      return `href="${upPrefix}${out}${suffix}"`;
    });

    // Bare "/" links.
    html = html.replace(/href="\/"/g, () => {
      const out = urlMap.get('/');
      return out ? `href="${upPrefix}${out}"` : 'href="/"';
    });

    // Replace remote CDN CSS + JS bundles with local copies the transform
    // pipeline ships, so the saved page has no remote dependencies.
    html = html
      .replace(/href="https?:\/\/cdn\.prod\.website-files\.com\/[^"]*\/css\/[^"]*\.css"/g,
               `href="${upPrefix}css/${NAME}.webflow.css"`)
      .replace(/src="https?:\/\/cdn\.prod\.website-files\.com\/[^"]*\/js\/[^"]*webflow[^"]*\.js"/g,
               `src="${upPrefix}js/webflow.js"`)
      .replace(/src="https?:\/\/d3e54v103j8qbb\.cloudfront\.net\/js\/jquery[^"]*\.js[^"]*"/g,
               `src="${upPrefix}js/jquery.min.js"`);

    return html;
  };
}

function adjustPathsForDepth(html, outRel) {
  // Re-anchor unprefixed relative links/srcs for pages in subdirectories.
  const depth = outRel.split('/').length - 1;
  if (depth === 0) return html;
  const up = '../'.repeat(depth);
  return html.replace(
    /(href|src)="(?!https?:|mailto:|tel:|data:|\/|#|\.\.\/|\.\/)([a-zA-Z0-9_/.-]+\.(?:html|css|js|png|jpg|jpeg|gif|webp|svg|ico|ttf|woff|woff2))"/g,
    `$1="${up}$2"`
  );
}

// ─── BFS CRAWLER ──────────────────────────────────────────────────────────────
// Webflow's sitemap.xml only lists static + landing pages — CMS detail pages
// (e.g. /post/{slug}, /project/{slug}) are absent. Crawl each fetched page for
// same-site internal links to discover those slugs generically.

function extractInternalPaths(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const out = new Set();
  $('a[href]').each((_, el) => {
    const h = ($(el).attr('href') || '').trim();
    if (!h) return;
    let p;
    if (h.startsWith('//')) return;
    if (h.startsWith('/'))             p = h.split('?')[0].split('#')[0];
    else if (h.startsWith(SITE))       { try { p = new URL(h).pathname; } catch { return; } }
    else                               return;
    p = (p || '').replace(/\/+$/, '') || '/';
    if (p) out.add(p);
  });
  return [...out];
}

async function crawl(seedUrls) {
  const fetched = new Map(); // urlPath → html (or null on error)
  const queue   = [...seedUrls];
  let processed = 0;

  while (queue.length) {
    const u = queue.shift();
    if (fetched.has(u)) continue;
    if (shouldSkip(u))  { fetched.set(u, null); continue; }

    let html = null;
    try { html = await fetchText(SITE + (u === '/' ? '' : u)); }
    catch (e) {
      log(`   ✗ ${u} (${e.message})`);
      fetched.set(u, null);
      continue;
    }
    fetched.set(u, html);
    processed++;
    log(`   • ${u}`);

    for (const p of extractInternalPaths(html)) {
      if (!fetched.has(p) && !queue.includes(p)) queue.push(p);
    }
  }
  log(`   ${processed} pages fetched, ${fetched.size - processed} skipped/errored`);
  return fetched;
}

// ─── CMS METADATA EXTRACTOR ───────────────────────────────────────────────────
// Pulls richer per-item fields out of a saved page so cms-dump can carry them
// into mdx frontmatter (date / author / category / image / tags). Best-effort:
// uses OG / article meta tags first, falls back to Webflow class-name conventions.
function extractCmsMetadata($) {
  const meta = {};

  // Hero image — og:image first, then first hero/main/featured/cover img.
  const ogImage = $('meta[property="og:image"]').attr('content')
              || $('meta[property="og:image:secure_url"]').attr('content')
              || $('meta[property="twitter:image"]').attr('content')
              || $('meta[name="twitter:image"]').attr('content');
  if (ogImage) {
    meta.image = ogImage;
  } else {
    const heroImg = $('[class*="main-image"], [class*="hero-image"], [class*="featured-image"], [class*="cover-image"]').find('img').first();
    const src = heroImg.attr('src');
    if (src) meta.image = src;
  }

  // Webflow detail-meta wrapper: typically holds [<a class="...meta-link">category</a>,
  // <div class="...meta-text">date</div>] — inspect these first since meta tags
  // for date/author/category are rarely emitted by Webflow's static export.
  const metaWrap = $('[class*="details-meta-wrapper"], [class*="post-meta-wrapper"], [class*="article-meta-wrapper"], [class*="entry-meta"], [class*="-meta-wrapper"]').first();

  // Date — article:published_time, then <time datetime="...">, then meta-wrapper fallback.
  const date = $('meta[property="article:published_time"]').attr('content')
            || $('meta[property="og:article:published_time"]').attr('content')
            || $('time[datetime]').first().attr('datetime');
  if (date) {
    meta.date = date;
  } else {
    let el = $('[class*="published-date"], [class*="post-date"], [class*="blog-date"], [class*="published"]').first();
    if (!el.length && metaWrap.length) {
      // Pick the meta-wrapper child whose text looks like a date.
      metaWrap.children().each((_, child) => {
        const t = $(child).text().trim();
        if (/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}/.test(t) || /\d{4}-\d{2}-\d{2}/.test(t)) {
          if (!meta.date) meta.date = t;
        }
      });
    } else {
      const t = el.text().trim();
      if (t) meta.date = t;
    }
  }

  // Author — meta first, then class fallback, then last text-bearing meta-wrapper child.
  const authorMeta = $('meta[property="article:author"]').attr('content')
                  || $('meta[name="author"]').attr('content');
  if (authorMeta) {
    meta.author = authorMeta;
  } else {
    const el = $('[class*="author-link"], [class*="author-name"], [class*="post-author"]').first();
    const t = el.text().trim();
    if (t) meta.author = t;
  }

  // Category — meta, dedicated class, OR first <a> inside a detail-meta wrapper.
  const catMeta = $('meta[property="article:section"]').attr('content');
  if (catMeta) {
    meta.category = catMeta;
  } else {
    let el = $('[class*="category-link"], [class*="post-category"], [class*="blog-category"]').first();
    if (!el.length && metaWrap.length) el = metaWrap.find('a').first();
    const t = el.text().trim();
    if (t) meta.category = t;
  }

  // Tags — multiple.
  const tags = [];
  $('[class*="tag-link"], [class*="post-tag"], [class*="blog-tag"]').each((_, el) => {
    const t = $(el).text().trim();
    if (t && !tags.includes(t)) tags.push(t);
  });
  if (tags.length) meta.tags = tags;

  return meta;
}

// ─── PAGE SAVE ────────────────────────────────────────────────────────────────
async function savePageFromHtml(rawHtml, urlPath, outRel, urlMap) {
  const rewriter = buildLinkRewriter(urlMap, outRel);
  let html = rewriter(rawHtml);
  html = await localizeImages(html, outRel);
  html = adjustPathsForDepth(html, outRel);

  const outPath = path.join(OUT, outRel);
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, html, 'utf8');

  const $ = cheerio.load(html, { decodeEntities: false });
  const rawTitle    = ($('title').text() || '').trim();
  const title       = rawTitle
    .replace(/\s*[-|–—]?\s*Webflow\s+HTML\s+(?:Website\s+)?Template\s*$/i, '')
    .replace(/\s*-\s*Webflow\s+Template\s*$/i, '')
    .trim();
  const description = ($('meta[name="description"]').attr('content') || '').trim();
  const cmsMeta     = extractCmsMetadata($);
  log(`   ✓ ${outRel}  ←  ${urlPath}`);
  return { url: urlPath, outRel, title, description, ...cmsMeta };
}

// ─── CMS DUMP ─────────────────────────────────────────────────────────────────
function buildCmsDump(pages) {
  const collections = {};
  const rootPages   = [];
  for (const p of pages) {
    const segs = p.outRel.split('/');
    if (segs.length === 1) {
      rootPages.push(p.outRel);
    } else {
      const col  = segs[0];
      const slug = segs.slice(1).join('/').replace(/\.html$/, '');
      (collections[col] ||= []).push({ slug, ...p });
    }
  }
  // Drop "collections" that are really just one-off subfolders (single page,
  // not a CMS list). Convert script can re-decide; this is just a convenience
  // hint. Keep all for now — Chunk C decides routing semantics.
  return {
    name: NAME,
    site: SITE,
    fetchedAt: new Date().toISOString(),
    homePromote: HOME_PROMOTE,
    rootPages,
    collections,
    pages,
  };
}

// ─── CLEANUP STALE FILES ──────────────────────────────────────────────────────
// fetch-cms is incremental — re-runs don't auto-purge pre-existing pages.
// Before each fetch, drop any HTML matching homePromote-promoted-away landing
// (root index.html) or any skipPaths subtree, so they don't survive into the
// transform step.
function cleanupSkipped() {
  if (!fs.existsSync(OUT)) return;
  let removed = 0;
  if (HOME_PROMOTE) {
    const landing = path.join(OUT, 'index.html');
    if (fs.existsSync(landing)) { fs.unlinkSync(landing); removed++; log(`   🗑  index.html (landing showcase)`); }
  }
  for (const sp of SKIP_PATHS) {
    const cleanSp = sp.replace(/^\/+|\/+$/g, '');
    if (!cleanSp) continue;
    const dirPath  = path.join(OUT, cleanSp);
    const filePath = path.join(OUT, `${cleanSp}.html`);
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      fs.rmSync(dirPath, { recursive: true, force: true });
      removed++; log(`   🗑  ${cleanSp}/`);
    }
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath); removed++; log(`   🗑  ${cleanSp}.html`);
    }
  }
  if (removed) log(`   ${removed} stale entries removed`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async function main() {
  log(`\n🌐 fetch-cms — project "${NAME}"`);
  log(`   OUT : ${OUT}`);
  log(`   skipPaths   : ${JSON.stringify(SKIP_PATHS)}`);
  log(`   homePromote : ${HOME_PROMOTE || '(none)'}`);

  log(`\n🔎 Resolving host...`);
  await resolveSite();
  log(`   SITE: ${SITE}`);

  ensureDir(path.join(OUT, 'images'));
  ensureDir(path.join(OUT, 'js'));
  ensureDir(path.join(OUT, 'css'));
  ensureDir(path.join(OUT, 'fonts'));

  log(`\n🧹 Cleanup stale (skipped) files...`);
  cleanupSkipped();

  // Bundle jquery locally so the saved pages can run offline.
  const jqLocal = path.join(OUT, 'js', 'jquery.min.js');
  if (!fs.existsSync(jqLocal)) {
    log('\n📦 Downloading jquery for local bundling...');
    try {
      const buf = await fetchBuffer('https://d3e54v103j8qbb.cloudfront.net/js/jquery-3.5.1.min.dc5e7f18c8.js');
      fs.writeFileSync(jqLocal, buf);
      log('   ↓ js/jquery.min.js');
    } catch (e) { log(`   ✗ jquery (${e.message})`); }
  }

  // Bundle Webflow site CSS + webflow.js + @font-face fonts. Grab the very first
  // page's HTML (sitemap[0] or '/') to discover their CDN URLs, then download.
  async function downloadSiteAssets() {
    log('\n📦 Downloading site CSS + webflow.js + fonts...');
    const probeUrl = `${SITE}/`;
    let probeHtml;
    try { probeHtml = await fetchText(probeUrl); }
    catch (e) { log(`   ✗ probe (${e.message})`); return; }

    // Site CSS — first https://cdn.prod.website-files.com/.../css/*.css link
    const cssMatch = probeHtml.match(/href="(https?:\/\/cdn\.prod\.website-files\.com\/[^"]*\/css\/[^"]*\.css)"/);
    if (cssMatch) {
      try {
        const cssBuf  = await fetchBuffer(cssMatch[1]);
        const cssText = cssBuf.toString('utf8');
        // Inline normalize.css + webflow.css if referenced via @import (Webflow doesn't, but keep safe)
        fs.writeFileSync(path.join(OUT, 'css', `${NAME}.webflow.css`), cssText);
        log(`   ↓ css/${NAME}.webflow.css`);
        // Pull every font URL the CSS references.
        const fontUrls = [...cssText.matchAll(/url\(["']?(https?:\/\/[^"')]+\.(?:woff2|woff|ttf|otf|eot))["']?\)/g)].map(m => m[1]);
        const seenFonts = new Set();
        for (const fu of fontUrls) {
          if (seenFonts.has(fu)) continue;
          seenFonts.add(fu);
          const fname  = path.basename(fu.split('?')[0]);
          const fdest  = path.join(OUT, 'fonts', fname);
          if (fs.existsSync(fdest)) continue;
          try {
            const fbuf = await fetchBuffer(fu);
            fs.writeFileSync(fdest, fbuf);
          } catch (e) { log(`   ✗ font ${fname} (${e.message})`); }
        }
        if (seenFonts.size) log(`   ↓ fonts/  (${seenFonts.size} files)`);

        // Pull every CDN image URL the CSS references via background-image url(...).
        // Webflow stores e.g. `66c430ea15ed715aec991ef0_Service%20Item%20Bg.png`.
        // <img>/srcset crawl misses these because they're CSS-only assets.
        const cssImgMatches = [...cssText.matchAll(/url\(["']?(https?:\/\/[^"')]+\.(?:png|jpe?g|webp|gif|svg|avif))(?:\?[^"')]*)?["']?\)/gi)];
        const seenCssImgs = new Set();
        for (const m of cssImgMatches) {
          const u = m[1];
          if (seenCssImgs.has(u)) continue;
          seenCssImgs.add(u);
          if (typeof isCdnImage === 'function' && !isCdnImage(u)) continue;
          try { await downloadImage(u); }
          catch (e) { log(`   ✗ css-img ${u.split('/').pop()} (${e.message})`); }
        }
        if (seenCssImgs.size) log(`   ↓ images/  (CSS background-images: ${seenCssImgs.size})`);
      } catch (e) { log(`   ✗ css (${e.message})`); }
    } else {
      log('   ✗ css link not found in probe page');
    }

    // webflow.js — first https://cdn.prod.website-files.com/.../js/*webflow*.js src
    const wfJsMatch = probeHtml.match(/src="(https?:\/\/cdn\.prod\.website-files\.com\/[^"]*\/js\/[^"]*webflow[^"]*\.js)"/);
    if (wfJsMatch) {
      try {
        const wfJsBuf = await fetchBuffer(wfJsMatch[1]);
        fs.writeFileSync(path.join(OUT, 'js', 'webflow.js'), wfJsBuf);
        log('   ↓ js/webflow.js');
      } catch (e) { log(`   ✗ webflow.js (${e.message})`); }
    }
  }
  await downloadSiteAssets();

  // ── Phase 1: seed URLs from sitemap + extras ────────────────────────────────
  const seeds = await discoverUrls();
  log(`\n📋 Sitemap + extras: ${seeds.length} seed URL(s)`);

  // ── Phase 2: BFS crawl (discovers CMS detail URLs missing from sitemap) ─────
  log(`\n🕷  Crawling internal links...`);
  const fetched = await crawl(seeds);

  // ── Phase 3: build URL → outRel map ─────────────────────────────────────────
  // Skipped URLs stay OUT so the rewriter falls through and leaves their
  // hrefs untouched — convert step strips those <a> tags entirely.
  const urlMap = new Map();
  for (const [u, html] of fetched.entries()) {
    if (html === null) continue; // crawl error or skipped
    if (u === '/' && HOME_PROMOTE) {
      urlMap.set('/', urlToOutRel('/' + HOME_PROMOTE)); // → home/home-one.html
      continue;
    }
    if (shouldSkip(u)) continue;
    urlMap.set(u, urlToOutRel(u));
  }
  if (HOME_PROMOTE && !urlMap.has('/')) {
    urlMap.set('/', urlToOutRel('/' + HOME_PROMOTE));
  }

  // ── Phase 4: save with link rewriting + image localization ──────────────────
  const saveCount = [...urlMap.entries()].filter(([u]) => !(u === '/' && HOME_PROMOTE)).length;
  log(`\n📄 Saving ${saveCount} page(s)...`);
  const pages = [];
  for (const [u, outRel] of urlMap.entries()) {
    if (u === '/' && HOME_PROMOTE) continue; // landing dropped
    const html = fetched.get(u);
    if (!html) continue;
    const meta = await savePageFromHtml(html, u, outRel, urlMap);
    if (meta) pages.push(meta);
  }

  // ── cms-dump.json ───────────────────────────────────────────────────────────
  const dump = buildCmsDump(pages);
  // Resale-safety: scrub Webflow CDN refs + source webflow.io URLs from any
  // string field carried into cms-dump (covers cmsMeta extracted via cheerio:
  // og:image, og:url, breadcrumbs, etc.).
  const scrubbed = JSON.parse(JSON.stringify(dump), (k, v) => {
    if (typeof v !== 'string') return v;
    return v
      .replace(new RegExp(`https://${NAME}\\.webflow\\.io/?`, 'g'), '/')
      .replace(/https:\/\/cdn\.prod\.website-files\.com\/[a-f0-9]+\//gi, '/assets/images/')
      .replace(/https:\/\/uploads-ssl\.webflow\.com\/[a-f0-9]+\//gi, '/assets/images/');
  });
  fs.writeFileSync(path.join(__dirname, 'cms-dump.json'), JSON.stringify(scrubbed, null, 2));
  log(`\n📦 cms-dump.json — ${dump.pages.length} pages, ${Object.keys(dump.collections).length} collection(s)`);
  for (const [col, items] of Object.entries(dump.collections)) {
    log(`     • ${col}/  (${items.length})`);
  }

  log(`\n🖼  Images downloaded: ${[...downloadedImages.values()].filter(Boolean).length}`);
  log(`   Total CDN URLs seen: ${downloadedImages.size}`);
  log('\n✅ fetch-cms complete.\n');
})().catch(e => { console.error(e); process.exit(1); });
