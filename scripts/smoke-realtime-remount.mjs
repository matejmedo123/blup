#!/usr/bin/env node
/**
 * The blank page, reproduced.
 *
 * Every screen with live updates opens a Realtime channel in an effect and
 * removes it on cleanup. `removeChannel()` is asynchronous — it waits for the
 * server to acknowledge the unsubscribe — while `supabase.channel(topic)`
 * returns an *existing* channel with that topic if one is still registered.
 * So a fast remount gets handed the old, already-subscribed channel, and
 * `.on('postgres_changes', …)` on it throws:
 *
 *   cannot add `postgres_changes` callbacks for realtime:home-events
 *   after `subscribe()`
 *
 * The throw happens while rendering, which unmounts the tree — the blank page
 * that a reload "fixed" and that came back after a few clicks.
 *
 * This walks away from a live screen and back, several times, and fails if the
 * app ends up on the error screen or with nothing on it.
 *
 * It has to navigate by clicking the app's own tabs, not with `page.goto`: a
 * full page load builds a new Supabase client with no channels in it, which is
 * exactly why a reload always appeared to fix the problem.
 *
 * Be clear about what each half proves. The browser walk is a guard against a
 * blank page coming back; it is a race, and it does not reproduce without a
 * real Realtime connection, so passing it is not proof the race is gone. The
 * source check above it *is* deterministic: it fails if any screen goes back to
 * calling `supabase.channel()` with a fixed topic, which is the thing that
 * makes the race possible in the first place.
 *
 *   node scripts/serve-web.mjs mobile/dist 4401
 *   node scripts/smoke-realtime-remount.mjs [port]
 */
import { createRequire } from 'module';
const require = createRequire(new URL('../mobile/', import.meta.url));
const { chromium } = require('playwright');

const port = process.argv[2] ?? 4401;
const base = `http://127.0.0.1:${port}`;

// --- the deterministic half -------------------------------------------------
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const roots = ['mobile/app', 'mobile/src'];
const allowed = 'mobile/src/lib/realtime.ts';
const offenders = [];

function walkDir(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { walkDir(full); continue; }
    if (!/\.tsx?$/.test(full)) continue;
    if (full.replace(/\\/g, '/').endsWith(allowed)) continue;

    const source = readFileSync(full, 'utf8');
    // Comments mention it; code calling it is the problem.
    for (const line of source.split('\n')) {
      if (/^\s*[*/]/.test(line)) continue;
      if (/\.channel\(/.test(line)) offenders.push(`${full}: ${line.trim().slice(0, 90)}`);
    }
  }
}

for (const root of roots) walkDir(root);

console.log(
  `${offenders.length === 0 ? '✓' : '✗'} nikto neotvára kanál priamo (${offenders.length} nálezov)`,
);
for (const offender of offenders) console.log('   ' + offender);

// --- the browser half -------------------------------------------------------
// Tabs that open a Realtime channel (Domov, Chat) and neutral ones to bounce
// off. Domov subscribes to `home-events`, Chat to `inbox-messages`.
const WALK = ['Domov', 'Objav', 'Domov', 'Chat', 'Objav', 'Chat', 'Domov', 'Feed', 'Domov'];

let failures = offenders.length;
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

/** Clicks one of the app's own nav items — a client-side route change. */
async function tap(label) {
  const hit = await page.evaluate((text) => {
    const all = [...document.querySelectorAll('*')];
    const leaf = all.find((el) => el.children.length === 0 && (el.textContent ?? '').trim() === text)
      ?? all.filter((el) => (el.textContent ?? '').trim() === text)
             .sort((a, b) => a.getElementsByTagName('*').length - b.getElementsByTagName('*').length)[0];
    if (!leaf) return false;
    const target = leaf.closest('[role="button"], a, [tabindex]') ?? leaf.parentElement;
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }, label);
  // Short on purpose: remounting before the previous channel has finished
  // going away is the whole point.
  await page.waitForTimeout(260);
  return hit;
}

await page.goto(`${base}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// Three laps of the same walk: the second visit to a tab is where the stale
// channel gets handed back.
let missed = 0;
for (let lap = 0; lap < 3; lap += 1) {
  for (const label of WALK) {
    if (!(await tap(label))) missed += 1;

    const text = await page.evaluate(() => document.body.innerText);
    if (text.includes('nepodarilo zobraziť')) {
      console.log(`✗ chybová obrazovka po kliknutí na „${label}" (kolo ${lap + 1})`);
      failures += 1;
      break;
    }
  }
  if (failures) break;
}

console.log(`${failures === 0 ? '✓' : '✗'} ${WALK.length * 3} klikov, ${missed} nenájdených`);

const realtimeErrors = errors.filter((e) => /postgres_changes|subscribe\(\)/.test(e));
console.log(`${realtimeErrors.length === 0 ? '✓' : '✗'} realtime chýb: ${realtimeErrors.length}`);
if (realtimeErrors.length) {
  console.log('   ' + realtimeErrors[0].slice(0, 200));
  failures += 1;
}

await browser.close();
console.log(failures === 0 ? '\nŽIADNA PRÁZDNA STRÁNKA' : `\n${failures} ZLYHANÍ`);
process.exit(failures === 0 ? 0 : 1);
