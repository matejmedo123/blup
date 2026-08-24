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
 *   dist/.htaccess      the same for Apache / LiteSpeed — which is what most
 *                       Slovak shared hosting (Websupport included) runs
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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


// ---------------------------------------------------------------------------
// Link previews.
//
// This is a static export: every page carries the same og:image and the same
// description, because they are written once at build time and the event is
// only known after JavaScript runs. A crawler never runs it, so an event pasted
// into Instagram or WhatsApp showed the generic BLUP card.
//
// So crawlers — and only crawlers — are sent to an edge function that knows the
// event. A redirect rather than a proxy: shared Apache rarely has mod_proxy,
// and every preview crawler follows redirects. People are untouched, which is
// what keeps this from becoming cloaking: the card describes the same page the
// link opens.
// ---------------------------------------------------------------------------
/**
 * Read from mobile/.env rather than from the environment: npm does not pass a
 * .env to a sibling command and Expo only loads it for the bundler, so relying
 * on process.env meant the rules were silently skipped on every real build.
 */
function supabaseUrlFromEnvFile() {
  try {
    const line = readFileSync(join(dist, '..', '.env'), 'utf8')
      .split('\n')
      .find((l) => l.trim().startsWith('EXPO_PUBLIC_SUPABASE_URL='));
    return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') : '';
  } catch {
    return '';
  }
}

const SUPABASE_URL = (process.env.EXPO_PUBLIC_SUPABASE_URL || supabaseUrlFromEnvFile() || '')
  .replace(/\/+$/, '');
const OG = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/og` : null;

const CRAWLERS = [
  'facebookexternalhit', 'facebookcatalog', 'Facebot',
  'Twitterbot', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot',
  'WhatsApp', 'Instagram', 'Pinterest', 'redditbot', 'Applebot',
  'SkypeUriPreview', 'vkShare', 'Iframely', 'Embedly',
];
const CRAWLER_RE = CRAWLERS.join('|');

if (!OG) {
  console.warn(
    'EXPO_PUBLIC_SUPABASE_URL is unset, so link-preview rules were skipped.\n' +
    'Shared events will show the generic card until you rebuild with it set.');
}

const crawlerRewrites = OG ? [
  {
    source: '/event/:ref',
    has: [{ type: 'header', key: 'user-agent', value: `(?i).*(${CRAWLER_RE}).*` }],
    destination: `${OG}?kind=event&ref=:ref`,
  },
  {
    source: '/org/:ref',
    has: [{ type: 'header', key: 'user-agent', value: `(?i).*(${CRAWLER_RE}).*` }],
    destination: `${OG}?kind=org&ref=:ref`,
  },
] : [];

writeFileSync(join(dist, 'vercel.json'), JSON.stringify({
  cleanUrls: true,
  trailingSlash: false,
  // Crawler rules first: a rewrite list is evaluated in order, and the generic
  // /event/:id rule below would otherwise swallow them.
  rewrites: [...crawlerRewrites, ...routes.map((r) => ({ source: r.source, destination: r.file }))],
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

// Apache and LiteSpeed, which is what shared hosting in this part of the world
// tends to be. Ordered the same way: real file, then the rewrites, then 404.
writeFileSync(join(dist, '.htaccess'),
  `# Generated by scripts/make-host-config.mjs — do not edit by hand.\n` +
  `Options -MultiViews\n` +
  `RewriteEngine On\n\n` +
  (OG
    ? `# Link previews: crawlers only, redirected to a page that knows the event.\n` +
      `# [NC] so "WhatsApp" matches however the client cases it; [R=302,L] rather\n` +
      `# than [P], because shared Apache rarely has mod_proxy and every preview\n` +
      `# crawler follows a redirect.\n` +
      `RewriteCond %{HTTP_USER_AGENT} (${CRAWLER_RE}) [NC]\n` +
      `RewriteRule ^event/([^/]+)$ ${OG}?kind=event&ref=$1 [R=302,L]\n` +
      `RewriteCond %{HTTP_USER_AGENT} (${CRAWLER_RE}) [NC]\n` +
      `RewriteRule ^org/([^/]+)$ ${OG}?kind=org&ref=$1 [R=302,L]\n\n`
    : '') +
  `# Never rewrite something that exists on disk.\n` +
  `RewriteCond %{REQUEST_FILENAME} -f [OR]\n` +
  `RewriteCond %{REQUEST_FILENAME} -d\n` +
  `RewriteRule ^ - [L]\n\n` +
  `# /admin/fees -> /admin/fees.html\n` +
  `RewriteCond %{REQUEST_FILENAME}.html -f\n` +
  `RewriteRule ^(.*)$ $1.html [L]\n\n` +
  routes.map((r) => {
    const prefix = r.source.replace(/^\//, '').replace(/\/:[^/]+$/, '');
    return `# ${r.source}\nRewriteRule ^${prefix}/[^/]+$ ${r.file.replace(/^\//, '')} [L]`;
  }).join('\n\n') +
  `\n\n# Anything else is genuinely missing.\n` +
  `ErrorDocument 404 /+not-found.html\n\n` +
  `# The hashed bundles never change under the same name; the pages do.\n` +
  `<IfModule mod_expires.c>\n` +
  `  ExpiresActive On\n` +
  `  ExpiresByType text/html "access plus 0 seconds"\n` +
  `  ExpiresByType text/javascript "access plus 1 year"\n` +
  `  ExpiresByType text/css "access plus 1 year"\n` +
  `</IfModule>\n`);


/**
 * Expo's export puts an EMPTY react-helmet <title data-rh="true"></title> at the
 * very top of <head>, before the real one from app/+html.tsx. A browser honours
 * the FIRST <title> it meets, so every page came out titled with the bare
 * hostname ("blup.sk"), and link-preview crawlers — which never run our JS —
 * read that same empty string. Dropping the placeholder lets the real title win.
 */
function dropEmptyHelmetTitle(dir) {
  let touched = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!entry.endsWith('.html')) continue;
      const html = readFileSync(full, 'utf8');
      const stripped = html.replace(/<title data-rh="true">\s*<\/title>/g, '');
      if (stripped !== html) { writeFileSync(full, stripped); touched++; }
    }
  };
  walk(dir);
  return touched;
}

const retitled = dropEmptyHelmetTitle(dist);

console.log(`${routes.length} dynamic routes:`);
for (const r of routes) console.log(`  ${r.source.padEnd(34)} -> ${r.file}`);
console.log(`\nremoved the empty helmet <title> from ${retitled} pages`);
console.log(`wrote vercel.json, _redirects, nginx.conf and .htaccess into ${dist}`);
