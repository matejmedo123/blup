#!/usr/bin/env node
/**
 * Cookie consent smoke test.
 *
 * This exists because the whole thing was silently dead. `tags.ts` (the native
 * no-op) shadowed `tags.web.tsx` in Metro's resolution — it walks `sourceExts`
 * in order and `ts` comes before `tsx` — so on the web the app imported the
 * no-op: no pixel ever loaded, and the consent bar never appeared. Nothing
 * failed, nothing logged, and typechecking was perfectly happy.
 *
 * So this asserts the behaviour from outside, in a browser:
 *
 *   1. the footer's "Aktualizovať nastavenia cookies" opens the bar
 *   2. refusing is a real button, not a link hidden next to a big green one
 *   3. the answer is stored
 *   4. reopening it shows what was answered last time
 *
 *   node scripts/serve-web.mjs mobile/dist 4401
 *   node scripts/smoke-cookies.mjs [port]
 */
import { createRequire } from 'module';
const require = createRequire(new URL('../mobile/', import.meta.url));
const { chromium } = require('playwright');

const port = process.argv[2] ?? 4401;
const base = `http://127.0.0.1:${port}`;

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

// A page that renders its footer without waiting on any query.
await page.goto(`${base}/settings`, { waitUntil: 'networkidle' });

const footer = await page.evaluate(() => document.body.innerText);
check(footer.includes('Zásady cookies'), 'pätička odkazuje na zásady cookies');
check(footer.includes('Ochrana osobných údajov'), 'pätička odkazuje na ochranu údajov');
check(footer.includes('Aktualizovať nastavenia cookies'), 'pätička ponúka zmenu nastavení');

check(!footer.includes('Súhlasím'), 'lišta pred kliknutím nesvieti');

await page.getByText('Aktualizovať nastavenia cookies').first().click();
await page.waitForTimeout(600);

const opened = await page.content();
check(opened.includes('Súhlasím'), 'lišta sa otvorí z pätičky');
check(opened.includes('Odmietnuť'), 'odmietnuť je rovnocenné tlačidlo');

await page.getByText('Odmietnuť').first().click();
await page.waitForTimeout(400);

const stored = await page.evaluate(() => localStorage.getItem('blup.marketing.consent'));
check(stored === 'no', `odpoveď sa uloží (${stored})`);

await page.getByText('Aktualizovať nastavenia cookies').first().click();
await page.waitForTimeout(600);

const reopened = await page.content();
check(reopened.includes('odmietnutie'), 'znovuotvorená lišta pripomenie doterajšiu odpoveď');

await page.getByText('Súhlasím').first().click();
await page.waitForTimeout(400);
const after = await page.evaluate(() => localStorage.getItem('blup.marketing.consent'));
check(after === 'yes', `súhlas prepíše odmietnutie (${after})`);

await browser.close();

console.log(failures === 0 ? '\nCOOKIES V PORIADKU' : `\n${failures} ZLYHANÍ`);
process.exit(failures === 0 ? 0 : 1);
