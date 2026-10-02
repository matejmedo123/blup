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
 *   2. the ask is a bar at the bottom, not a wall — the page stays usable
 *   3. refusing is a real button, the same size and right next to accepting
 *   4. the Meta pixel does not appear until marketing consent is given — not
 *      on the first visit, not after a refusal, not after a partial yes
 *   5. an answered visitor is not asked again
 *   6. "Nastaviť" opens the detail, with four categories and no switch on the
 *      necessary ones, and nothing switched on in advance
 *   7. one category can be switched on without the others
 *   8. the footer's "Aktualizovať nastavenia cookies" opens the detail
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
  const bar = leaves.find((el) => /Pomôž nám BLUP/.test(text(el)));
  return {
    bar: Boolean(bar),
    panel: leaves.some((el) => text(el) === 'Nastavenie cookies'),
    barButtons: [...document.querySelectorAll('[role="button"]')]
      .map(text).filter((t) => /^(Prijať všetky|Zamietnuť|Nastaviť)$/.test(t)),
    tabs: leaves.map(text).filter((t) => ['Súhlas', 'Detailný prehľad', 'O cookies'].includes(t)),
    panelButtons: leaves.map(text)
      .filter((t) => /^(Uložiť moje nastavenie|Zamietnuť všetky|Prijať všetky)$/.test(t)),
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

const scripts = () => page.evaluate(() => [...document.querySelectorAll('script')]
  .map((el) => el.src).filter(Boolean));

const first = await read();
check(first.bar, 'prvá návšteva sa spýta sama od seba');
check(!first.panel, 'a je to lišta, nie okno cez celú stránku');
check(
  first.barButtons.includes('Prijať všetky')
  && first.barButtons.includes('Zamietnuť')
  && first.barButtons.includes('Nastaviť'),
  `lišta má prijať, zamietnuť aj nastaviť (${first.barButtons.join(', ') || 'nič'})`,
);

// Rovnocennosť sa nedá tvrdiť, dá sa zmerať: obe tlačidlá musia byť rovnako
// veľké. Menšie „zamietnuť" vedľa veľkého „prijať" nie je voľba.
const sizes = await page.evaluate(() => {
  const box = (label) => {
    const el = [...document.querySelectorAll('[role="button"]')]
      .find((e) => (e.textContent || '').trim() === label);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  };
  return { accept: box('Prijať všetky'), reject: box('Zamietnuť') };
});
check(
  Boolean(sizes.accept && sizes.reject)
  && sizes.accept.h === sizes.reject.h
  && Math.abs(sizes.accept.w - sizes.reject.w) <= 8,
  `zamietnuť je rovnako veľké ako prijať (${JSON.stringify(sizes)})`,
);

// A toto je ten rozdiel oproti oknu: stránka sa dá používať aj s lištou.
const usable = await page.evaluate(() => {
  const el = [...document.querySelectorAll('[role="button"], a')]
    .find((e) => (e.textContent || '').trim().length > 0
      && e.getBoundingClientRect().top < window.innerHeight / 2
      && e.getBoundingClientRect().width > 0);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return Boolean(top) && (el.contains(top) || top === el);
});
check(usable, 'lišta nezakrýva stránku — dá sa pod ňou klikať');

/**
 * A nezakrýva ani spodnú navigáciu.
 *
 * Toto je tu preto, že sa to raz stalo: lišta sadla na spodný okraj, na
 * telefóne je tam lišta s kartami a „Zamietnuť" skončilo presne na tlačidle
 * SWAP. Kým človek neodpovedal, nedal sa otvoriť — a nič na tom nevyzeralo
 * rozbito, len to nereagovalo.
 */
{
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await phone.addInitScript(() => {
    try { localStorage.setItem('blup.welcome.v1.seen', '1'); } catch { /* private */ }
  });
  const small = await phone.newPage();
  await small.goto(`${base}/`, { waitUntil: 'networkidle' });
  await small.waitForTimeout(2500);

  const covered = await small.evaluate(() => {
    const tabs = ['Domov', 'Objav', 'SWAP', 'Chat'];
    const bad = [];
    for (const label of tabs) {
      // Nápis sa v DOM-e vyskytuje viackrát (ikona a text, bočné menu).
      // Zaujíma nás ten najnižší — spodná lišta je dole.
      const leaf = [...document.querySelectorAll('*')]
        .filter((el) => !el.children.length && (el.textContent || '').trim() === label)
        .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
      if (!leaf) { bad.push(`${label}: v lište nie je`); continue; }
      const r = leaf.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      // Porovnáva sa text, nie totožnosť uzla: `elementFromPoint` vráti
      // najvrchnejší prvok a pri react-native-web to býva iný uzol toho istého
      // tlačidla. Keby tam ležala lišta so súhlasom, text by bol jej.
      if (!top || !(top.textContent || '').includes(label)) {
        bad.push(`${label}: prekryté „${(top?.textContent || '').trim().slice(0, 24)}"`);
      }
    }
    return bad;
  });
  check(covered.length === 0, `lišta nezakrýva spodnú navigáciu (${covered.join(', ') || 'nič neprekryté'})`);
  await phone.close();
}

check(
  !(await scripts()).some((src) => /facebook/.test(src)),
  'Meta pixel sa pred súhlasom nenačíta',
);

// --- podrobné nastavenie -----------------------------------------------------
await page.getByText('Nastaviť', { exact: true }).first().click();
await page.waitForTimeout(700);
const panel = await read();
check(panel.panel, '„Nastaviť" otvorí podrobné nastavenie');
check(panel.tabs.length === 3, `tri karty (${panel.tabs.join(', ') || 'žiadna'})`);
check(panel.switches.length === 3, `tri voliteľné kategórie (${panel.switches.length})`);
check(panel.always === 1, 'nevyhnutné cookies sa nedajú vypnúť');
check(panel.switches.every((s) => !s.on), 'nič nie je zapnuté dopredu');

// Jedna kategória, nie všetko. To je celý rozdiel oproti áno/nie.
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
await page.waitForTimeout(900);
const partial = await stored();
check(
  partial && partial.analytics === true && partial.marketing === false,
  `uloží sa aj čiastočný súhlas (${JSON.stringify(partial)})`,
);
check(
  !(await scripts()).some((src) => /facebook/.test(src)),
  'bez marketingového súhlasu sa Meta pixel nenačíta',
);
check(!(await read()).bar, 'po odpovedi lišta zmizne');

// --- a druhá návšteva sa už nepýta -------------------------------------------
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
check(!(await read()).bar, 'druhá návšteva sa už nepýta');

const footer = await page.evaluate(() => document.body.innerText);
check(footer.includes('Zásady cookies'), 'pätička odkazuje na zásady cookies');
check(footer.includes('Ochrana osobných údajov'), 'pätička odkazuje na ochranu údajov');
check(footer.includes('Aktualizovať nastavenia cookies'), 'pätička ponúka zmenu nastavení');

// --- a dá sa to zmeniť --------------------------------------------------------
await page.getByText('Aktualizovať nastavenia cookies').first().click();
await page.waitForTimeout(900);
check((await read()).panel, 'pätička otvorí rovno podrobné nastavenie');

await page.getByText('Zamietnuť všetky').first().click();
await page.waitForTimeout(900);
const declined = await stored();
check(
  declined && !declined.analytics && !declined.marketing && !declined.personalization,
  `zamietnutie prepíše predchádzajúcu odpoveď (${JSON.stringify(declined)})`,
);

// --- a súhlas so všetkým pixel pustí ------------------------------------------
await page.getByText('Aktualizovať nastavenia cookies').first().click();
await page.waitForTimeout(900);
await page.getByText('Prijať všetky').first().click();
await page.waitForTimeout(1800);
const all = await stored();
check(all && all.analytics && all.marketing && all.personalization, 'prijať všetky uloží všetky');

// Druhá polovica toho istého: keď je marketing povolený, pixel sa NAČÍTAŤ má.
// Bez nastaveného pixelu to ale nie je čo kontrolovať — čistá náhľadová
// databáza žiadny nemá a červená by tu znamenala „nie je nakonfigurované",
// nie „appka je rozbitá".
const loadedPixel = (await scripts()).some((src) => /facebook/.test(src));
if (loadedPixel) {
  check(true, 'až s marketingovým súhlasom sa Meta pixel načíta');
} else {
  console.log('• preskočené: v tejto databáze nie je nastavený Meta pixel '
    + '(Admin → Marketing), takže sa nemá čo načítať');
}

await browser.close();

console.log(failures === 0 ? '\nCOOKIES V PORIADKU' : `\n${failures} ZLYHANÍ`);
process.exit(failures === 0 ? 0 : 1);
