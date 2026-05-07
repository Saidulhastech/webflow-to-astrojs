/**
 * serve.js — local static HTTP server for the output-* directories.
 *
 * Usage:
 *   node serve.js                                 # serves repo root on :8080
 *   node serve.js output-illuspro-vanilla         # serves that folder on :8080
 *   node serve.js output-illuspro-tailwind-v4 8123
 *
 * Why this exists:
 *   Opening the static export with file:// makes Chrome treat each file as a
 *   unique origin, which blocks jquery + webflow.js from loading.  Serving
 *   them over http://localhost fixes the CORS / "Unsafe attempt to load URL"
 *   errors and lets webflow.js initialise normally.
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || '.');
const PORT = parseInt(process.argv[3] || process.env.PORT || '8080', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.txt':  'text/plain; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  // Strip leading slash, then resolve and confine to ROOT.
  const safe = path.normalize(urlPath).replace(/^[\\/]+/, '');
  const file = path.join(ROOT, safe);
  if (!file.startsWith(ROOT)) return send(res, 403, 'Forbidden');

  fs.stat(file, (err, st) => {
    if (err) return send(res, 404, `Not found: ${urlPath}`, { 'Content-Type': 'text/plain' });
    if (st.isDirectory()) {
      // Try index.html inside the dir.
      const idx = path.join(file, 'index.html');
      fs.stat(idx, (e2) => {
        if (e2) return send(res, 404, `No index.html in ${urlPath}`, { 'Content-Type': 'text/plain' });
        stream(idx, res);
      });
      return;
    }
    stream(file, res);
  });
});

function stream(file, res) {
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

server.listen(PORT, () => {
  process.stdout.write(`\n  📂 ${ROOT}\n  🌐 http://localhost:${PORT}\n\n  Ctrl+C to stop.\n\n`);
});
