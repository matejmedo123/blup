#!/usr/bin/env node
/**
 * Every link BLUP hands out must point at the origin BLUP is served from.
 *
 *   node scripts/check-origin.mjs            # source only
 *   node scripts/check-origin.mjs --dist     # also the built web output
 *
 * Why this exists
 * ---------------
 * The share sheet, the Open Graph card, the link inside a ticket e-mail and the
 * URL Stripe Checkout returns to are all built from one configured origin. When
 * that value is missing the code does not fail — it falls back to a literal,
 * and a wrong literal is invisible: the page loads, the button works, and the
 * link it produces belongs to somebody else's domain. The project shipped with
 * `https://blup.app` as that fallback while the site lives on blup.sk, so every
 * unset build produced dead share links and an Open Graph card pointing at a
 * domain we do not own.
 *
 * Bundle identifiers (com.blup.app, merchant.com.blup.app) are Apple/Google
 * application ids, not URLs. They are deliberately left alone.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const ORIGIN = process.env.BLUP_ORIGIN || 'https://blup.sk';
const HOST = ORIGIN.replace(/^https?:\/\//, '');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-demo', '.expo', 'android', 'ios', '.cache']);
const EXTS = /\.(ts|tsx|js|jsx|mjs|sql|md|json|sh|example|html)$/;

/**
 * A blup domain used as a URL or an e-mail address — never a bundle id.
 *
 * blup.test / blup.demo / blup.invalid are fixture domains in the seed data and
 * the smoke tests. `.test` and `.invalid` are reserved by RFC 2606 precisely so
 * that test data cannot reach a real host, so they are correct where they are.
 */
const ALLOWED = 'sk|test|demo|invalid|example|local';
const URL_SHAPED = new RegExp(`(?:https?://|//|@)blup\\.(?!(?:${ALLOWED})\\b)[a-z]{2,}`, 'gi');

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (EXTS.test(entry) || entry.startsWith('.env')) yield full;
  }
}

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|\/|$)/i;

/** The backend this build was compiled against: the environment, else mobile/.env. */
function supabaseUrl() {
  if (process.env.EXPO_PUBLIC_SUPABASE_URL) return process.env.EXPO_PUBLIC_SUPABASE_URL.trim();
  const envFile = join(ROOT, 'mobile', '.env');
  if (!existsSync(envFile)) return null;
  const line = readFileSync(envFile, 'utf8')
    .split('\n')
    .find((l) => l.trim().startsWith('EXPO_PUBLIC_SUPABASE_URL='));
  return line ? line.split('=').slice(1).join('=').trim() || null : null;
}

const problems = [];

for (const file of walk(ROOT)) {
  if (file.endsWith('check-origin.mjs')) continue;
  const text = readFileSync(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    for (const hit of line.matchAll(URL_SHAPED)) {
      problems.push(`${relative(ROOT, file)}:${i + 1}  ${hit[0]}  → má byť ${HOST}`);
    }
  });
}

if (process.argv.includes('--dist')) {
  const dist = join(ROOT, 'mobile', 'dist');
  if (!existsSync(dist)) {
    console.error('✖ mobile/dist neexistuje — najprv: cd mobile && npm run build:web');
    process.exit(1);
  }
  const html = readFileSync(join(dist, 'index.html'), 'utf8');

  // The served config: blup-config.js is loaded before the bundle and overrides
  // what was baked in, so a build compiled against the local backend is still
  // shippable when this file points it somewhere real. It is only worth
  // anything if the page actually loads it, so that is checked first — an
  // ignored config file is the same silent failure wearing a different hat.
  const configFile = join(dist, 'blup-config.js');
  let served = null;
  if (existsSync(configFile)) {
    if (!html.includes('blup-config.js')) {
      problems.push('mobile/dist/index.html  nenačítava blup-config.js — súbor tam je a nič nerobí');
    }
    const text = readFileSync(configFile, 'utf8');
    served = text.match(/supabaseUrl:\s*'([^']*)'/)?.[1]?.trim() || null;
    const key = text.match(/supabaseAnonKey:\s*'([^']*)'/)?.[1]?.trim() || '';
    if (served && !key) {
      problems.push('mobile/dist/blup-config.js  supabaseUrl je vyplnená, supabaseAnonKey nie');
    }
    // A secret in here would be handed to every visitor. Only the values are
    // examined — the file's own comments say the words "service_role" and
    // "sk_" precisely to warn against them, and a check that trips over its
    // own warning is a check that gets deleted.
    for (const value of text.matchAll(/:\s*'([^']*)'/g)) {
      const v = value[1];
      if (/^sk_(live|test)_/.test(v) || /^rk_(live|test)_/.test(v)) {
        problems.push('mobile/dist/blup-config.js  obsahuje Stripe secret key — ten patrí len do Edge Functions');
      }
      // A Supabase key is a JWT; the role is inside it. An anon key and a
      // service_role key look identical until you read the payload, and pasting
      // the wrong one here hands every visitor full access to the database.
      const parts = v.split('.');
      if (parts.length === 3) {
        try {
          const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
          if (/"role"\s*:\s*"service_role"/.test(payload)) {
            problems.push('mobile/dist/blup-config.js  je tam service_role key — ten odomyká celú databázu, patrí len do Edge Functions');
          }
        } catch { /* not a JWT after all */ }
      }
    }
  }

  const og = html.match(/property="og:url"\s+content="([^"]*)"/)?.[1];
  if (!og) problems.push('mobile/dist/index.html  chýba og:url');
  else if (!og.startsWith(ORIGIN)) problems.push(`mobile/dist/index.html  og:url = ${og}  → má byť ${ORIGIN}`);

  // The origin has to survive the bundler, not just the config file. This is
  // the half that catches "I set it in .env and nothing changed".
  const webJs = join(dist, '_expo', 'static', 'js', 'web');
  const bundle = existsSync(webJs) ? readdirSync(webJs).find((f) => f.startsWith('entry-')) : null;
  if (!bundle) problems.push('mobile/dist  nenašiel som entry bundle');
  else {
    const code = readFileSync(join(webJs, bundle), 'utf8');
    if (!code.includes(HOST)) problems.push(`${bundle}  neobsahuje ${HOST} — origin sa nedostal do bundlu`);
    for (const hit of code.matchAll(URL_SHAPED)) problems.push(`${bundle}  ${hit[0]}`);

    // A build is only shippable if it talks to a real backend.
    //
    // The truth about a build is inside the bundle, not in anybody's .env, so
    // that is where the value is read from. A developer's .env points at the
    // local Supabase on 127.0.0.1:54321 — which in a visitor's browser means
    // *their own machine*. The page then loads perfectly and does nothing: no
    // events, no sign-in, no tickets, and no error that says why. Exactly the
    // failure shape this file exists for, and one that shipped twice.
    //
    // Only the CONFIGURED value is checked, never the bundle at large: the
    // Supabase auth library carries `http://localhost:9999` as an internal
    // default, so scanning for any loopback URL fires on every build, including
    // correct ones — and a check that always fails is a check nobody reads.
    // The config is serialised into the bundle as a JS string literal, so the
    // quotes around it arrive backslash-escaped. Matching only bare quotes finds
    // nothing and reads as "no backend configured" on every build.
    const baked = code.match(/\\?"supabaseUrl\\?"\s*:\s*\\?"([^"\\]*)/)?.[1]?.trim() || null;
    const configured = supabaseUrl();

    // "I set it in .env and nothing changed."
    if (configured && baked && !LOOPBACK.test(configured)
        && !code.includes(configured.replace(/^https?:\/\//, ''))) {
      problems.push(`${bundle}  neobsahuje ${configured} — Supabase URL sa nedostala do bundlu`);
    }

    // Nothing configured, yet the bundle carries a backend: the value came from
    // somewhere the build no longer reads. In practice that is Metro's cache in
    // the system temp directory, which `rm -rf .expo node_modules/.cache` does
    // not touch — a build that quietly ships the PREVIOUS build's configuration.
    // `expo export --clear` is what actually clears it.
    if (!configured && baked) {
      problems.push(`${bundle}  v bundli je ${baked}, hoci nastavené nie je nič — to je stará cache.`);
      problems.push('    Metro si drží cache v /tmp; zmaž ju buildom s --clear (build:web ho už používa).');
    }

    // What the browser will actually use: the served config wins, because it is
    // loaded before the bundle.
    const effective = served || baked;

    if (!effective) {
      // A build meant to be configured after upload. Legitimate, but it has to
      // be on purpose — otherwise it is indistinguishable from a broken one.
      if (!process.env.BLUP_CONFIG_AT_DEPLOY) {
        problems.push(`${bundle}  žiadna Supabase URL — build by nemal ku komu hovoriť.`);
        problems.push('    Buď nastav EXPO_PUBLIC_SUPABASE_URL v mobile/.env a builduj znova,');
        problems.push('    alebo vyplň supabaseUrl v mobile/dist/blup-config.js.');
        problems.push('    (Balík na dopísanie po nahratí naschvál: BLUP_CONFIG_AT_DEPLOY=1.)');
      } else if (!existsSync(configFile)) {
        problems.push('mobile/dist  BLUP_CONFIG_AT_DEPLOY, ale blup-config.js tam nie je — nebude sa kam dopísať');
      } else {
        console.log('• Backend sa dopĺňa až po nahratí (mobile/dist/blup-config.js).');
      }
    } else if (!process.env.BLUP_ALLOW_LOCAL_BACKEND && LOOPBACK.test(effective)) {
      problems.push(`${bundle}  Supabase URL je ${effective} — to je počítač návštevníka, nie server.`);
      problems.push('    Nastav EXPO_PUBLIC_SUPABASE_URL v mobile/.env na svoj projekt a builduj znova,');
      problems.push('    alebo vyplň supabaseUrl a supabaseAnonKey v mobile/dist/blup-config.js.');
      problems.push('    (Lokálny build naschvál: BLUP_ALLOW_LOCAL_BACKEND=1.)');
    }
  }
}

if (problems.length) {
  console.error(`✖ Zlý origin na ${problems.length} miestach (očakávam ${ORIGIN}):\n`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}

console.log(`✓ Každý odkaz ukazuje na ${ORIGIN}.`);
