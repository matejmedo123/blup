#!/usr/bin/env node
/**
 * Clicking around until something breaks.
 *
 * The blank-screen report had a shape worth reproducing: it appeared after
 * several navigations, went away on a hard refresh, and came back after several
 * more — which is not what a plain redirect loop looks like.
 *
 * Two things this gets right that the obvious version does not. It navigates by
 * clicking the app's own controls: history.pushState changes the address bar
 * and nothing else, so a test built on it watches the same screen the whole
 * time and can never fail. And it measures the content area rather than the
 * document: on a desktop the sidebar alone is sixty-odd characters of nav
 * labels, so "the page has text" is true even when the page is empty.
 *
 *   node scripts/serve-web.mjs mobile/dist 4500
 *   node scripts/smoke-navigation-stress.mjs [base-url] [rounds]
 */
import { createRequire } from 'module';
const require = createRequire(new URL('../mobile/', import.meta.url));
const { chromium } = require('playwright');

const BASE = process.argv[2] ?? 'http://127.0.0.1:4500';
const ROUNDS = Number(process.argv[3] ?? 3);

/** Labels that exist in the persistent navigation on both layouts. */
/**
 * Home between every other tab, because home is where the blank appeared —
 * it was the one route two files both claimed.
 *
 * Worth knowing what this does and does not prove. The original failure was
 * reproduced once against the pre-fix build (an empty document, sidebar and
 * all) and did not reproduce on a second run of the same build: it is a race,
 * not a deterministic loop, so no test can be relied on to trigger it. The fix
 * removes the route conflict entirely rather than making the race less likely,
 * and this walk is a guard against a deterministic blank returning — not proof
 * that the race is gone.
 */
const NAV = ['Domov', 'Objav', 'Domov', 'Feed', 'Domov', 'Chat', 'Domov'];

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

let failures = 0;

/** Clicks the app's own nav item and waits for it to settle. */
async function tap(page, label) {
  const hit = await page.evaluate((text) => {
    // Leaf first; a tab bar wraps its label in a couple of views, so fall back
    // to the smallest element whose whole text is the label.
    const all = [...document.querySelectorAll('*')];
    const leaf = all.find((el) => el.children.length === 0 && (el.textContent ?? '').trim() === text)
      ?? all.filter((el) => (el.textContent ?? '').trim() === text)
             .sort((a, b) => a.getElementsByTagName('*').length - b.getElementsByTagName('*').length)[0];
    if (!leaf) return false;
    const target = leaf.closest('[role="button"], a, [tabindex]') ?? leaf.parentElement;
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }, label);
  // 320ms was not enough: the failure being watched for takes a beat to
  // appear, so a short wait sampled the previous screen and passed.
  await page.waitForTimeout(700);
  return hit;
}

for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }],
                                 ['telefon', { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));

  // A desktop keeps its sidebar on every screen, so it can start on the deep
  // link that broke — open an event, click home. A phone cannot: an event
  // screen is a Stack route with no tab bar, so there is nothing to click and
  // the walk has to start where the tabs exist.
  await page.goto(BASE + (viewport.width >= 900
    ? '/event/photos/c3d9abad-e5d9-42de-9a34-13c810a04a3d'
    : '/'), { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);

  // The persistent shell, measured once: everything below is content on top of it.
  const shell = await page.evaluate(() => {
    const nav = ['Domov', 'Objav', 'Feed', 'Chat', 'Ja'];
    return nav.join('').length;
  });

  let step = 0;
  let missed = 0;

  for (let round = 0; round < ROUNDS; round++) {
    for (const target of NAV) {
      step++;
      if (!(await tap(page, target))) { missed++; continue; }

      const state = await page.evaluate(() => {
        const root = document.getElementById('root') ?? document.body;
        return { len: (root.innerText ?? '').trim().length, url: location.pathname };
      });

      // Content beyond the nav labels themselves. A screen that rendered
      // nothing still shows the shell, so the shell has to come off the total.
      const content = state.len - shell;
      if (content < 40) {
        console.log(`✗ ${label} krok ${step}: ${state.url} — obsah ${content} znakov`);
        failures++;
      }
    }
  }

  const ok = errors.length === 0 && missed === 0;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${step} klikov, ${missed} nenájdených, ` +
              `${errors.length} JS chýb${errors[0] ? ' — ' + errors[0] : ''}`);
  if (!ok) failures++;
  await ctx.close();
}

await browser.close();
console.log(failures === 0 ? '\nŽIADNA PRÁZDNA STRÁNKA' : `\n${failures} PROBLÉMOV`);
process.exit(failures === 0 ? 0 : 1);
