/**
 * build-maps.js
 *
 * Per-project CSS analyzer.
 *
 * Reads {NAME}.webflow/css/{NAME}.webflow.css → emits:
 *   • class-tw-full.json        — base class → TW utilities + props to strip
 *   • responsive-tw-map.json    — class → @media-prefix → TW utilities
 *   • media-display-classes.json — display-only @media classes
 *   • tailwind.config.js        — theme.extend tokens derived from :root vars
 *                                 + auto-extended spacing + font-size scales
 *
 * Existing files are backed up to *.bak on first run, then overwritten.
 *
 * Heuristic prop→TW mapper covers ~80% of declarations:
 *   spacing, sizing, flex/grid alignment, gap, position, typography,
 *   color (theme-resolved), border-radius, opacity, overflow, cursor, z-index.
 * Anything not mapped lands in `keep` and remains in custom.css verbatim.
 *
 * Usage: node build-maps.js
 */

const fs = require('fs');
const path = require('path');
const postcss = require('postcss');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'project.config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`build-maps.js: project.config.json not found`);
  process.exit(1);
}
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const NAME = CONFIG.name;
const SRC_CSS_DIR = path.join(__dirname, `${NAME}.webflow`, 'css');

function findSiteCss() {
  if (!fs.existsSync(SRC_CSS_DIR)) {
    throw new Error(`CSS dir not found: ${SRC_CSS_DIR} — run fetch-cms.js + transform-tw-v4.js first`);
  }
  const files = fs.readdirSync(SRC_CSS_DIR);
  const exact = files.find(f => f === `${NAME}.webflow.css`);
  if (exact) return path.join(SRC_CSS_DIR, exact);
  const fallback = files.find(f => f.endsWith('.webflow.css') && f !== 'webflow.css');
  if (!fallback) throw new Error(`No site CSS in ${SRC_CSS_DIR}`);
  return path.join(SRC_CSS_DIR, fallback);
}

// ─── BREAKPOINT MAP ───────────────────────────────────────────────────────────
const BPMAP = {
  'max-width: 479px': 'max-sm',
  'max-width: 767px': 'max-md',
  'max-width: 991px': 'max-lg',
  'min-width: 1280px': 'xl',
  'min-width: 1440px': '2xl',
  'min-width: 1920px': '3xl',
};

// ─── BASE SPACING SCALE (saasix-derived; auto-extended below) ─────────────────
const BASE_SPACING = {
  '0':'0','1':'1px','2':'4px','3':'5px','4':'8px','5':'10px','6':'12px',
  '7':'15px','8':'16px','9':'20px','10':'24px','11':'25px','12':'30px',
  '14':'32px','16':'40px','18':'50px','20':'52px','22':'60px','24':'80px',
  '26':'100px','28':'120px','30':'130px','px':'1px',
};
let SPACING_SCALE = { ...BASE_SPACING };
let SCALE_LOOKUP  = invert(SPACING_SCALE);

function invert(o) { const r = {}; for (const [k, v] of Object.entries(o)) r[v] = k; return r; }

// ─── HEURISTIC PROP → TW MAPPER ───────────────────────────────────────────────
function spacingToken(value) {
  const v = value.trim();
  if (v === '0' || v === '0px') return '0';
  if (SCALE_LOOKUP[v])          return SCALE_LOOKUP[v];
  if (/^-?\d+(?:\.\d+)?(px|%|em|rem|vh|vw)$/.test(v)) return `[${v}]`;
  if (v === 'auto')             return 'auto';
  return null;
}

function tokenWrap(prefix, value, allowKeyword = false, isRadius = false) {
  if (allowKeyword) {
    if (value === 'auto')  return [`${prefix}-auto`];
    if (value === '100%')  return [`${prefix}-full`];
    if (value === '100vw') return [`${prefix}-screen`];
    if (value === '100vh' && prefix === 'h') return ['h-screen'];
    if (value === 'fit-content') return [`${prefix}-fit`];
    if (value === 'min-content') return [`${prefix}-min`];
    if (value === 'max-content') return [`${prefix}-max`];
  }
  if (isRadius) {
    if (value === '0' || value === '0px') return ['rounded-none'];
    if (value === '9999px' || value === '50%' || value === '100%') return ['rounded-full'];
    // Tailwind's borderRadius scale ≠ spacing scale — always arbitrary.
    if (/^-?\d+(?:\.\d+)?(px|%|em|rem)$/.test(value)) return [`rounded-[${value}]`];
    return [];
  }
  const tk = spacingToken(value);
  if (!tk) return [];
  return [`${prefix}-${tk}`];
}

function shorthandSpacing(prefix, v) {
  const parts = v.split(/\s+/);
  if (parts.length === 1) {
    const tk = spacingToken(parts[0]);
    return tk ? [`${prefix}-${tk}`] : [];
  }
  if (parts.length === 2) {
    const [y, x] = parts;
    const yt = spacingToken(y), xt = spacingToken(x);
    const r = [];
    if (yt) r.push(`${prefix}y-${yt}`);
    if (xt) r.push(`${prefix}x-${xt}`);
    return r;
  }
  if (parts.length === 4) {
    const [t, ri, b, l] = parts;
    const out = [];
    const tt = spacingToken(t);  if (tt) out.push(`${prefix}t-${tt}`);
    const rt = spacingToken(ri); if (rt) out.push(`${prefix}r-${rt}`);
    const bt = spacingToken(b);  if (bt) out.push(`${prefix}b-${bt}`);
    const lt = spacingToken(l);  if (lt) out.push(`${prefix}l-${lt}`);
    return out;
  }
  return [];
}

function mapDisplay(v) {
  const m = {
    'block':'block','inline':'inline','inline-block':'inline-block',
    'flex':'flex','inline-flex':'inline-flex',
    'grid':'grid','inline-grid':'inline-grid',
    'none':'hidden','table':'table','contents':'contents',
  };
  return m[v] ? [m[v]] : [];
}

function mapFlexDir(v) {
  const m = { 'row':'flex-row','row-reverse':'flex-row-reverse','column':'flex-col','column-reverse':'flex-col-reverse' };
  return m[v] ? [m[v]] : [];
}

function mapFlexFlow(v) {
  const out = [];
  for (const tok of v.split(/\s+/)) {
    const dir = mapFlexDir(tok);
    if (dir.length) out.push(...dir);
    else if (tok === 'wrap')         out.push('flex-wrap');
    else if (tok === 'nowrap')       out.push('flex-nowrap');
    else if (tok === 'wrap-reverse') out.push('flex-wrap-reverse');
  }
  return out;
}

function mapJustify(v) {
  const m = {
    'flex-start':'justify-start','start':'justify-start',
    'flex-end':'justify-end','end':'justify-end',
    'center':'justify-center','space-between':'justify-between',
    'space-around':'justify-around','space-evenly':'justify-evenly','normal':'justify-normal',
  };
  return m[v] ? [m[v]] : [];
}

function mapAlignItems(v) {
  const m = {
    'flex-start':'items-start','start':'items-start',
    'flex-end':'items-end','end':'items-end',
    'center':'items-center','baseline':'items-baseline','stretch':'items-stretch',
  };
  return m[v] ? [m[v]] : [];
}

let THEME_COLORS = {}; // hex → name

function normalizeColor(v) {
  v = v.trim().toLowerCase();
  if (v.startsWith('#')) return v;
  if (v === 'transparent') return 'transparent';
  if (v === 'white')       return '#ffffff';
  if (v === 'black')       return '#000000';
  return null;
}

function colorToken(prefix, v) {
  const hex = normalizeColor(v);
  if (!hex) return [];
  const name = THEME_COLORS[hex];
  return name ? [`${prefix}-${name}`] : [`${prefix}-[${v}]`];
}

function mapProp(prop, value) {
  const v = value.trim();
  switch (prop) {
    case 'padding-top':       return tokenWrap('pt', v);
    case 'padding-bottom':    return tokenWrap('pb', v);
    case 'padding-left':      return tokenWrap('pl', v);
    case 'padding-right':     return tokenWrap('pr', v);
    case 'padding':           return shorthandSpacing('p', v);
    case 'margin-top':        return tokenWrap('mt', v);
    case 'margin-bottom':     return tokenWrap('mb', v);
    case 'margin-left':       return tokenWrap('ml', v);
    case 'margin-right':      return tokenWrap('mr', v);
    case 'margin':            return shorthandSpacing('m', v);
    case 'width':             return tokenWrap('w', v, true);
    case 'height':            return tokenWrap('h', v, true);
    case 'max-width':         return tokenWrap('max-w', v, true);
    case 'min-width':         return tokenWrap('min-w', v, true);
    case 'max-height':        return tokenWrap('max-h', v, true);
    case 'min-height':        return tokenWrap('min-h', v, true);
    case 'display':           return mapDisplay(v);
    case 'flex-direction':    return mapFlexDir(v);
    case 'flex-flow':         return mapFlexFlow(v);
    case 'justify-content':   return mapJustify(v);
    case 'align-items':       return mapAlignItems(v);
    case 'gap':               return tokenWrap('gap', v);
    case 'column-gap':
    case 'grid-column-gap':   return tokenWrap('gap-x', v);
    case 'row-gap':
    case 'grid-row-gap':      return tokenWrap('gap-y', v);
    case 'position':          return ['static','fixed','absolute','relative','sticky'].includes(v) ? [v] : [];
    case 'top':               return tokenWrap('top', v);
    case 'right':             return tokenWrap('right', v);
    case 'bottom':            return tokenWrap('bottom', v);
    case 'left':              return tokenWrap('left', v);
    case 'z-index':           return /^\d+$/.test(v) ? [`z-${v}`] : [];
    case 'opacity': {
      const n = parseFloat(v);
      if (!isFinite(n)) return [];
      return [`opacity-${Math.round(n * 100)}`];
    }
    case 'overflow':
    case 'overflow-x':
    case 'overflow-y':
      return ['visible','hidden','scroll','auto'].includes(v)
        ? [`${prop === 'overflow' ? 'overflow' : prop}-${v}`] : [];
    case 'cursor':            return /^[a-z-]+$/.test(v) ? [`cursor-${v}`] : [];
    case 'pointer-events':    return ['none','auto'].includes(v) ? [`pointer-events-${v}`] : [];
    case 'visibility':        return v === 'visible' ? ['visible'] : v === 'hidden' ? ['invisible'] : [];
    case 'box-sizing':        return v === 'border-box' ? ['box-border'] : v === 'content-box' ? ['box-content'] : [];
    case 'text-align':        return ['left','center','right','justify'].includes(v) ? [`text-${v}`] : [];
    case 'text-transform': {
      if (v === 'uppercase')  return ['uppercase'];
      if (v === 'lowercase')  return ['lowercase'];
      if (v === 'capitalize') return ['capitalize'];
      if (v === 'none')       return ['normal-case'];
      return [];
    }
    case 'text-decoration':
    case 'text-decoration-line': {
      if (v === 'underline')    return ['underline'];
      if (v === 'line-through') return ['line-through'];
      if (v === 'overline')     return ['overline'];
      if (v === 'none')         return ['no-underline'];
      return [];
    }
    case 'flex': {
      if (v === 'none')      return ['flex-none'];
      if (v === 'auto' || v === '1 1 auto') return ['flex-auto'];
      if (v === 'initial' || v === '0 1 auto') return ['flex-initial'];
      if (v === '1' || v === '1 1 0%' || v === '1 1 0' || v === '1 0 0%') return ['flex-1'];
      return [];
    }
    case 'border': {
      // Shorthand: "{width} {style} {color}" — split + map known parts.
      const out = [], stripped = [];
      const tokens = v.split(/\s+/);
      for (const t of tokens) {
        if (/^\d+(?:\.\d+)?px$/.test(t)) {
          const w = mapProp('border-width', t);
          if (w.length) { out.push(...w); stripped.push('border-width'); }
        } else if (['solid','dashed','dotted','double','none'].includes(t)) {
          if (t !== 'solid') out.push(`border-${t}`);
        } else {
          const c = colorToken('border', t);
          if (c.length) out.push(...c);
        }
      }
      return out;
    }
    case 'font-weight': {
      const n = parseInt(v, 10);
      if (n) {
        const map = { 100:'thin',200:'extralight',300:'light',400:'normal',500:'medium',600:'semibold',700:'bold',800:'extrabold',900:'black' };
        return map[n] ? [`font-${map[n]}`] : [`font-[${n}]`];
      }
      return [];
    }
    case 'border-radius':     return tokenWrap('rounded', v, true, true);
    case 'border-width': {
      if (!/^\d+(?:\.\d+)?px$/.test(v)) return [];
      const n = parseInt(v, 10);
      if (n === 0) return ['border-0'];
      if (n === 1) return ['border'];
      if ([2, 4, 8].includes(n)) return [`border-${n}`];
      return [`border-[${v}]`];
    }
    case 'background-color':  return colorToken('bg', v);
    case 'color':             return colorToken('text', v);
    case 'border-color':      return colorToken('border', v);
    default:                  return [];
  }
}

// ─── PROPS NEVER STRIPPED (keep in CSS) ───────────────────────────────────────
const KEEP_ALWAYS = new Set([
  'background-image','backdrop-filter','-webkit-backdrop-filter','box-shadow',
  'filter','transition','animation','-webkit-text-fill-color','-webkit-background-clip',
  'background-clip','-webkit-text-stroke-width','-webkit-text-stroke-color',
  'transform-origin','perspective','transform','letter-spacing','background-size',
  'background-position','background-repeat','transition-property','transition-duration',
  'grid-template-columns','grid-template-rows','grid-auto-columns',
  'content','clip-path','mask','object-fit','object-position','will-change',
  'font-family','font-size','line-height',
]);

// ─── EXTRACT THEME TOKENS FROM :root ──────────────────────────────────────────
function extractThemeTokens(cssText) {
  const root = postcss.parse(cssText);
  const vars = {};
  root.walkRules(':root', rule => {
    rule.walkDecls(decl => {
      if (decl.prop.startsWith('--')) vars[decl.prop.slice(2)] = decl.value.trim();
    });
  });
  const colors = {};
  for (const [k, v] of Object.entries(vars)) {
    if (/^#[0-9a-f]{3,8}$/i.test(v) || /^rgba?\(/i.test(v) || ['transparent','currentColor'].includes(v)) {
      colors[k] = v;
      const hex = v.startsWith('#') ? v.toLowerCase() : v;
      THEME_COLORS[hex] = k;
    }
  }
  return { vars, colors };
}

// ─── DERIVE SCALES (spacing + font-size from raw CSS) ─────────────────────────
function deriveScales(cssText) {
  const root = postcss.parse(cssText);
  const spacings = new Set(), fontSizes = new Set();
  root.walkDecls(decl => {
    const v = decl.value.trim();
    if (/^(padding|margin|gap|grid-(?:column|row)-gap|column-gap|row-gap|top|left|right|bottom)/.test(decl.prop)) {
      for (const tok of v.split(/\s+/)) {
        if (/^\d+(\.\d+)?px$/.test(tok)) spacings.add(tok);
      }
    }
    if (decl.prop === 'font-size' && /^\d+(\.\d+)?px$/.test(v)) fontSizes.add(v);
  });
  return {
    spacings: [...spacings].sort((a, b) => parseFloat(a) - parseFloat(b)),
    fontSizes: [...fontSizes].sort((a, b) => parseFloat(a) - parseFloat(b)),
  };
}

// ─── ANALYZE CSS ──────────────────────────────────────────────────────────────
function analyzeCss(cssText) {
  const root = postcss.parse(cssText);
  const baseClasses = {};
  const respClasses = {};
  const mediaDisplay = new Set();

  root.walkRules(rule => {
    const sel = rule.selector;
    const classes = [];
    for (const oneSel of sel.split(',').map(s => s.trim())) {
      const m = oneSel.match(/^\.([a-zA-Z][a-zA-Z0-9_-]*)$/);
      if (m && !m[1].startsWith('w-')) classes.push(m[1]);
    }
    if (!classes.length) return;

    const parent = rule.parent;
    let bpPrefix = null;
    if (parent && parent.type === 'atrule' && parent.name === 'media') {
      const mqPart = parent.params.replace(/^screen\s+and\s+\(/, '').replace(/\)$/, '').trim();
      bpPrefix = BPMAP[mqPart] || null;
      if (!bpPrefix) return;
    }

    const tw = [], strip = [], keep = [];
    let onlyDisplay = true;
    let hasDecl = false;
    rule.walkDecls(decl => {
      hasDecl = true;
      if (decl.prop !== 'display') onlyDisplay = false;
      if (decl.value.includes('var(')) { keep.push(decl.prop); return; }
      if (KEEP_ALWAYS.has(decl.prop))  { keep.push(decl.prop); return; }
      const mapped = mapProp(decl.prop, decl.value);
      if (mapped.length) { tw.push(...mapped); strip.push(decl.prop); }
      else               { keep.push(decl.prop); }
    });
    if (!hasDecl) return;

    for (const cls of classes) {
      if (bpPrefix) {
        respClasses[cls] ||= {};
        respClasses[cls][bpPrefix] ||= { tw: [], keep: {} };
        respClasses[cls][bpPrefix].tw.push(...tw);
        for (const k of keep) respClasses[cls][bpPrefix].keep[k] = true;
        if (onlyDisplay) mediaDisplay.add(cls);
      } else {
        baseClasses[cls] ||= { tw: [], strip: [], keep: [], fully_removable: false };
        baseClasses[cls].tw.push(...tw);
        baseClasses[cls].strip.push(...strip);
        baseClasses[cls].keep.push(...keep);
      }
    }
  });

  // Dedupe
  for (const c of Object.values(baseClasses)) {
    c.tw    = [...new Set(c.tw)];
    c.strip = [...new Set(c.strip)];
    c.keep  = [...new Set(c.keep)];
    c.fully_removable = (c.keep.length === 0 && c.strip.length > 0);
  }
  for (const r of Object.values(respClasses)) {
    for (const p of Object.values(r)) p.tw = [...new Set(p.tw)];
  }

  return { baseClasses, respClasses, mediaDisplay };
}

// ─── BUILD tailwind.config.js ─────────────────────────────────────────────────
function buildTwConfig({ colors, vars, spacings, fontSizes }) {
  // Extend (not replace) base spacing scale with project-derived values.
  // Normalize "0px" → "0" so we don't add a duplicate of the base "0" entry.
  const extended = { ...SPACING_SCALE };
  const existingValues = new Set(Object.values(extended));
  let nextKey = 100;
  for (const raw of spacings) {
    const sp = (raw === '0px') ? '0' : raw;
    if (existingValues.has(sp)) continue;
    while (Object.keys(extended).includes(String(nextKey))) nextKey++;
    extended[String(nextKey++)] = sp;
    existingValues.add(sp);
  }
  // Font scale: assign sequential keys.
  const fontScale = {};
  let fi = 1;
  for (const fs of fontSizes) fontScale[`fs-${fi++}`] = fs;

  const colorEntries     = Object.entries(colors).map(([k, v]) => `        '${k}': '${v}',`).join('\n');
  const spacingEntries   = Object.entries(extended).map(([k, v]) => `        '${k}': '${v}',`).join('\n');
  const fontSizeEntries  = Object.entries(fontScale).map(([k, v]) => `        '${k}': ['${v}', { lineHeight: '1.4' }],`).join('\n');

  return `/** @type {import('tailwindcss').Config} */
// AUTO-GENERATED by build-maps.js — do not edit by hand.
// Regenerate: node build-maps.js
module.exports = {
  content: ['../output-2-tailwind/**/*.html'],
  theme: {
    screens: {
      'sm':  { max: '479px'  },
      'md':  { max: '767px'  },
      'lg':  { max: '991px'  },
      'xl':  { max: '1279px' },
      '2xl': { max: '1439px' },
      '3xl': { max: '1919px' },
    },
    extend: {
      colors: {
${colorEntries}
      },
      spacing: {
${spacingEntries}
      },
      fontSize: {
${fontSizeEntries}
      },
    },
  },
  plugins: [],
};
`;
}

// ─── WRITE WITH BACKUP ────────────────────────────────────────────────────────
function writeWithBackup(filePath, content) {
  if (fs.existsSync(filePath)) {
    const bak = filePath + '.bak';
    if (!fs.existsSync(bak)) {
      fs.copyFileSync(filePath, bak);
      console.log(`   📦 backup → ${path.basename(bak)}`);
    }
  }
  fs.writeFileSync(filePath, content);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(function main() {
  const sitePath = findSiteCss();
  console.log(`\n📐 build-maps — analyzing ${path.relative(__dirname, sitePath).replace(/\\/g, '/')}`);
  const cssText = fs.readFileSync(sitePath, 'utf8');

  // 1. Theme tokens FIRST so colorToken() lookup is populated for class analysis.
  const { vars, colors } = extractThemeTokens(cssText);
  console.log(`   :root vars  : ${Object.keys(vars).length}  (colors detected: ${Object.keys(colors).length})`);

  // 2. Derive scales (used to build extended spacing scale + font scale).
  const { spacings, fontSizes } = deriveScales(cssText);
  console.log(`   spacings    : ${spacings.length} unique px values`);
  console.log(`   font-sizes  : ${fontSizes.length} unique px values`);

  // 3. Class analysis.
  const { baseClasses, respClasses, mediaDisplay } = analyzeCss(cssText);
  console.log(`   base classes: ${Object.keys(baseClasses).length}`);
  console.log(`   resp classes: ${Object.keys(respClasses).length}`);
  console.log(`   display-only @media: ${mediaDisplay.size}`);

  // 4. Coverage report.
  let mappedDecls = 0, totalDecls = 0;
  for (const c of Object.values(baseClasses)) {
    mappedDecls += c.strip.length;
    totalDecls  += c.strip.length + c.keep.length;
  }
  for (const r of Object.values(respClasses)) {
    for (const p of Object.values(r)) {
      mappedDecls += p.tw.length;
      totalDecls  += p.tw.length + Object.keys(p.keep).length;
    }
  }
  const pct = totalDecls ? Math.round(100 * mappedDecls / totalDecls) : 0;
  console.log(`   coverage    : ${mappedDecls}/${totalDecls} declarations mapped (${pct}%)`);

  // 5. Write outputs (with first-time .bak backup).
  writeWithBackup(path.join(__dirname, 'class-tw-full.json'),         JSON.stringify(baseClasses,  null, 2));
  writeWithBackup(path.join(__dirname, 'responsive-tw-map.json'),     JSON.stringify(respClasses,  null, 2));
  writeWithBackup(path.join(__dirname, 'media-display-classes.json'), JSON.stringify([...mediaDisplay].sort(), null, 2));
  writeWithBackup(path.join(__dirname, 'tailwind.config.js'),         buildTwConfig({ colors, vars, spacings, fontSizes }));

  console.log(`\n✅ build-maps complete.`);
})();
