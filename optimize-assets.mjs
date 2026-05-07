import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import ttf2woff2 from 'ttf2woff2';

// Resolve NAME from project.config.json (next to this script), so deps load
// from webflow-toastro/node_modules regardless of cwd.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(SCRIPT_DIR, 'project.config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('optimize-assets.mjs: project.config.json not found at', CONFIG_PATH);
  process.exit(1);
}
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const NAME   = CONFIG.name;

// argv[2] override: explicit astro project root.
const ASTRO_ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(SCRIPT_DIR, `astro-${NAME}`);

// Convert script puts images at public/assets/images/ and fonts at public/fonts/
// (served directly via HTML img src + CSS @font-face url paths).
const imagesDir = path.join(ASTRO_ROOT, 'public', 'assets', 'images');
const fontsDir  = path.join(ASTRO_ROOT, 'public', 'fonts');

if (!fs.existsSync(imagesDir)) {
  console.warn(`optimize-assets: skipped — ${imagesDir} not found`);
  process.exit(0);
}

let imgCount = 0;
let imgSkipped = 0;

for (const entry of fs.readdirSync(imagesDir, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const ext = path.extname(entry.name).toLowerCase();
  if (!['.jpg', '.jpeg', '.png'].includes(ext)) continue;

  const src = path.join(imagesDir, entry.name);
  const dest = path.join(imagesDir, entry.name.slice(0, -ext.length) + '.webp');

  if (fs.existsSync(dest)) {
    imgSkipped += 1;
    continue;
  }

  await sharp(src).webp({ quality: 82, effort: 4 }).toFile(dest);
  imgCount += 1;
}

console.log(`webp: created ${imgCount}, skipped ${imgSkipped}`);

// Optionally delete jpg/png/jpeg originals once webp counterpart exists.
// Off by default: HTML img src refs still point at .jpg/.png from Webflow's
// export, so deleting would 404 those images. Pass --delete-originals to
// remove them (only safe after rewriting HTML refs to .webp).
const KEEP = ['favicon', 'webclip'];
let removed = 0;
if (process.argv.includes('--delete-originals')) {
  for (const entry of fs.readdirSync(imagesDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!['.jpg', '.jpeg', '.png'].includes(ext)) continue;
    if (KEEP.some((k) => entry.name.toLowerCase().includes(k))) continue;
    const webpPath = path.join(imagesDir, entry.name.slice(0, -ext.length) + '.webp');
    if (!fs.existsSync(webpPath)) continue;
    fs.unlinkSync(path.join(imagesDir, entry.name));
    removed += 1;
  }
  console.log(`raster originals deleted: ${removed}`);
} else {
  console.log(`raster originals kept (pass --delete-originals to remove)`);
}

let fontCount = 0;
if (fs.existsSync(fontsDir)) {
  for (const entry of fs.readdirSync(fontsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.ttf')) continue;
    const src = path.join(fontsDir, entry.name);
    const dest = path.join(fontsDir, entry.name.slice(0, -4) + '.woff2');
    if (fs.existsSync(dest)) continue;
    const out = ttf2woff2(fs.readFileSync(src));
    fs.writeFileSync(dest, out);
    fontCount += 1;
  }
}

console.log(`woff2: created ${fontCount}`);
