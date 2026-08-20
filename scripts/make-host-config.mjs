#!/usr/bin/env node
/**
 * Writes the hosting config the static export needs, derived from the export
 * itself rather than from a list somebody has to remember to update.
 *
 *   node scripts/make-host-config.mjs [mobile/dist]
 *
 * Why this exists: `expo export --platform web` pre-renders one HTML file per
 * route, and a dynamic route lands on disk with its brackets intact —
 * `event/[id].html`. A static host asked for `/event/9f2c…` therefore returns
 * 404, because no such file exists. Every route with a parameter needs a
 * rewrite to its bracket file, and only then does the app boot and read the id
 * from the URL.
 *
 * Local `npx serve -s dist` hides this: `-s` rewrites everything to index.html,
 * so the client-side router picks the URL up and it all appears to work. The
 * first real deploy is where it stops working, which is a bad time to find out.
 *
 * Produces:
 *   dist/vercel.json    rewrites + clean URLs
 *   dist/_redirects     the same thing for Netlify / Cloudflare Pages
 *   dist/nginx.conf     a `try_files` block for a plain server
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const dist = process.argv[2] ?? 'mobile/dist';

/** Every pre-rendered file whose path contains a [param] segment. */
function bracketRoutes(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...bracketRoutes(full, base));
    } else if (entry.endsWith('.html') && relative(base, full).includes('[')) {
      out.push(relative(base, full).split(sep).join('/'));
    }
  }
  return out;
}

const files = bracketRoutes(dist).sort();
if (files.length === 0) {
  console.error(`No dynamic routes found under ${dist} — is this an expo web export?`);
  process.exit(1);
}

// event/[id].html  ->  { source: '/event/:id', file: '/event/[id].html' }
const routes = files.map((file) => {
  const source = '/' + file
    .replace(/\.html$/, '')
    .replace(/\[([^\]]+)\]/g, ':$1');
  return { source, file: '/' + file };
});

writeFileSync(join(dist, 'vercel.json'), JSON.stringify({
  cleanUrls: true,
  trailingSlash: false,
  rewrites: routes.map((r) => ({ source: r.source, destination: r.file })),
}, null, 2) + '\n');

writeFileSync(join(dist, '_redirects'),
  routes.map((r) => `${r.source}  ${r.file}  200`).join('\n') + '\n');

writeFileSync(join(dist, 'nginx.conf'),
  `# Include inside your server { } block.\n` +
  `# Static files win; a parameterised route falls back to its bracket file.\n\n` +
  routes.map((r) => {
    const prefix = r.source.replace(/\/:[^/]+$/, '');
    return `location ~ ^${prefix}/[^/]+$ {\n  try_files $uri ${r.file} =404;\n}`;
  }).join('\n\n') + '\n\nlocation / {\n  try_files $uri $uri.html $uri/index.html /+not-found.html;\n}\n');

console.log(`${routes.length} dynamic routes:`);
for (const r of routes) console.log(`  ${r.source.padEnd(34)} -> ${r.file}`);
console.log(`\nwrote ${dist}/vercel.json, ${dist}/_redirects, ${dist}/nginx.conf`);
