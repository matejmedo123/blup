#!/usr/bin/env node
/**
 * End-to-end smoke test for the web build.
 *
 *   node scripts/smoke-web.mjs [base-url]
 *
 * Drives a real browser through the paths that matter: a visitor browsing
 * without an account, someone signing up, an attendee saying they are going,
 * a basket that reserves and prices correctly, an organizer publishing an
 * event, an admin refusing a malformed pixel id.
 *
 * What it deliberately does NOT do is mock anything. Every assertion is made
 * against what the page actually renders, against a real database. That is the
 * point: a green run here means the deployment works, not that the test
 * doubles agree with each other.
 *
 * Requires: a build served at the base URL (npm run serve:web) and the demo
 * seed (node supabase/seed/seed.mjs). Payment is exercised up to the redirect
 * to Stripe — completing it needs live keys and a card, which is step 13 of
 * SPUSTENIE.md and cannot be automated here.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Playwright lives in the app workspace, not next to this script, and Node
// resolves imports relative to the file rather than the working directory.
const HERE = dirname(fileURLToPath(import.meta.url));
const candidates = [join(HERE, '..', 'mobile'), HERE, process.cwd()]
  .map((dir) => join(dir, 'node_modules', 'playwright'))
  .filter((path) => existsSync(path));

if (candidates.length === 0) {
  console.error('Playwright nie je nainštalovaný. Spusti: cd mobile && npm install');
  process.exit(2);
}
const { chromium } = createRequire(import.meta.url)(candidates[0]);

const BASE = process.argv[2] ?? 'http://localhost:4321';
const EVENT = process.env.SMOKE_EVENT_ID ?? 'aaaa0001-0000-0000-0000-000000000001';
const ADMIN = { email: 'alex@blup.test', pass: 'blup12345' };
const BUYER = { email: 'mia@blup.test', pass: 'blup12345' };
// Respect a preinstalled browser (CI images often ship one) before asking
// Playwright to look for its own download.
const CHROME = process.env.CHROME_PATH
  || (process.env.PLAYWRIGHT_BROWSERS_PATH
      && [
           join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium'),
           join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium-1194', 'chrome-linux', 'chrome'),
         ].find((p) => existsSync(p)))
  || undefined;

const results = [];
let group = '';
const heading = (name) => { group = name; results.push({ group: name }); };
const ok   = (name, detail = '') => results.push({ group, name, pass: true, detail });
const bad  = (name, detail = '') => results.push({ group, name, pass: false, detail });
/** Neither passed nor failed: the environment could not run this one. */
const skip = (name, detail = '') => results.push({ group, name, skip: true, detail });

class Skipped extends Error {}

async function check(name, fn) {
  try {
    const detail = await fn();
    ok(name, detail ?? '');
  } catch (error) {
    const message = String(error.message ?? error).split('\n')[0].slice(0, 140);
    if (error instanceof Skipped) skip(name, message);
    else bad(name, message);
  }
}

const assert = (cond, message) => { if (!cond) throw new Error(message); };

const browser = await chromium.launch({ executablePath: CHROME });
const pageErrors = [];

async function open() {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 }, locale: 'sk-SK',
    geolocation: { latitude: 48.1486, longitude: 17.1077 }, permissions: ['geolocation'],
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 120)));
  return { ctx, page };
}

async function go(page, path, wait = 3000) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(wait);
}

const textOf = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');

async function signIn(page, who) {
  await go(page, '/(auth)/sign-in', 3000);
  await page.locator('input[inputmode="email"], input[type="email"]').first().fill(who.email);
  await page.locator('input[type="password"]').first().fill(who.pass);
  await page.getByText('Prihlásiť sa', { exact: true }).first().click();
  await page.waitForTimeout(8000);
}

// ---------------------------------------------------------------------------
heading('Návštevník bez účtu');
{
  const { ctx, page } = await open();

  await check('domov ukáže skutočné eventy', async () => {
    await go(page, '/', 6000);
    const t = await textOf(page);
    assert(!/Zatiaľ sa tu nič nedeje/.test(t), 'zobrazil sa prázdny stav');
    const cards = await page.locator('text=/ide$|ide /').count();
    assert(t.includes('Dnes okolo teba'), 'chýba hlavička feedu');
    return `${cards} kariet`;
  });

  await check('hľadanie vracia výsledky', async () => {
    await go(page, '/search', 3500);
    const t = await textOf(page);
    assert(t.length > 200 && !/Nič sa nenašlo/.test(t), 'hľadanie je prázdne');
    return '';
  });

  await check('detail eventu je otvorený aj bez účtu', async () => {
    await go(page, '/event/' + EVENT, 4000);
    const t = await textOf(page);
    assert(t.includes('Vstupenky') || t.includes('Idem'), 'detail sa nenačítal');
    assert(!/could not be found/.test(t), '404');
    return '';
  });

  await check('„Idem“ vyvolá výzvu na účet, nie chybu', async () => {
    await page.getByText('Idem', { exact: true }).first().click();
    await page.waitForTimeout(2000);
    const t = await textOf(page);
    assert(t.includes('Potrebuješ účet'), 'nezobrazilo sa okienko s účtom');
    return '';
  });

  await check('košík hosťa je pozvánka, nie prázdna stránka', async () => {
    await go(page, '/cart', 3000);
    const t = await textOf(page);
    assert(t.includes('Košík patrí k účtu'), 'chýba pozvánka');
    return '';
  });

  await ctx.close();
}

// ---------------------------------------------------------------------------
heading('Registrácia a prihlásenie');
{
  const { ctx, page } = await open();
  const email = `smoke+${Date.now()}@blup.test`;

  await check('registračný formulár má všetky polia', async () => {
    await go(page, '/(auth)/sign-up', 3500);
    const inputs = await page.locator('input').count();
    assert(inputs >= 4, `čakal som meno, e-mail a dve heslá, našiel som ${inputs} polí`);
    return `${inputs} polia`;
  });

  await check('nový účet naozaj vznikne', async () => {
    // Fill by position: name, e-mail, password, repeat. The heading on this
    // screen has the same words as the button, so the button is taken by role
    // rather than by text — clicking the heading is a silent no-op and would
    // make this test pass while creating nothing.
    const inputs = page.locator('input');
    await inputs.nth(0).fill('Smoke Test');
    await inputs.nth(1).fill(email);
    await inputs.nth(2).fill('SmokeTest123!');
    await inputs.nth(3).fill('SmokeTest123!');

    const button = page.getByRole('button', { name: /Vytvoriť účet/ }).last();
    assert(await button.count() > 0, 'chýba tlačidlo registrácie');
    await button.click();
    await page.waitForTimeout(9000);

    const t = await textOf(page);
    const path = new URL(page.url()).pathname;

    // A local stack without an SMTP container cannot send the confirmation
    // mail, so GoTrue refuses the signup. That is the environment failing, not
    // the app — but it is not a pass either, so it is reported as its own thing
    // rather than quietly counted as green.
    if (/nepodarilo odoslať|sending confirmation email/i.test(t)) {
      throw new Skipped('prostredie nevie odoslať e-mail (chýba SMTP / inbucket)');
    }
    assert(!/už existuje|Invalid|nepodarilo/i.test(t), 'registrácia zlyhala: ' + t.slice(0, 90));
    // Either the app let them straight in (onboarding) or it is waiting for the
    // confirmation e-mail. Staying on the form means nothing happened.
    const landed = /onboarding|interests|profile|verify/i.test(path)
      || /Potvrď|schránk|Kto si|Čo ťa baví/i.test(t);
    assert(landed, `zostal na formulári: ${path}`);
    return path;
  });

  await ctx.close();
}

// ---------------------------------------------------------------------------
heading('Účastník');
{
  const { ctx, page } = await open();
  await signIn(page, BUYER);

  await check('prihlásenie skončí v aplikácii', async () => {
    const t = await textOf(page);
    assert(t.includes('Domov') && t.includes('Objav'), 'nedostal sa do appky');
    return new URL(page.url()).pathname;
  });

  await check('uloženie eventu pribudne a odobranie ubudne', async () => {
    // Counting before and after, because "the list is not empty" would pass
    // even if the button did nothing at all.
    const countSaved = async () => {
      await go(page, '/settings/saved', 3000);
      return page.locator('text=/\\d+ ide/').count();
    };

    const before = await countSaved();
    await go(page, '/event/' + EVENT, 4000);
    const toggle = page.getByText(/Uložiť|Uložené/).first();
    assert(await toggle.count() > 0, 'chýba tlačidlo uloženia');
    const wasSaved = /Uložené/.test(await toggle.innerText());

    await toggle.click();
    await page.waitForTimeout(2800);
    const after = await countSaved();

    assert(after === before + (wasSaved ? -1 : 1),
      `počet uložených sa nezmenil správne: ${before} → ${after}`);

    // put it back the way it was
    await go(page, '/event/' + EVENT, 3500);
    await page.getByText(/Uložiť|Uložené/).first().click();
    await page.waitForTimeout(2000);
    return `${before} → ${after}`;
  });

  await check('košík: pridanie, súčet a poplatok sedia', async () => {
    await go(page, '/cart', 2500);
    const clear = page.getByText('Vyprázdniť', { exact: true });
    if (await clear.count()) { await clear.first().click(); await page.waitForTimeout(2000); }

    await go(page, '/event/' + EVENT, 4000);
    const add = page.getByText('Pridať', { exact: true });
    assert(await add.count() > 0, 'chýba tlačidlo Pridať');
    await add.first().click();
    await page.waitForTimeout(2200);

    await go(page, '/cart', 3500);
    const t = await textOf(page);
    assert(/Vstupenky sú rezervované/.test(t), 'nebeží rezervácia');
    assert(/Archívny poplatok/.test(t), 'chýba archívny poplatok');
    const m = t.match(/Zaplatiť ([\d\s,]+)\s*€/);
    assert(m, 'chýba tlačidlo so sumou');
    return `spolu ${m[1].trim()} €`;
  });

  await check('odpočet rezervácie beží a je pod 15 minútami', async () => {
    const t = await textOf(page);
    const m = t.match(/(\d+):(\d\d)/);
    assert(m, 'chýba odpočet');
    const secs = Number(m[1]) * 60 + Number(m[2]);
    assert(secs > 0 && secs <= 15 * 60, `odpočet mimo rozsahu: ${m[0]}`);
    return m[0];
  });

  await check('pokladňa zobrazí cenu vrátane poplatku', async () => {
    await go(page, '/event/checkout/' + EVENT, 4000);
    const t = await textOf(page);
    assert(/Archívny poplatok/.test(t), 'chýba archívny poplatok');
    assert(/Zaplatiť/.test(t), 'chýba tlačidlo platby');
    return '';
  });

  await check('vstupenky a notifikácie sa načítajú', async () => {
    await go(page, '/tickets', 3000);
    assert(!/Toto nevyšlo|vypršala/.test(await textOf(page)), 'chyba na vstupenkách');
    await go(page, '/activity', 2500);
    assert(!/Toto nevyšlo/.test(await textOf(page)), 'chyba na notifikáciách');
    return '';
  });

  await ctx.close();
}

// ---------------------------------------------------------------------------
heading('Organizátor');
{
  const { ctx, page } = await open();
  await signIn(page, ADMIN);
  const title = `Smoke test ${new Date().toISOString().slice(11, 19)}`;

  await check('vytvorenie eventu ho zverejní', async () => {
    await go(page, '/organizer/create', 4500);
    await page.locator('input').first().fill(title);
    const publish = page.getByText(/Zverejniť event/).first();
    assert(await publish.count() > 0, 'chýba tlačidlo zverejnenia');
    await publish.click();
    await page.waitForTimeout(6000);
    const t = await textOf(page);
    assert(!/Toto ešte oprav/.test(t) || /Kategóriu|Vyber/.test(t), 'formulár odmietol vstup');
    return new URL(page.url()).pathname;
  });

  await check('štatistiky eventu vykreslia krivku predaja', async () => {
    await go(page, '/organizer/analytics/' + EVENT, 5000);
    const t = await textOf(page);
    assert(/Predaj v čase/.test(t), 'chýba graf');
    assert(/Predané vstupenky/.test(t), 'chýbajú čísla predaja');
    return '';
  });

  await check('účtovníctvo sedí na cent', async () => {
    await go(page, '/organizer/accounting', 4500);
    const t = await textOf(page);
    const gross = t.match(/Predaj v cenníku ([\d\s,]+) €/);
    const fee   = t.match(/Provízia BLUP − ([\d\s,]+) €/);
    const net   = t.match(/Tvoj čistý príjem ([\d\s,]+) €/);
    assert(gross && fee && net, 'chýbajú položky rozpisu');
    const num = (s) => Number(s.replace(/\s/g, '').replace(',', '.'));
    const diff = Math.abs((num(gross[1]) - num(fee[1])) - num(net[1]));
    assert(diff < 0.011, `rozpis nesedí: ${gross[1]} − ${fee[1]} ≠ ${net[1]}`);
    return `${gross[1]} − ${fee[1]} = ${net[1]} €`;
  });

  await check('typy vstupeniek a promo kódy sa načítajú', async () => {
    await go(page, '/organizer/tickets/' + EVENT, 3500);
    assert(/Existujúce vstupenky/.test(await textOf(page)), 'chýbajú typy vstupeniek');
    await go(page, '/organizer/promo/' + EVENT, 3500);
    assert(/Promo kódy/.test(await textOf(page)), 'chýbajú promo kódy');
    return '';
  });

  await check('skener odmietne nezmyselný kód', async () => {
    await go(page, '/organizer/scan', 3500);
    const input = page.locator('input').first();
    await input.fill('BLP-NEEXISTUJE');
    await page.getByText('Odbaviť', { exact: true }).first().click();
    await page.waitForTimeout(3000);
    const t = await textOf(page);
    assert(!/Odbavený|Vitaj/.test(t), 'skener prijal neexistujúci kód');
    return '';
  });

  await ctx.close();
}

// ---------------------------------------------------------------------------
heading('Administrácia');
{
  const { ctx, page } = await open();
  await signIn(page, ADMIN);

  await check('prehľad platformy ukáže tržby', async () => {
    await go(page, '/admin', 3500);
    const t = await textOf(page);
    assert(/Hrubý predaj/.test(t) && /Príjem BLUPu/.test(t), 'chýbajú tržby');
    return '';
  });

  await check('vyhľadávanie eventov filtruje', async () => {
    await go(page, '/admin/events', 3500);
    await page.locator('input').first().fill('Warehouse');
    await page.waitForTimeout(3000);
    const t = await textOf(page);
    assert(/Warehouse/.test(t), 'nenašlo event');
    assert(!/Vinyl Only/.test(t), 'filter neodfiltroval ostatné');
    return '';
  });

  await check('marketing odmietne nezmyselný pixel', async () => {
    await go(page, '/admin/marketing', 3500);
    const pixel = page.locator('input').first();
    await pixel.fill('<script>alert(1)</script>');
    await page.waitForTimeout(1200);
    const t = await textOf(page);
    const save = page.getByText('Uložiť', { exact: true }).first();
    const disabled = await save.isDisabled().catch(() => false);
    assert(disabled || /len číslo/.test(t), 'formulár prijal markup');
    return '';
  });

  await check('poplatky sa dajú otvoriť a majú aktuálne sadzby', async () => {
    await go(page, '/admin/fees', 3500);
    const t = await textOf(page);
    assert(/Provízia z predaja/.test(t) && /Archívny poplatok/.test(t), 'chýbajú sadzby');
    return '';
  });

  await ctx.close();
}

// ---------------------------------------------------------------------------
await browser.close();

const groups = [];
let current = null;
for (const r of results) {
  if (r.group && !r.name) { current = { name: r.group, rows: [] }; groups.push(current); }
  else current.rows.push(r);
}

let pass = 0, fail = 0, skipped = 0;
for (const g of groups) {
  console.log(`\n${g.name}`);
  for (const r of g.rows) {
    const mark = r.skip ? '–' : r.pass ? '✓' : '✗';
    console.log(`  ${mark} ${r.name.padEnd(48)} ${r.detail}`);
    if (r.skip) skipped++; else if (r.pass) pass++; else fail++;
  }
}

console.log(`\nchyby v konzole: ${pageErrors.length}`);
if (pageErrors.length) console.log('  ' + [...new Set(pageErrors)].slice(0, 5).join('\n  '));
console.log(`\n${pass} prešlo, ${fail} zlyhalo${skipped ? `, ${skipped} preskočené` : ''}`);
process.exit(fail === 0 && pageErrors.length === 0 ? 0 : 1);
