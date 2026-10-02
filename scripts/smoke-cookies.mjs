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
 *   1. a first visit is asked, before anything is configured or loaded
 *   2. nothing is switched on in advance, and necessary cookies have no switch
 *   3. the Meta pixel does not appear until marketing consent is given — not
 *      on the first visit, not after a refusal, not after a partial yes
 *   4. refusing is a real button, the same size and next to accepting
 *   5. an answered visitor is not asked again
 *   6. the footer's "Aktualizovať nastavenia cookies" reopens it
 *   7. one category can be switched on without the others
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

// --- the first visit, in a browser that has never been here ------------------
await page.goto(`${base}/settings`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const read = () => page.evaluate(() => {
  const leaves = [...document.querySelectorAll('*')].filter((el) => !el.children.length);
  const text = (el) => (el.textContent || '').trim();
  return {
    open: leaves.some((el) => text(el) === 'Nastavenie cookies'),
    tabs: leaves.map(text).filter((t) => ['Súhlas', 'Detailný prehľad', 'O cookies'].includes(t)),
    buttons: leaves.map(text).filter((t) => /^(Uložiť moje nastavenie|Zamietnuť všetky|Prijať všetky)$/.test(t)),
    switches: [...document.querySelectorAll('[role="switch"]')].map((el) => ({
      label: el.getAttribute('aria-label'),
      on: el.getAttribute('aria-checked') === 'true',
    })),
    always: leaves.filter((el) => text(el) === 'Vždy aktívne').length,
  };
});

const stored = () => page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('blup.cookies') || 'null'); } catch { return null; }
});

const first = await read();
check(first.open, 'prvá návšteva sa spýta sama od seba');
check(first.tabs.length === 3, `tri karty (${first.tabs.join(', ') || 'žiadna'})`);
check(first.switches.length === 3, `tri voliteľné kategórie (${first.switches.length})`);
check(first.always === 1, 'nevyhnutné cookies sa nedajú vypnúť');
check(first.switches.every((s) => !s.on), 'nič nie je zapnuté dopredu');
check(
  first.buttons.includes('Zamietnuť všetky') && first.buttons.includes('Prijať všetky'),
  'zamietnuť je rovnocenné tlačidlo vedľa prijať',
);

// --- nič sa nenačíta, kým sa človek nevyjadrí --------------------------------
//
// Google tag áno — v Consent Mode v2 beží so všetkým zamietnutým a nenastaví
// cookie. Meta taký režim nemá, takže sa pred súhlasom nesmie objaviť vôbec.
const scripts = () => page.evaluate(() => [...document.querySelectorAll('script')]
  .map((el) => el.src).filter(Boolean));
check(
  !(await scripts()).some((src) => /facebook/.test(src)),
  'Meta pixel sa pred súhlasom nenačíta',
);

// --- zamietnutie -------------------------------------------------------------
await page.getByText('Zamietnuť všetky').first().click();
await page.waitForTimeout(500);
const declined = await stored();
check(
  declined && !declined.analytics && !declined.marketing && !declined.personalization,
  `zamietnutie sa uloží (${JSON.stringify(declined)})`,
);
check(!(await read()).open, 'po odpovedi sa okno zavrie');

// --- a druhá návšteva sa už nepýta -------------------------------------------
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
check(!(await read()).open, 'druhá návšteva sa už nepýta');
check(
  !(await scripts()).some((src) => /facebook/.test(src)),
  'po zamietnutí sa Meta pixel nenačíta ani po obnovení',
);

const footer = await page.evaluate(() => document.body.innerText);
check(footer.includes('Zásady cookies'), 'pätička odkazuje na zásady cookies');
check(footer.includes('Ochrana osobných údajov'), 'pätička odkazuje na ochranu údajov');
check(footer.includes('Aktualizovať nastavenia cookies'), 'pätička ponúka zmenu nastavení');

// --- a dá sa to zmeniť --------------------------------------------------------
await page.getByText('Aktualizovať nastavenia cookies').first().click();
await page.waitForTimeout(800);
check((await read()).open, 'okno sa otvorí z pätičky');

// Jedna kategória, nie všetko. Toto je celý rozdiel oproti áno/nie.
await page.evaluate(() => {
  const sw = [...document.querySelectorAll('[role="switch"]')]
    .find((el) => (el.getAttribute('aria-label') || '').startsWith('Analytické'));
  sw?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForTimeout(300);
const toggled = (await read()).switches;
check(
  toggled.find((s) => (s.label || '').startsWith('Analytické'))?.on === true
  && toggled.find((s) => (s.label || '').startsWith('Marketingové'))?.on === false,
  'prepínač zapne práve svoju kategóriu',
);

await page.getByText('Uložiť moje nastavenie').first().click();
await page.waitForTimeout(800);
const partial = await stored();
check(
  partial && partial.analytics === true && partial.marketing === false,
  `uloží sa aj čiastočný súhlas (${JSON.stringify(partial)})`,
);
check(
  !(await scripts()).some((src) => /facebook/.test(src)),
  'bez marketingového súhlasu sa Meta pixel stále nenačíta',
);

// --- a súhlas so všetkým pixel pustí ------------------------------------------
await page.getByText('Aktualizovať nastavenia cookies').first().click();
await page.waitForTimeout(800);
await page.getByText('Prijať všetky').first().click();
await page.waitForTimeout(1500);
const all = await stored();
check(all && all.analytics && all.marketing && all.personalization, 'prijať všetky uloží všetky');

await browser.close();

console.log(failures === 0 ? '\nCOOKIES V PORIADKU' : `\n${failures} ZLYHANÍ`);
process.exit(failures === 0 ? 0 : 1);
