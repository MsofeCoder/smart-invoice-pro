/**
 * Zero-dependency static server
 *
 * Exists because `npx serve .` requires a network install and fails offline.
 * This uses only Node built-ins so `npm run serve` always works.
 *
 * Usage: node scripts/serve.js [port]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';

// The banner reads the product name from manifest.json rather than hardcoding
// it — white-label installs should not see a vendor name in their terminal.
const APP_NAME = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).name || 'Invoice App';
  } catch {
    return 'Invoice App';
  }
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';

  // Resolve inside ROOT and verify — blocks ../ traversal.
  const filePath = path.resolve(ROOT, '.' + urlPath);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      // The service worker must never be served stale from the HTTP cache,
      // or clients get stuck on an old version.
      'Cache-Control': path.basename(filePath) === 'sw.js' ? 'no-cache' : 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  ${APP_NAME}`);
  console.log(`  Serving ${ROOT}`);
  console.log(`  ->  http://${HOST}:${PORT}\n`);
  console.log('  Press Ctrl+C to stop.\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Try: node scripts/serve.js ${PORT + 1}\n`);
  } else {
    console.error('\n  Server error:', err.message, '\n');
  }
  process.exit(1);
});
