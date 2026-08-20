import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://localhost:4331';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, locale: 'sk-SK' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e).slice(0, 120)));

// sign in once
await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);
const email = page.locator('input[inputmode="email"], input[type="email"]').first();
if (await email.count()) {
  await email.fill('alex@blup.test');
  await page.locator('input[type="password"]').first().fill('blup12345');
  await page.getByText('Prihlásiť sa', { exact: true }).first().click();
  await page.waitForTimeout(9000);
}
console.log('logged in →', page.url());

const EVENT = 'aaaa0001-0000-0000-0000-000000000001';
const ORG_EVENT = EVENT;

const routes = [
  ['/',                          '10-domov'],
  ['/discover',                  '11-objav'],
  ['/feed',                      '12-feed'],
  ['/messages',                  '13-chat-zoznam'],
  ['/profile',                   '14-ja'],
  ['/event/' + EVENT,            '20-event-detail'],
  ['/event/checkout/' + EVENT,   '21-checkout'],
  ['/tickets',                   '22-vstupenky'],
  ['/search',                    '23-hladanie'],
  ['/activity',                  '24-aktivita'],
  ['/badges',                    '25-odznaky'],
  ['/community',                 '30-komunity'],
  ['/community/micro',           '31-micro-eventy'],
  ['/premium',                   '40-premium'],
  ['/organizer',                 '50-organizator'],
  ['/organizer/create',          '51-vytvor-event'],
  ['/organizer/accounting',      '52-uctovnictvo'],
  ['/organizer/payouts',         '53-vyplaty'],
  ['/organizer/scan',            '54-skener'],
  ['/organizer/analytics/' + ORG_EVENT, '55-statistiky'],
  ['/organizer/tickets/' + ORG_EVENT,   '56-typy-vstupeniek'],
  ['/organizer/promo/' + ORG_EVENT,     '57-promo-boost'],
  ['/settings',                  '60-nastavenia'],
  ['/settings/privacy',          '61-sukromie'],
  ['/settings/notifications',    '62-notifikacie'],
  ['/settings/saved',            '63-ulozene'],
  ['/admin',                     '70-admin'],
];

const report = [];
for (const [path, name] of routes) {
  const before = errs.length;
  await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2600);
  await page.screenshot({ path: `/tmp/shots/${name}.png`, fullPage: false });
  const text = (await page.innerText('body')).slice(0, 95).replace(/\n+/g, ' | ');
  report.push({ name, path, newErrors: errs.length - before, text });
  console.log(`${name.padEnd(22)} err+${errs.length - before}  ${text}`);
}

fs.writeFileSync('/tmp/shots/report.json', JSON.stringify(report, null, 1));
console.log('\ntotal page errors:', errs.length);
[...new Set(errs)].slice(0, 8).forEach(e => console.log('  !', e));
await browser.close();
