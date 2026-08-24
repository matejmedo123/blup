import { createRequire } from 'module';
const require = createRequire(new URL('../mobile/', import.meta.url));
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:4399';
const results = [];
const ok = (n, c, d='') => results.push([c?'✓':'✗', n, d]);

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });

async function bodyState(page) {
  return page.evaluate(() => {
    const root = document.getElementById('root') || document.body;
    return { text: (root.innerText||'').trim().slice(0,120), len: (root.innerText||'').trim().length, title: document.title };
  });
}

for (const [label, viewport] of [['desktop',{width:1280,height:900}], ['mobil',{width:390,height:844}]]) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0,140)));

  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  let s = await bodyState(page);
  ok(`${label}: / nie je prazdna`, s.len > 20, `${s.len} znakov · "${s.text.slice(0,50)}"`);
  ok(`${label}: / ma title`, s.title.includes('Blup'), s.title);

  // deep link into a nested route, then navigate home
  await page.goto(BASE + '/event/photos/c3d9abad-e5d9-42de-9a34-13c810a04a3d', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  s = await bodyState(page);
  ok(`${label}: hlboky odkaz nie je prazdny`, s.len > 20, `${s.len} znakov`);

  // client-side navigation back to /
  await page.evaluate(() => history.pushState({}, '', '/'));
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  s = await bodyState(page);
  ok(`${label}: navrat na / nie je prazdny`, s.len > 20, `${s.len} znakov · "${s.text.slice(0,50)}"`);

  ok(`${label}: ziadne JS chyby`, errors.length === 0, errors[0] ?? '');
  await ctx.close();
}

await browser.close();
for (const [m,n,d] of results) console.log(`${m} ${n}${d?'  —  '+d:''}`);
console.log(results.every(r=>r[0]==='✓') ? '\nVSETKO PRESLO' : '\nNIECO ZLYHALO');
