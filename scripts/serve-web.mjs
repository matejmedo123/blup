#!/usr/bin/env node
/**
 * Serves the web export the way a real static host will.
 *
 *   node scripts/serve-web.mjs [mobile/dist] [port]
 *
 * Two other ways to preview it both lie, in opposite directions:
 *
 *   `serve -s dist`  rewrites every request to index.html, so the client-side
 *                    router covers for anything missing and a dynamic route
 *                    appears to work whether or not the host is configured for
 *                    it. Everything passes; the first deploy then 404s.
 *
 *   `serve dist`     does no rewriting at all, so `/event/<id>` 404s even
 *                    though the deployed site will serve it — because the host
 *                    reads `_redirects`, and `serve` does not.
 *
 * This one reads the `_redirects` file that make-host-config.mjs generated and
 * applies it in the same order Netlify, Vercel and Cloudflare Pages do: a real
 * file wins, then the rewrites, then 404. What you see here is what you get.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';

const DIST = process.argv[2] ?? 'mobile/dist';
const PORT = Number(process.argv[3] ?? 4321);

if (!existsSync(join(DIST, 'index.html'))) {
  console.error(`No build in ${DIST}. Run: cd mobile && npm run build:web`);
  process.exit(1);
}

const redirectsFile = join(DIST, '_redirects');
const rules = existsSync(redirectsFile)
  ? readFileSync(redirectsFile, 'utf8').split('\n').filter(Boolean).map((line) => {
      const [from, to] = line.trim().split(/\s+/);
      return { re: new RegExp('^' + from.replace(/:[^/]+/g, '[^/]+') + '$'), to };
    })
  : [];

if (rules.length === 0) {
  console.warn('No _redirects found — dynamic routes will 404.');
  console.warn('Run: node scripts/make-host-config.mjs ' + DIST);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

/**
 * Returns false when the file is not there, rather than throwing.
 *
 * A rewrite rule can point at a page the current build does not contain — and,
 * more often, a rebuild deletes and rewrites `dist` underneath a server that is
 * still running, so a file that existed a millisecond ago does not now. That
 * used to throw out of the request handler and take the whole server down with
 * it, which turned a missing page into "the browser tests all failed".
 */
/**
 * Compression, because a preview that serves 4.7 MB of identity-encoded
 * JavaScript is not previewing the site anybody visits — the real host sends
 * ~910 kB of brotli, and the difference is the entire loading experience. Any
 * timing measured without this is measuring a site that does not exist.
 *
 * Compressed once per file and kept: these are static files, and re-compressing
 * a 4.7 MB bundle on every request made the server itself the slow part.
 */
const COMPRESSIBLE = /\.(html|js|css|json|webmanifest|svg|txt|map)$/;
const encoded = new Map();

function compress(file, body, accept) {
  if (!COMPRESSIBLE.test(file)) return null;

  const wants = accept.includes('br') ? 'br' : accept.includes('gzip') ? 'gzip' : null;
  if (!wants) return null;

  const key = `${wants}:${file}:${body.length}`;
  let cached = encoded.get(key);
  if (!cached) {
    cached = wants === 'br'
      // Quality 5 rather than the default 11: a static host precompresses
      // offline, but here the wait would be several seconds per build.
      ? brotliCompressSync(body, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 },
      })
      : gzipSync(body, { level: 6 });
    encoded.set(key, cached);
  }
  return { encoding: wants, body: cached };
}

const send = (res, file, code = 200, accept = '') => {
  let body;
  try {
    body = readFileSync(file);
  } catch {
    return false;
  }

  const headers = {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    Vary: 'Accept-Encoding',
  };

  const packed = compress(file, body, accept);
  if (packed) {
    headers['Content-Encoding'] = packed.encoding;
    body = packed.body;
  }

  res.writeHead(code, headers);
  res.end(body);
  return true;
};

createServer((req, res) => {
  // `normalize` keeps a request for ../../etc/passwd inside the build folder.
  const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const direct = join(DIST, path);
  const accept = req.headers['accept-encoding'] ?? '';

  if (existsSync(direct) && statSync(direct).isFile() && send(res, direct, 200, accept)) return;
  if (send(res, direct + '.html', 200, accept)) return;
  if (send(res, join(direct, 'index.html'), 200, accept)) return;

  for (const rule of rules) {
    if (rule.re.test(path) && send(res, join(DIST, rule.to), 200, accept)) return;
  }

  if (send(res, join(DIST, '+not-found.html'), 404, accept)) return;
  if (send(res, join(DIST, 'index.html'), 404, accept)) return;

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
}).listen(PORT, () => {
  console.log(`${DIST} on http://localhost:${PORT}  (${rules.length} rewrite rules)`);
});
