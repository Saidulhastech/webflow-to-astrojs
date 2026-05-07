/**
 * post-process.js
 *
 * Walks an output directory (any of the output-illuspro-* folders) and applies:
 *   1. data-w-id → data-id  (HTML attributes, CSS selectors, JS string literals)
 *   2. Strips the leading `w-` from every Webflow framework class name in HTML
 *      class attributes, in CSS selectors, and in webflow.js string literals.
 *      Tailwind's `w-full / w-auto / w-screen / w-px / w-1/2 / w-{n}` etc. are
 *      kept untouched because they are NOT in the Webflow framework whitelist.
 *   3. Deduplicates class tokens inside every HTML class attribute.
 *
 * Usage:  node post-process.js <output-dir>
 */

const fs   = require('fs');
const path = require('path');

const ROOT = process.argv[2];
if (!ROOT || !fs.existsSync(ROOT)) {
  console.error('post-process.js: usage — node post-process.js <output-dir>');
  process.exit(1);
}

// Repo-relative project.config.json (one level up from ROOT in the standard
// layout: webflow-toastro/output-{NAME}-tailwind-v4/). Used for the icon-font
// rename so each project gets its own `{NAME}-icons` family name.
const REPO_ROOT = path.dirname(__filename);
const PROJ_CFG_PATH = path.join(REPO_ROOT, 'project.config.json');
const PROJ_CFG = fs.existsSync(PROJ_CFG_PATH)
  ? JSON.parse(fs.readFileSync(PROJ_CFG_PATH, 'utf8'))
  : {};
const PROJ_NAME = PROJ_CFG.name || 'site';
const ICONS_FAMILY = `${PROJ_NAME}-icons`;

// ─── Webflow framework class whitelist ────────────────────────────────────────
// Every literal class name Webflow emits as part of its framework. Each entry
// is the FULL class name (including the `w-` / `w--` prefix). We rewrite each
// to the same name minus the leading `w-`, and tokens NOT in this list are
// left alone (so Tailwind's `w-full` / `w-auto` / `w-1/2` survive untouched).
const WF_EXACT = new Set([
  'w-layout-blockcontainer','w-layout-grid','w-layout-vflex','w-layout-hflex',
  'w-container','w-inline-block','w-block','w-button','w-input','w-select',
  'w-form','w-form-done','w-form-fail','w-form-label',
  'w-checkbox','w-checkbox-input','w-checkbox-input--inputType-custom',
  'w-radio','w-radio-input',
  'w-nav','w-nav-menu','w-nav-brand','w-nav-button','w-nav-link','w-nav-overlay',
  'w-tabs','w-tab-menu','w-tab-link','w-tab-pane','w-tab-content',
  'w-slider','w-slider-mask','w-slide',
  'w-slider-arrow-left','w-slider-arrow-right','w-slider-nav','w-slider-nav-invert',
  'w-slider-dot','w-slider-aria-label','w-slider-force-show',
  'w-dropdown','w-dropdown-toggle','w-dropdown-list','w-dropdown-link','w-dropdown-btn',
  'w-icon','w-icon-nav-menu','w-icon-slider-left','w-icon-slider-right',
  'w-icon-dropdown-toggle','w-icon-arrow-down',
  'w-icon-file-upload-icon','w-icon-file-upload-uploading','w-icon-file-upload-remove',
  'w-embed','w-richtext','w-lightbox','w-list-unstyled',
  'w-background-video','w-background-video-atom','w-background-video--control',
  'w-dyn-list','w-dyn-items','w-dyn-item','w-dyn-empty','w-dyn-bind-empty',
  'w-dyn-hide','w-dyn-bind','w-condition-invisible',
  'w-json','w-script','w-templates','w-widget','w-widget-map',
  'w-round','w-num','w-shadow','w-password-page','w-webflow-badge',
  'w-mod-js','w-mod-touch','w-mod-ix','w-active','w-in-tablet',
  'w--current','w--tab-active','w--open',
  'w--redirected-checked','w--redirected-focus','w--nav-link-open',
]);

// Prefix patterns for classes that carry an arbitrary suffix (ids, slugs).
const WF_PREFIX = [
  /^w-node-[A-Za-z0-9_-]+$/,
  /^w-to-[A-Za-z0-9_-]+$/,
  /^w-variant-[A-Za-z0-9_-]+$/,
];

// Tailwind width utilities have a fixed shape that does NOT collide with the
// Webflow framework names — keep these as-is.
//   w-{number}, w-{n}/{n}, w-full|auto|screen|fit|min|max|px,
//   w-svw|lvw|dvw, w-[arbitrary]
const TW_WIDTH_RX = /^w-(\d+(\.\d+)?|\d+\/\d+|full|auto|screen|fit|min|max|px|svw|lvw|dvw|\[.+\])$/;

function isWebflowClass(name) {
  if (!name.startsWith('w-')) return false;
  if (TW_WIDTH_RX.test(name)) return false;
  if (WF_EXACT.has(name)) return true;
  if (WF_PREFIX.some(rx => rx.test(name))) return true;
  // Anything left starting with `w-` (Webflow conventions: w-row, w-col-*,
  // w-clearfix, w-lightbox-*, w-richtext-*, w-file-upload-*, w-hidden,
  // w-mod-*, w--current, w-widget-*, …) is Webflow-framework — strip it.
  return true;
}

// ─── Collision detection ─────────────────────────────────────────────────────
// Build the set of custom class names used by the site (everything declared
// in CSS that is NOT a Webflow framework class). When a Webflow class would
// collapse onto an existing custom class after `w-` is stripped, we fall back
// to a `wf-` prefix instead so the two CSS rules never merge.
const customClasses = new Set();
for (const dir of [ROOT]) {
  walkSync(dir, full => {
    if (!full.endsWith('.css')) return;
    const css = fs.readFileSync(full, 'utf8');
    for (const m of css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) {
      const n = m[1];
      if (!n.startsWith('w-')) customClasses.add(n);
    }
  });
}

function walkSync(dir, fn) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSync(full, fn);
    else fn(full);
  }
}

// Override the simple strip with a collision-aware version.
function safeRename(name) {
  if (!isWebflowClass(name)) return name;
  const stripped = name.replace(/^w-/, '');
  return customClasses.has(stripped) ? 'wf-' + stripped : stripped;
}

function stripWfPrefix(name) {
  // `w-foo` → `foo`,  `w--foo` → `-foo` (still a valid CSS identifier).
  return name.replace(/^w-/, '');
}

// ─── HTML pass ────────────────────────────────────────────────────────────────

function processHtml(html, filePath) {
  // 0a. Resale-safety scrub. Drop every Webflow runtime dep + remote CDN ref
  //     so the post-processed output can be shipped without a Webflow account
  //     dependency (or its site-id leaking from the source crawl).
  //       • <script src=".../d3e54v103j8qbb.cloudfront.net/.../jquery..."> → removed
  //         (replaced by self-hosted js/jquery.min.js if loadJquery is set)
  //       • <script src=".../webflow.js"> → removed (replaced by js/site-ui.js)
  //       • <!-- Last Published: ... --> banner → removed
  //       • data-site / data-page page-id attrs on <html> → removed
  //       • Webflow asset CDN URLs → /assets/images/
  //       • <title>...— Webflow HTML Website Template</title> → trimmed
  //       • 'webflow-icons' font-family → '<NAME>-icons'
  if (filePath) {
    const relFromRoot = path.relative(ROOT, filePath).split(path.sep);
    const depth = relFromRoot.length - 1;
    const upPrefix = depth > 0 ? '../'.repeat(depth) : '';
    // Drop Webflow CDN jQuery script tag (defer to self-hosted jquery.min.js).
    html = html.replace(
      /<script\b[^>]*\bsrc="[^"]*\bd3e54v103j8qbb\.cloudfront\.net[^"]*"[^>]*><\/script>\s*/gi,
      `<script src="${upPrefix}js/jquery.min.js"></script>`
    );
    // Webflow CDN-hosted webflow.js → local copy (preserve full IX2 runtime).
    html = html.replace(
      /src="https?:\/\/cdn\.prod\.website-files\.com\/[^"]*\/js\/[^"]*webflow[^"]*\.js"/g,
      `src="${upPrefix}js/webflow.js"`
    );
    // If keepWebflowJs is false, drop both the webflow.js script tag and let
    // site-ui.js handle interactions. Otherwise leave the local-pointed tag
    // alone and append site-ui.js as a follow-on bootstrap.
    if (!KEEP_WEBFLOW_JS) {
      html = html.replace(
        /<script\b[^>]*\bsrc="[^"]*\bwebflow\.js(?:\?[^"]*)?"[^>]*><\/script>\s*/gi,
        `<script src="${upPrefix}js/site-ui.js"></script>`
      );
    } else {
      // Append site-ui.js after the (already-local) webflow.js so its
      // ViewTransitions hook + supplements run after Webflow boots.
      // Idempotent: skip insertion if a site-ui.js script tag already follows.
      const siteUiTag = `<script src="${upPrefix}js/site-ui.js"></script>`;
      // Remove any pre-existing site-ui.js script tags (idempotency).
      html = html.replace(/<script\b[^>]*\bsrc="[^"]*\bsite-ui\.js(?:\?[^"]*)?"[^>]*><\/script>\s*/gi, '');
      html = html.replace(
        /(<script\b[^>]*\bsrc="[^"]*\bwebflow\.js(?:\?[^"]*)?"[^>]*><\/script>)/i,
        (m) => `${m}\n${siteUiTag}`
      );
    }
  }
  // Title sanitisation (do BEFORE the data-wf-* rename so og/twitter meta strip
  // applies regardless of attribute order).
  const stripWebflowMarketing = (t) => t
    .replace(/\s*[-|–—]?\s*Webflow\s+HTML\s+(?:Website\s+)?Template/gi, '')
    .replace(/\s*-\s*Webflow\s+Template\s*$/i, '')
    .trim();
  html = html
    .replace(/<!--\s*Last Published:[\s\S]*?-->\s*/gi, '')
    .replace(/<title>([^<]*)<\/title>/gi, (_m, t) => `<title>${stripWebflowMarketing(t)}</title>`)
    .replace(/<meta\s+content="([^"]*)"\s+property="(og:title|twitter:title)"/gi,
      (_m, c, p) => `<meta content="${stripWebflowMarketing(c)}" property="${p}"`)
    .replace(/<meta\s+property="(og:title|twitter:title)"\s+content="([^"]*)"/gi,
      (_m, p, c) => `<meta property="${p}" content="${stripWebflowMarketing(c)}"`)
    // Drop Webflow preconnect hint — once asset URLs are rewritten to /assets/images/
    // the preconnect to cdn.prod.website-files.com is dead weight + leaks origin.
    .replace(/<link\b[^>]*\bhref="https:\/\/cdn\.prod\.website-files\.com[^"]*"[^>]*>\s*/gi, '')
    .replace(/<link\b[^>]*\bhref="https:\/\/d3e54v103j8qbb\.cloudfront\.net[^"]*"[^>]*>\s*/gi, '')
    // Webflow CDN asset URLs — route by extension: fonts → /fonts/, videos →
    // /videos/, everything else → /assets/images/. Match literal `/`,
    // URL-encoded `%2F`, and double-URL-encoded forms.
    .replace(/https:\/\/cdn\.prod\.website-files\.com\/[a-f0-9]+(?:\/|%2F)([^"'\s)]*\.(?:woff2|woff|ttf|otf|eot))/gi, '/fonts/$1')
    .replace(/https:\/\/uploads-ssl\.webflow\.com\/[a-f0-9]+(?:\/|%2F)([^"'\s)]*\.(?:woff2|woff|ttf|otf|eot))/gi, '/fonts/$1')
    .replace(/https:\/\/cdn\.prod\.website-files\.com\/[a-f0-9]+(?:\/|%2F)([^"'\s)]*\.(?:mp4|webm|mov|m4v))/gi, '/videos/$1')
    .replace(/https:\/\/uploads-ssl\.webflow\.com\/[a-f0-9]+(?:\/|%2F)([^"'\s)]*\.(?:mp4|webm|mov|m4v))/gi, '/videos/$1')
    .replace(/https:\/\/cdn\.prod\.website-files\.com\/[a-f0-9]+(?:\/|%2F)/gi, '/assets/images/')
    .replace(/https:\/\/uploads-ssl\.webflow\.com\/[a-f0-9]+(?:\/|%2F)/gi, '/assets/images/')
    .replace(/https:\/\/assets-global\.website-files\.com\/[a-f0-9]+(?:\/|%2F)/gi, '/assets/images/')
    .replace(/https%3A%2F%2Fcdn\.prod\.website-files\.com%2F[a-f0-9]+%2F/gi, '%2Fassets%2Fimages%2F')
    .replace(/https%3A%2F%2Fuploads-ssl\.webflow\.com%2F[a-f0-9]+%2F/gi, '%2Fassets%2Fimages%2F')
    // Fetch-cms downloads CDN images into `{NAME}.webflow/images/`, but inline
    // styles + data-poster-url retain `images/{site-id}/{filename}` paths
    // pointing at a non-existent subdir. Flatten to `images/{filename}`.
    .replace(/(["'(]|&quot;)((?:\.\.\/)?images\/)[a-f0-9]{16,}\//gi, '$1$2')
    // normalize-images.js renamed disk files (spaces → underscores) but URL
    // refs in attributes/inline-styles still carry %20 or literal spaces.
    // Rewrite asset paths so they match disk.
    .replace(/((?:src|href|data-[a-z-]*url|data-[a-z-]*urls|poster|content|srcset)=["'][^"']*\/(?:assets\/images|fonts|videos)\/[^"']*?)(%20| )([^"']*["'])/gi,
      (m) => m.replace(/(%20| )/g, '_'))
    .replace(/(url\(["']?[^)]*\/(?:assets\/images|fonts|videos)\/[^)]*?)(%20| )([^)]*\))/gi,
      (m) => m.replace(/(%20| )/g, '_'))
    .replace(/(['"])webflow-icons\1/g, `$1${ICONS_FAMILY}$1`);

  // 0. Drop `integrity=` + `crossorigin=` from EVERY <script>/<link> tag.
  //    Originally restricted to local-src tags, but Webflow's CDN jquery
  //    reference also fails subresource-integrity validation under file://
  //    origin (null origin → CORS-clean check rejects). Stripping universally
  //    is safe because the output is only used for preview/inspection — the
  //    final Astro `dist/` build manages its own integrity.
  for (let pass = 0; pass < 2; pass++) {
    html = html.replace(/<(script|link)\b([^>]*?)\b(integrity|crossorigin)="[^"]*"/gi,
      (m, _tag, _before, attr) => m.replace(new RegExp(`\\s+${attr}="[^"]*"`, 'i'), ''));
  }

  // 1a. Page/site identifier handling.
  //   keepWebflowJs:true — KEEP `data-wf-page` and `data-wf-site` UNCHANGED.
  //     webflow.js bundle contains IX2 events keyed on original page+site IDs
  //     (e.g. target.id = "66bb1eadfdc66647ff6b7feb|<element-id>"). If we
  //     obfuscate the IDs, NO IX2 events match → zero animations fire. The
  //     IDs are also baked inside webflow.js itself, so stripping them from
  //     HTML is security theatre — the bundle still references them.
  //     Drop the surrounding metadata attrs (domain/status) only.
  //   keepWebflowJs:false — drop both entirely (vanilla mode doesn't need them).
  if (KEEP_WEBFLOW_JS) {
    html = html.replace(/\s+data-wf-(?!page\b|site\b)[a-zA-Z0-9-]+="[^"]*"/g, '');
    html = html.replace(/\s+data-wf-(?!page\b|site\b)[a-zA-Z0-9-]+(?=\s|>)/g, '');
  } else {
    html = html.replace(/\s+data-wf-(?:page|site)="[^"]*"/gi, '');
    html = html.replace(/\s+data-(?:page|site)="[a-f0-9]{16,}"/gi, '');
    html = html.replace(/\s+data-wf-[a-zA-Z0-9-]+="[^"]*"/g, '');
    html = html.replace(/\s+data-wf-[a-zA-Z0-9-]+(?=\s|>)/g, '');
  }

  // 1. Strip `w-` from `data-w-*` attribute names ONLY when keepWebflowJs:false.
  //     webflow.js binds to data-w-id / data-w-tab — stripping breaks IX2.
  if (!KEEP_WEBFLOW_JS) {
    html = html.replace(/\bdata-w-([a-zA-Z0-9-]+)=/g, 'data-$1=');
    html = html.replace(/\bid="(w-node-[^"]+)"/g, (m, v) => `id="${stripWfPrefix(v)}"`);
  }

  // 2. Inside any class="..." attribute, dedupe class tokens. Class renaming
  //     (w-* strip) is gated on keepWebflowJs:false — webflow.js binds to
  //     w-slider / w-tabs / w-dropdown / w-nav / w-dyn-* so stripping breaks
  //     every interaction. With keepWebflowJs:true we only dedupe.
  html = html.replace(/(\s)class="([^"]*)"/g, (m, lead, val) => {
    const seen = new Set();
    const out  = [];
    for (const tok of val.split(/\s+/)) {
      if (!tok) continue;
      const renamed = KEEP_WEBFLOW_JS ? tok : safeRename(tok);
      if (!seen.has(renamed)) { seen.add(renamed); out.push(renamed); }
    }
    return `${lead}class="${out.join(' ')}"`;
  });

  // 3. Inside any inline <style>...</style> block, also rename selectors.
  html = html.replace(/<style([^>]*)>([\s\S]*?)<\/style>/g, (m, attrs, css) => {
    return `<style${attrs}>${processCss(css)}</style>`;
  });

  // 4. Inside any inline <script>...</script> block, run the JS rewriter.
  html = html.replace(/<script([^>]*)>([\s\S]*?)<\/script>/g, (m, attrs, js) => {
    if (/\bsrc=/.test(attrs)) return m; // external script — body is empty / data only
    if (/type="application\/json"/.test(attrs)) return m; // CMS JSON payloads
    return `<script${attrs}>${processJs(js)}</script>`;
  });

  return html;
}

// ─── CSS pass ─────────────────────────────────────────────────────────────────

function processCss(css) {
  // 1a. Rename data-wf-page / data-wf-site selectors (kept attrs).
  css = css.replace(/\[data-wf-(page|site)/g, '[data-$1');

  // CSS-side `w-` strip is gated on keepWebflowJs:false. With webflow.js
  // shipped, the bundle's runtime CSS rules (.w-slider .w-mask etc.) must
  // continue to match the matching HTML class names.
  if (!KEEP_WEBFLOW_JS) {
    css = css.replace(/\[data-w-([a-zA-Z0-9-]+)/g, '[data-$1');
    css = css.replace(/#w-(node-[A-Za-z0-9_-]+)/g, '#$1');
    css = css.replace(/\.(w--?[A-Za-z0-9_-]+)/g, (m, name) => {
      return isWebflowClass(name) ? '.' + safeRename(name) : m;
    });
  }

  // 4. Resale-safety: replace Webflow-hosted assets + rename icon font.
  //    Route by file extension: fonts → /fonts/, images → /assets/images/.
  //    Single-pass walker over every `url(...)` so we don't have to juggle
  //    optional quotes / query strings / multiple host variants in regex.
  const FONT_EXT_RX  = /\.(?:woff2|woff|ttf|otf|eot)(?:[?#]|$)/i;
  const CDN_HOSTS_RX = /^https:\/\/(?:cdn\.prod\.website-files\.com|uploads-ssl\.webflow\.com|assets-global\.website-files\.com)\/[a-f0-9]+(?:\/|%2F)/i;
  css = css
    .replace(/url\((['"]?)https:\/\/d3e54v103j8qbb\.cloudfront\.net\/static\/custom-checkbox-checkmark\.589d534424\.svg\1\)/gi,
      'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%2712%27 viewBox=%270 0 12 12%27%3E%3Cpath fill=%27%23fff%27 d=%27M3.532 4.81 1.65 6.69l3.182 3.183 5.524-5.524-1.882-1.882-3.642 3.643z%27/%3E%3C/svg%3E")')
    // Walker — handle three forms:
    //   url('...')      single-quoted (allow parens inside)
    //   url("...")      double-quoted (allow parens inside)
    //   url(...)        bare (must NOT contain parens or quotes)
    .replace(/url\((?:'([^']+)'|"([^"]+)"|([^)"'\s]+))\)/g, (m, sq, dq, bare) => {
      const raw = sq ?? dq ?? bare;
      const q = sq != null ? "'" : (dq != null ? '"' : '');
      // Skip data: URIs (inline SVG / base64 fonts).
      if (/^data:/i.test(raw)) return m;
      // Skip non-CDN external URLs (Google Fonts, Typekit, ...).
      const isCdn = CDN_HOSTS_RX.test(raw);
      if (!isCdn && /^https?:\/\//i.test(raw)) return m;
      // Strip Webflow CDN host + site-id segment.
      let u = isCdn ? raw.replace(CDN_HOSTS_RX, '') : raw;
      // Drop residual `images/{site-id}/` subdir if present.
      u = u.replace(/(?:\.{1,2}\/)*(?:\/?(?:assets\/)?images\/)?[a-f0-9]{16,}\/(?=[^/])/i, '/assets/images/');
      // Choose target dir by extension.
      const isFont = FONT_EXT_RX.test(u);
      const filename = u.split('/').pop().split('?')[0];
      const target = isFont ? `/fonts/${filename}` : `/assets/images/${filename}`;
      // Normalise %20/literal spaces to underscore (matches normalize-images.js).
      const safe = target.replace(/%20/g, '_').replace(/ /g, '_');
      return `url(${q}${safe}${q})`;
    })
    .replace(/(['"])webflow-icons\1/g, `$1${ICONS_FAMILY}$1`);

  return css;
}

// ─── JS pass ──────────────────────────────────────────────────────────────────

function processJs(js) {
  // JS class/attribute renaming is GATED on keepWebflowJs:false. With
  // webflow.js shipped (default), every `w-slider`/`data-w-id`/etc. literal
  // inside the bundle MUST match the live HTML class/attribute names — if we
  // rewrite the bundle's strings the runtime can't find anything to bind to.
  if (KEEP_WEBFLOW_JS) return js;
  // webflow.js references the data attribute and Webflow class names as plain
  // string fragments — sometimes inside ', ", or `…` template literals, and
  // sometimes embedded inside selector strings like `[data-w-id="${t}"]`.
  // For each thing we want renamed we replace by literal text globally; the
  // whole `data-w-id` / `w-foo` token is unique enough not to collide with
  // anything else inside webflow.js itself.
  let out = js;
  // Rename data-wf-page / data-wf-site literals (kept attrs).
  out = out.replace(/data-wf-(page|site)/g, 'data-$1');
  // Strip `w-` from every `data-w-*` literal anywhere in the JS source.
  out = out.replace(/data-w-([a-zA-Z0-9-]+)/g, 'data-$1');
  // Order matters: replace the longer compound strings first so we don't
  // double-strip (e.g. " w-mod-" before "w-mod-").
  out = out.split(' w-mod-').join(' mod-');
  // For every Webflow class on the whitelist, rewrite every standalone
  // appearance regardless of surrounding punctuation (`.w-foo`, `"w-foo"`,
  // `[class*="w-foo"]`, …). Word boundaries protect us from clobbering
  // substrings inside longer identifiers.
  // Sort longest first so e.g. `w-dropdown-toggle` is replaced before
  // `w-dropdown` would otherwise consume just the prefix.
  const sorted = [...WF_EXACT].filter(c => c.startsWith('w-'))
    .sort((a, b) => b.length - a.length);
  for (const cls of sorted) {
    const renamed = safeRename(cls);
    if (renamed === cls) continue;
    const escaped = cls.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${escaped}\\b`, 'g'), renamed);
  }
  return out;
}

// ─── Walker ───────────────────────────────────────────────────────────────────

function walk(dir, fn) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, fn);
    else fn(full);
  }
}

let stats = { html: 0, css: 0, js: 0 };

// keepWebflowJs:true (default) ships the MIT-licensed webflow.js bundle for
// pixel-perfect IX2 + slider/tabs/dropdown/nav animations. site-ui.js stages
// alongside it as Astro ViewTransitions reinit hook + future supplements.
// keepWebflowJs:false → vanilla-only mode (slimmer, no IX2 animations).
const KEEP_WEBFLOW_JS = PROJ_CFG.keepWebflowJs !== false;
const repoUiJs = path.join(REPO_ROOT, 'site-ui.js');
const repoJq   = path.join(REPO_ROOT, 'jquery.min.js');
const repoWfJs = path.join(REPO_ROOT, 'webflow.js');
const outJsDir = path.join(ROOT, 'js');
const outWfJs  = path.join(outJsDir, 'webflow.js');
if (!fs.existsSync(outJsDir)) fs.mkdirSync(outJsDir, { recursive: true });

if (!KEEP_WEBFLOW_JS && fs.existsSync(outWfJs)) {
  fs.rmSync(outWfJs);
  console.log(`  removed ${path.relative(ROOT, outWfJs)} (keepWebflowJs:false)`);
} else if (KEEP_WEBFLOW_JS && !fs.existsSync(outWfJs) && fs.existsSync(repoWfJs)) {
  // Re-stage webflow.js in case a previous run deleted it.
  fs.copyFileSync(repoWfJs, outWfJs);
}
if (fs.existsSync(repoUiJs)) fs.copyFileSync(repoUiJs, path.join(outJsDir, 'site-ui.js'));
if (fs.existsSync(repoJq))   fs.copyFileSync(repoJq,   path.join(outJsDir, 'jquery.min.js'));

// Resale-safety: drop the Webflow icon SVG asset (pure Webflow brand mark,
// only referenced by template-info showcase pages).
const wfIcon = path.join(ROOT, 'images', 'webflow-icon.svg');
if (fs.existsSync(wfIcon)) { fs.rmSync(wfIcon); console.log(`  removed ${path.relative(ROOT, wfIcon)}`); }

walk(ROOT, full => {
  if (full.endsWith('.html')) {
    fs.writeFileSync(full, processHtml(fs.readFileSync(full, 'utf8'), full), 'utf8');
    stats.html++;
  } else if (full.endsWith('.css')) {
    fs.writeFileSync(full, processCss(fs.readFileSync(full, 'utf8')), 'utf8');
    stats.css++;
  } else if (full.endsWith('.js')) {
    // Skip our own staged scripts to avoid double-processing.
    if (/[\/\\]js[\/\\](?:site-ui|jquery\.min)\.js$/.test(full)) return;
    fs.writeFileSync(full, processJs(fs.readFileSync(full, 'utf8')), 'utf8');
    stats.js++;
  }
});

// Drop a self-contained launcher into the output so the folder is portable —
// double-click `start.cmd` on any Windows box with Node installed.
const HERE = __dirname;
for (const [src, dst] of [
  ['serve.js',          'serve.js'],
  ['start-template.cmd','start.cmd'],
]) {
  const from = path.join(HERE, src);
  const to   = path.join(ROOT, dst);
  if (fs.existsSync(from)) fs.copyFileSync(from, to);
}

console.log(`post-process: html=${stats.html}  css=${stats.css}  js=${stats.js}  (${ROOT})`);
