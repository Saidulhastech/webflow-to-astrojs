/**
 * Webflow → Tailwind v4 — Final Build
 *
 * Fixes in this version:
 *  1. Remaining .w-checkbox rules removed from custom.css
 *  2. Accordion open/close CSS icon (+ → ×) via CSS sibling/parent selectors
 *  3. Unused CSS removed (landing-page showcase classes + truly unused)
 *  4. Responsive media queries converted to Tailwind prefix classes in HTML
 *     (compound selectors and complex values stay as CSS)
 *  5. Semantic class names always kept — responsive CSS chain intact
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const cheerio = require('cheerio');

const DIR = __dirname;
const CONFIG_PATH = path.join(DIR, 'project.config.json');
const CONFIG = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH,'utf8')) : null;
const NAME   = CONFIG?.name || null;

const INPUT_DIR  = process.argv[2] || (NAME ? path.join(DIR, `${NAME}.webflow`)            : '../saasix-webflow');
const OUTPUT_DIR = process.argv[3] || (NAME ? path.join(DIR, `output-${NAME}-tailwind-v4`) : '../output-2-tailwind-v4');

const CLASS_TW_FULL    = JSON.parse(fs.readFileSync(path.join(DIR,'class-tw-full.json'),'utf8'));
const RESPONSIVE_TW    = JSON.parse(fs.readFileSync(path.join(DIR,'responsive-tw-map.json'),'utf8'));
const MEDIA_DISP_SKIP  = new Set(JSON.parse(fs.readFileSync(path.join(DIR,'media-display-classes.json'),'utf8')));

function log(msg) { process.stdout.write(msg+'\n'); }
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); }
function copyDir(src,dest) {
  ensureDir(dest);
  for (const e of fs.readdirSync(src,{withFileTypes:true})) {
    const s=path.join(src,e.name),d=path.join(dest,e.name);
    e.isDirectory() ? copyDir(s,d) : fs.copyFileSync(s,d);
  }
}

// ─── WEBFLOW CLEANUP ──────────────────────────────────────────────────────────

const WF_ATTRS = [
  'data-wf-page','data-wf-site','data-wf-page-id','data-wf-element-id','data-wf-ignore',
  'data-wf-domain','data-wf-status',
  'data-w-id','data-w-tab','data-wait','data-animation','data-collapse','data-duration',
  'data-easing','data-easing2','data-delay','data-autoplay','data-autoplay-limit',
  'data-hide-arrows','data-disable-swipe','data-nav-spacing','data-duration-in',
  'data-duration-out','data-current','data-hover','data-infinite',
  'data-widget-latlng','data-widget-style','data-widget-tooltip','data-widget-zoom',
];
const WF_RENAMES = {};
// Keep framework w-* classes — webflow.css framework rules drive the layout.
const WF_STRIP = [
  /^w-mod-js$/,/^w-mod-touch$/,/^w-webflow-badge$/,/^w-to-.+$/,
];
const IX2_OVERLAYS=['button-hover-overlay','price-plan-hover-overlay',
  'text-animation-overlay','image-animation-overlay','hero-title-overlay'];
const DYN_PH={
  'blog-title':'Blog Post Title Goes Here','blog-author-link':'Author Name',
  'blog-category-link':'Category','integration-title':'Integration Name',
  'integration-summary':'Brief description of this integration.',
};

function cleanStyle(style,cls){
  if(!style) return '';
  if(IX2_OVERLAYS.some(c=>(cls||'').split(/\s+/).includes(c))) return '';
  const hasTx=/translate3d/.test(style),hasOp=/opacity\s*:\s*0/.test(style);
  if(!hasTx&&!hasOp) return style;
  return style
    .replace(/-webkit-transform\s*:[^;]+(;|$)\s*/g,'')
    .replace(/-moz-transform\s*:[^;]+(;|$)\s*/g,'')
    .replace(/-ms-transform\s*:[^;]+(;|$)\s*/g,'')
    .replace(/\btransform\s*:[^;]+(;|$)\s*/g,'')
    .replace(/opacity\s*:\s*0\s*(;|$)\s*/g,'')
    .trim().replace(/;$/,'');
}

// ─── CLASS TRANSFORMER ─────────────────────────────────────────────────────────
function transformClasses(classList){
  if(!classList) return '';
  const parts=classList.split(/\s+/).filter(Boolean);
  const result=[],seen=new Set();
  function add(c){if(c&&!seen.has(c)){seen.add(c);result.push(c);}}

  for(const cls of parts){
    if(WF_RENAMES[cls]){add(WF_RENAMES[cls]);continue;}
    if(WF_STRIP.some(p=>p.test(cls))) continue;

    // Always keep semantic class name
    add(cls);

    // Add base TW utilities
    const info=CLASS_TW_FULL[cls];
    if(info&&info.tw) info.tw.forEach(tw=>add(tw));

    // Add responsive TW prefix classes
    const resp=RESPONSIVE_TW[cls];
    if(resp){
      for(const [prefix,data] of Object.entries(resp)){
        if(data.tw){
          data.tw.forEach(tw=>{
            if(tw) add(`${prefix}:${tw}`);
          });
        }
      }
    }
  }
  return result.join(' ');
}

// ─── DYNAMIC / HELPERS ─────────────────────────────────────────────────────────
function fixDynamic(html){
  const $=cheerio.load(html,{decodeEntities:false});
  $('img[src*="placeholder.60f9b1840c"]').each((_,el)=>$(el).attr('src','../images/placeholder.svg').removeAttr('srcset'));
  $('[class*="w-dyn-bind-empty"]').each((_,el)=>{
    const tag=el.tagName.toLowerCase(),cls=$(el).attr('class')||'';
    let ph='';
    for(const [k,v] of Object.entries(DYN_PH)){if(cls.includes(k)){ph=v;break;}}
    if(!ph) ph=tag==='img'?'':'Content placeholder';
    if(tag!=='img'&&!$(el).text().trim())$(el).text(ph);
  });
  $('.w-dyn-empty').attr('style','display:none');
  return $.html();
}
function rewriteToRoot(html){
  return html
    .replace(/href="\.\.\/([^"]+)"/g,'href="$1"')
    .replace(/src="\.\.\/([^"]+)"/g,'src="$1"')
    .replace(/srcset="([^"]*)"/g,(_,s)=>'srcset="'+s.replace(/\.\.\//g,'')+'"');
}

// ─── HTML TRANSFORM ─────────────────────────────────────────────────────────────
function transformHTML(content,prefix){
  // Minimal transform — preserve Webflow scripts, data attrs, inline styles.
  // Only swap CSS link tags + additively inject TW classes for known custom classes.
  content=content.replace(/<!--\s*This site was created in Webflow[^>]*-->/g,'');
  const $=cheerio.load(content,{decodeEntities:false});
  $('meta[name="generator"]').remove();
  $('link[rel="stylesheet"]').remove();
  $('head').append(`\n  <link href="${prefix}css/custom.css" rel="stylesheet">`);
  $('head').append(`\n  <link href="${prefix}css/tailwind.css" rel="stylesheet">`);

  let injected=0;
  $('*').each((_,el)=>{
    const a=el.attribs||{};
    const rawCls=a['class'];
    if(rawCls){
      const t=transformClasses(rawCls);
      if(t!==rawCls) injected++;
      if(t) $(el).attr('class',t);
    }
  });
  let out=$.html();
  out='<!DOCTYPE html>\n'+out.replace(/^<!DOCTYPE html>/i,'').trim();
  return {html:out,injected};
}

// ─── CUSTOM CSS BUILDER ──────────────────────────────────────────────────────────
function buildCustomCSS(inputDir){
  // Design-faithful: ship normalize + webflow + site CSS verbatim alongside Tailwind.
  // Webflow's CDN merges all three into a single .webflow.css when published —
  // treat missing framework files as empty strings so live-fetched projects work.
  const cssDir       = path.join(inputDir,'css');
  const readOpt      = (p) => fs.existsSync(p) ? fs.readFileSync(p,'utf8') : '';
  const normalizeCSS = readOpt(path.join(cssDir,'normalize.css'));
  const webflowCSS   = readOpt(path.join(cssDir,'webflow.css'));
  const siteCssName  = fs.readdirSync(cssDir)
    .find(f => /\.webflow\.css$/.test(f) && f !== 'webflow.css');
  if (!siteCssName) {
    throw new Error(`buildCustomCSS: no *.webflow.css in ${cssDir}`);
  }
  const customCSS    = fs.readFileSync(path.join(cssDir, siteCssName),'utf8');
  return [normalizeCSS, webflowCSS, customCSS].filter(Boolean).join('\n\n');
}

function buildCustomCSS_LEGACY_UNUSED(inputDir){
  let css=fs.readFileSync(path.join(inputDir,'css','saasix-template.webflow.css'),'utf8');

  const fonts=[
    `@font-face{font-family:Manrope;src:url('../fonts/Manrope-Regular.ttf') format('truetype');font-weight:400;font-style:normal;font-display:swap;}`,
    `@font-face{font-family:Manrope;src:url('../fonts/Manrope-Medium.ttf') format('truetype');font-weight:500;font-style:normal;font-display:swap;}`,
    `@font-face{font-family:Manrope;src:url('../fonts/Manrope-SemiBold.ttf') format('truetype');font-weight:600;font-style:normal;font-display:swap;}`,
    `@font-face{font-family:Manrope;src:url('../fonts/Manrope-Bold.ttf') format('truetype');font-weight:700;font-style:normal;font-display:swap;}`,
  ].join('\n');

  css=css.replace(/@font-face\s*\{[^}]+\}/g,'');

  // Rename state classes
  css=css.replace(/\.w--current/g,'.is-current').replace(/\.w--open/g,'.is-open')
        .replace(/\.w--tab-active/g,'.is-active').replace(/\.w--redirected-checked/g,'.is-checked')
        .replace(/\.w--redirected-focus/g,'.is-focused');

  // Remove ALL w-* framework rules (including w-checkbox variants)
  css=css.replace(/(?:^|\n)((?:\.w-[a-zA-Z0-9_-]+\s*,?\s*)+)\s*\{[^}]*\}/g,(match,sel)=>{
    const parts=sel.split(',').map(s=>s.trim()).filter(Boolean);
    return parts.every(s=>/^\.w-[a-zA-Z0-9_-]+$/.test(s))?'':match;
  });
  // Also remove any remaining .w-* rules (pseudo-selectors, compound)
  css=css.replace(/(?:^|\n)\s*\.w-[a-zA-Z0-9_-]+[^{]*\{[^}]*\}/gm,'');
  css=css.replace(/#[A-Za-z0-9-]+\.w-node-[a-zA-Z0-9_-]+\s*\{[^}]*\}/g,'');
  css=css.replace(/@media[^{]+\{\s*\.w-layout-blockcontainer\s*\{[^}]*\}\s*\}/g,'');

  // Remove standalone base element rules
  css=css.replace(/(?:^|\n)body\s*\{[^}]+\}/gm,'');
  css=css.replace(/(?:^|\n)h[1-6]\s*\{[^}]+\}/gm,'');
  css=css.replace(/(?:^|\n)p\s*\{[^}]+\}/gm,'');
  css=css.replace(/(?:^|\n)a\s*\{[^}]+\}/gm,'');
  css=css.replace(/(?:^|\n)ul,\s*ol\s*\{[^}]+\}/gm,'');
  css=css.replace(/(?:^|\n)strong\s*\{[^}]+\}/gm,'');
  css=css.replace(/(?:^|\n)blockquote\s*\{[^}]+\}/gm,'');
  css=css.replace(/(?:^|\n)figure\s*\{[^}]+\}/gm,'');

  // Fix main-container
  css=css.replace(/(\.main-container\s*\{)(\s*max-width)/,'$1\n  margin-left:auto;\n  margin-right:auto;\n  display:block;$2');

  // Remove unused landing-page showcase CSS (index.html was skipped)
  css=css.replace(/(?:^|\n)\s*\.landing-page-[a-zA-Z0-9_-]+[^{]*\{[^}]*\}/gm,'');
  css=css.replace(/(?:^|\n)\s*\.landig-page-[a-zA-Z0-9_-]+[^{]*\{[^}]*\}/gm,'');
  css=css.replace(/@media[^{]+\{[^{}]*\.landing-page[^{}]*\{[^}]*\}[^{}]*\}/g,'');

  // KEEP in CSS always
  const KEEP_ALWAYS=new Set([
    'background-image','backdrop-filter','-webkit-backdrop-filter','box-shadow',
    'filter','transition','animation','-webkit-text-fill-color','-webkit-background-clip',
    'background-clip','-webkit-text-stroke-width','-webkit-text-stroke-color',
    'transform-origin','perspective','transform','letter-spacing','background-size',
    'background-position','background-repeat','transition-property','transition-duration',
    'grid-template-columns','grid-template-rows','grid-auto-columns','text-transform',
  ]);

  // Strip movable props from BASE rules only (split at first @media)
  const mediaStart=css.search(/@media\s/);
  const baseCSS=mediaStart>-1?css.slice(0,mediaStart):css;
  const mediaCSS=mediaStart>-1?css.slice(mediaStart):'';

  const processedBase=baseCSS.replace(
    /((?:^|\n)\s*\.([a-z][a-z0-9_-]*)(?:\.[a-z][a-z0-9_-]*)?\s*\{)([^}]+)(\})/gm,
    (match,openPart,cls,body,closePart)=>{
      const info=CLASS_TW_FULL[cls];
      if(!info||!info.strip||info.strip.length===0) return match;
      const stripSet=new Set(info.strip);
      const newLines=body.split('\n').filter(line=>{
        const t=line.trim();
        if(!t||!t.includes(':')) return true;
        const prop=t.split(':')[0].trim();
        if(KEEP_ALWAYS.has(prop)) return true;
        if(line.includes('var(')) return true;
        return !stripSet.has(prop);
      });
      const hasProps=newLines.some(l=>{
        const t=l.trim();
        return t&&t.includes(':')&&!t.startsWith('/');
      });
      if(!hasProps) return '';
      return openPart+newLines.join('\n')+closePart;
    }
  );

  // Strip responsive rules that are now in HTML as TW prefix classes
  // Remove rules from @media blocks where ALL props are now in RESPONSIVE_TW
  const processedMedia=mediaCSS.replace(
    /@media screen and \(([^)]+)\)\s*\{((?:[^{}]|\{[^}]*\})*)\}/g,
    (fullMatch, mqStr, block) => {
      const BPMAP={
        'max-width: 479px':'max-sm','max-width: 767px':'max-md',
        'max-width: 991px':'max-lg','min-width: 1280px':'xl',
        'min-width: 1440px':'2xl','min-width: 1920px':'3xl',
      };
      const prefix=BPMAP[mqStr.trim()];
      if(!prefix) return fullMatch; // Unknown breakpoint — keep as-is

      // Process each rule in this block
      const processedBlock=block.replace(
        /(\.([a-z][a-z0-9_-]*)(?:\.[a-z][a-z0-9_-]*)?\s*\{)([^}]+)(\})/g,
        (ruleMatch,openPart,cls,body,closePart)=>{
          // Compound selector or not in our map — keep
          const isCompound=openPart.trim().lstrip?.('.').includes?.('.') || openPart.match(/\.[a-z][a-z0-9_-]+\.[a-z]/);
          const respData=RESPONSIVE_TW[cls]?.[prefix];
          if(!respData) return ruleMatch;

          // Remove only the props that were successfully converted to TW
          const convertedProps=new Set();
          // Re-determine which props were converted for this class+prefix
          const keepPropsInCSS=respData.keep||{};
          const lines=body.split('\n');
          const newLines=lines.filter(line=>{
            const t=line.trim();
            if(!t||!t.includes(':')) return true;
            const prop=t.split(':')[0].trim();
            if(KEEP_ALWAYS.has(prop)) return true;
            if(line.includes('var(')) return true;
            // Keep if this prop still needs to be in CSS
            if(prop in keepPropsInCSS) return true;
            // Remove if it was converted to TW (has tw classes and not in keep)
            if(respData.tw&&respData.tw.length>0&&!(prop in keepPropsInCSS)) return false;
            return true;
          });
          const hasProps=newLines.some(l=>{const t=l.trim();return t&&t.includes(':')&&!t.startsWith('/');});
          if(!hasProps) return '';
          return openPart+newLines.join('\n')+closePart;
        }
      );

      // If block is now empty, remove the whole @media
      const hasContent=processedBlock.replace(/\s/g,'').length>0;
      if(!hasContent) return '';
      return `@media screen and (${mqStr}){${processedBlock}}`;
    }
  );

  css=processedBase+processedMedia;

  // ── Bug fixes ────────────────────────────────────────────────────────────

  // Nav border hover animation
  css=css.replace(/\.nav-menu-bottom-border\s*\{[^}]+\}/,
    `.nav-menu-bottom-border {
  background-color: var(--primary-two);
  transform-origin: left center;
  transform: scaleX(0) !important;
  transition: transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  width: 100% !important;
  height: 2px !important;
  position: absolute;
  inset: auto 0% 0%;
}
.nav-menu-wrap:hover .nav-menu-bottom-border,
.nav-menu-link.is-current ~ .nav-menu-bottom-border,
.hamburger-menu-list-item:hover .nav-menu-bottom-border { transform: scaleX(1) !important; }`
  );

  // Form inputs full width
  css=css.replace(/(\.form-input-field\s*\{)/,'$1\n  width: 100%;');

  // Custom checkbox
  const checkboxCSS=`
/* Custom checkbox (replaces w-checkbox-input) */
.checkbox {
  appearance: none; -webkit-appearance: none;
  display: inline-block; vertical-align: middle;
  flex-shrink: 0; cursor: pointer;
}
.checkbox:checked, .checkbox.is-checked {
  background-color: #363636; border-color: #6a6a6a;
}
.checkbox:checked::after, .checkbox.is-checked::after {
  content: ''; display: block;
  width: 5px; height: 9px;
  border: 2px solid #fff; border-top: 0; border-left: 0;
  transform: rotate(45deg) translate(2px, -1px); margin: auto;
}`;

  // ── Accordion open/close CSS (+ becomes ×) ──────────────────────────────
  // Structure: .faq-toggle-block > .faq-arrow-block > .faq-arrow-border (horizontal)
  //                                                 > .faq-arrow-border.v2 (vertical)
  // Open state: parent .faq-dropdown-block gets .is-open
  // IX2 was: rotate .v2 (vertical bar) 90deg → it collapses into a minus/×
  const accordionCSS=`
/* Accordion icon: + (closed) → × (open) via CSS */
.faq-arrow-border.v2 {
  transition: transform 0.3s ease, opacity 0.3s ease;
  transform: rotate(0deg);
}
.faq-dropdown-block.is-open .faq-arrow-border.v2 {
  transform: rotate(90deg);
  opacity: 0;
}
.faq-summary-block {
  overflow: hidden;
  transition: height 0.3s ease;
}
.faq-dropdown-block:not(.is-open) .faq-summary-block {
  display: none;
}
.faq-dropdown-block.is-open .faq-summary-block {
  display: block;
}
/* Accordion hover/active state for bg */
.faq-dropdown-block.is-open .faq-bg {
  opacity: 1 !important;
}`;

  css=css.replace(/\n{3,}/g,'\n\n');
  return fonts+'\n\n'+css+'\n\n'+checkboxCSS+'\n'+accordionCSS;
}

// ─── FILE WALKER ──────────────────────────────────────────────────────────────
function findHTML(dir,base=dir,out=[]){
  for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    const full=path.join(dir,e.name);
    if(e.isDirectory()){
      if(!['images','fonts','videos','css','js'].includes(e.name)) findHTML(full,base,out);
    } else if(e.name.endsWith('.html')) out.push(path.relative(base,full));
  }
  return out;
}

const SVG_PH=`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500"><rect width="800" height="500" fill="#1f2025"/><line x1="0" y1="0" x2="800" y2="500" stroke="#cfcfcf22" stroke-width="1"/><line x1="800" y1="0" x2="0" y2="500" stroke="#cfcfcf22" stroke-width="1"/><text x="400" y="250" font-family="Manrope,sans-serif" font-size="18" fill="#cfcfcf66" text-anchor="middle" dominant-baseline="middle">Image Placeholder</text></svg>`;

// ─── MAIN ─────────────────────────────────────────────────────────────────────
function main(){
  log('\n🚀 Webflow → Tailwind v4 — Final Build\n');
  log(`   Input: ${INPUT_DIR}  Output: ${OUTPUT_DIR}\n`);

  if(!fs.existsSync(INPUT_DIR)){log(`❌ ${INPUT_DIR} not found`);process.exit(1);}
  // Wipe pre-existing output so renamed/removed source files don't leave
  // stale copies behind (e.g. `Project Image.jpg` after normalize-images
  // turned it into `Project_Image.jpg`).
  if(fs.existsSync(OUTPUT_DIR)) fs.rmSync(OUTPUT_DIR,{recursive:true,force:true});
  ensureDir(OUTPUT_DIR);

  log('📁 Copying assets...');
  for(const d of ['images','fonts','videos','js']){
    const s=path.join(INPUT_DIR,d),de=path.join(OUTPUT_DIR,d);
    if(fs.existsSync(s)){copyDir(s,de);log(`   ✓ ${d}/`);}
  }
  fs.writeFileSync(path.join(OUTPUT_DIR,'images','placeholder.svg'),SVG_PH);

  log('\n🎨 Building custom.css...');
  const customCSS=buildCustomCSS(INPUT_DIR);
  ensureDir(path.join(OUTPUT_DIR,'css'));
  fs.writeFileSync(path.join(OUTPUT_DIR,'css','custom.css'),customCSS);
  log(`   ✓ css/custom.css (${Math.round(customCSS.length/1024)}KB)`);

  log('\n📄 Transforming HTML + injecting responsive TW classes...');
  // Mirror source structure 1:1.
  let totalInjected=0, pages=0;
  for(let relFile of findHTML(INPUT_DIR)){
    relFile = relFile.replace(/\\/g, '/');
    const inputPath=path.join(INPUT_DIR,relFile);
    let original=fs.readFileSync(inputPath,'utf8');
    original=fixDynamic(original);

    const outputRel=relFile;
    const outputPath=path.join(OUTPUT_DIR,outputRel);
    ensureDir(path.dirname(outputPath));

    const depth=outputRel.split('/').length-1;
    const prefix=depth>0?'../'.repeat(depth):'';

    const {html,injected}=transformHTML(original,prefix);
    fs.writeFileSync(outputPath,html,'utf8');
    totalInjected+=injected; pages++;
    const label=relFile;
    log(`   ✓ ${label.padEnd(50)} +${injected}`);
  }

  log('\n⚡ Building Tailwind v4 CSS...');
  const inputCSS=path.join(DIR,'input-v4.css');
  const outputCSS=path.join(OUTPUT_DIR,'css','tailwind.css');
  // TW v4 has no --content CLI flag — uses @source in CSS
  // Write a temp input CSS with @source pointing at output HTML
  const absOutputDir = path.resolve(OUTPUT_DIR);
  const twInputContent =
    fs.readFileSync(inputCSS, 'utf8')
    + `\n@source "${absOutputDir.replace(/\\/g,'/')}/**/*.html";\n`;
  const tw4BuildDir = path.join(DIR, 'tw4build');
  const tempInput = path.join(tw4BuildDir, '_input-temp.css');
  fs.writeFileSync(tempInput, twInputContent);
  try {
    const tw4Cli = path.join(tw4BuildDir, 'node_modules', '@tailwindcss', 'cli', 'dist', 'index.mjs');
    execSync(
      `node "${tw4Cli}" -i "${tempInput}" -o "${path.resolve(outputCSS)}" --minify`,
      {cwd:tw4BuildDir, stdio:'pipe'}
    );
  } finally {
    if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
  }
  const twKB=Math.round(fs.statSync(outputCSS).size/1024);
  const cuKB=Math.round(fs.statSync(path.join(OUTPUT_DIR,'css','custom.css')).size/1024);
  log(`   ✓ tailwind.css (${twKB}KB) + custom.css (${cuKB}KB)`);

  // ── AUTOMATED QA ────────────────────────────────────────────────────────────
  log('\n🔍 Automated QA...');
  const twCSS=fs.readFileSync(outputCSS,'utf8');
  const cuCSS=fs.readFileSync(path.join(OUTPUT_DIR,'css','custom.css'),'utf8');
  const safeRead=(p)=>fs.existsSync(p)?fs.readFileSync(p,'utf8'):'';
  const idxHTML=safeRead(path.join(OUTPUT_DIR,'index.html'));
  const ftHTML=safeRead(path.join(OUTPUT_DIR,'features.html'));
  const ctHTML=safeRead(path.join(OUTPUT_DIR,'contact-us.html'));
  const auHTML=safeRead(path.join(OUTPUT_DIR,'about-us.html'));

  const checks=[
    // Core cleanliness
    [':root defined',       cuCSS.includes(':root'),                                           'CSS vars :root defined'],
    ['var() preserved',     cuCSS.includes('var(--body-color)'),                              'var() calls preserved'],
    ['TW v4',               twCSS.includes('tailwindcss v4'),                                 'Tailwind v4 confirmed'],
    ['no w-* in HTML',      !/\bw-(?!full|auto|fit|min|max|screen|px|none|\d)[a-z][a-z0-9-]+\b/.test(idxHTML), 'No Webflow classes in HTML'],
    ['no data-w-id',        !idxHTML.includes('data-w-id'),                                  'No Webflow data attrs'],
    ['no IX2 styles',       !idxHTML.includes('opacity:0'),                                  'No IX2 inline styles'],
    // No w-* in CSS
    ['no .w- in custom.css',!cuCSS.match(/\n\.w-[a-z]/),                                     'No .w-* rules in custom.css'],
    // TW injection
    ['TW padding in HTML',  /\bpt-\d|\bpb-\d|\bpy-\d|\bp-\d/.test(idxHTML),                 'Base TW padding in HTML'],
    ['TW responsive in HTML',/max-lg:|max-md:|max-sm:|2xl:|xl:/.test(idxHTML),               'Responsive TW prefixes in HTML'],
    ['class names kept',    idxHTML.includes('section-y-axis-gap') && idxHTML.includes('navbar-menu-container'), 'Semantic class names kept'],
    ['responsive CSS intact',cuCSS.includes('@media'),                                        'CSS @media rules still present for complex cases'],
    // Bug fixes
    ['nav border CSS',      cuCSS.includes('scaleX(0)'),                                     'Nav border hover animation'],
    ['accordion CSS',       cuCSS.includes('faq-arrow-border.v2') && cuCSS.includes('rotate(90deg)'), 'Accordion icon CSS'],
    ['checkbox CSS',        cuCSS.includes('appearance: none'),                              'Checkbox custom styles'],
    ['form input width',    cuCSS.includes('width: 100%'),                                   'Form inputs width:100%'],
    ['feature grid',        ftHTML.includes('feature-right-column'),                         'Feature grid class preserved'],
    // Unused CSS removed
    ['no landing-page CSS', !cuCSS.includes('.landing-page-core-feature'),                   'Unused landing-page CSS removed'],
    ['no .w-checkbox CSS',  !cuCSS.match(/\.w-checkbox[^-]/),                               '.w-checkbox rules removed'],
    // HTML has responsive TW classes
    ['section-y-axis-gap TW resp', idxHTML.includes('section-y-axis-gap') && /section-y-axis-gap[^"]*max-lg:pt/.test(idxHTML), 'section-y-axis-gap has responsive TW'],
    ['main-container TW resp',     idxHTML.includes('main-container') && /main-container[^"]*xl:max-w/.test(idxHTML), 'main-container has responsive TW'],
  ];

  let passed=0;
  for(const[,result,desc] of checks){
    log(`   ${result?'✅':'❌'} ${desc}`);
    if(result) passed++;
  }

  log('\n'+'═'.repeat(65));
  log(`${passed===checks.length?'✅':'⚠️ '} FINAL BUILD — ${passed}/${checks.length} checks passed`);
  log('═'.repeat(65));
  log(`   Pages: ${pages} | TW injections: ${totalInjected}`);
  log(`   tailwind.css=${twKB}KB  custom.css=${cuKB}KB`);
  log('');

  require('child_process').execSync(
    `node "${path.join(DIR,'post-process.js')}" "${OUTPUT_DIR}"`,
    { stdio: 'inherit' }
  );
}

main();
