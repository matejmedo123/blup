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

const send = (res, file, code = 200) => {
  res.writeHead(code, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(readFileSync(file));
};

createServer((req, res) => {
  // `normalize` keeps a request for ../../etc/passwd inside the build folder.
  const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const direct = join(DIST, path);

  if (existsSync(direct) && statSync(direct).isFile()) return send(res, direct);
  if (existsSync(direct + '.html')) return send(res, direct + '.html');

  const index = join(direct, 'index.html');
  if (existsSync(index)) return send(res, index);

  for (const rule of rules) {
    if (rule.re.test(path)) return send(res, join(DIST, rule.to));
  }

  const notFound = join(DIST, '+not-found.html');
  return send(res, existsSync(notFound) ? notFound : join(DIST, 'index.html'), 404);
}).listen(PORT, () => {
  console.log(`${DIST} on http://localhost:${PORT}  (${rules.length} rewrite rules)`);
});
