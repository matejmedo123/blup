#!/usr/bin/env node
/**
 * The map, on a phone.
 *
 * Zooming was the mouse wheel and nothing else, so on a phone there was no way
 * to zoom at all: no wheel, and a pinch reached the drag handler as one
 * confused pointer. Nothing threw and nothing logged — the map simply sat at
 * one zoom level for everybody on a touch screen.
 *
 * So this drives a real touch context: the buttons, a pinch through CDP touch
 * events, and a drag. The zoom level is read back out of the tile URLs, which
 * is the map's own answer rather than the app's opinion of it.
 *
 *   node scripts/serve-web.mjs mobile/dist 4401
 *   node scripts/smoke-map.mjs [port]
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
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();

await page.goto(`${base}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1400);
await page.getByText('Mapa').first().click();
await page.waitForTimeout(1600);

/** The zoom the map is actually drawing, read from a tile's URL. */
const zoomOf = () => page.evaluate(() => {
  const tile = [...document.querySelectorAll('img')]
    .find((i) => /openstreetmap|MapServer|cartocdn/.test(i.src));
  if (!tile) return null;
  const parts = new URL(tile.src).pathname.split('/').filter(Boolean);
  const z = parts.find((p) => /^\d+$/.test(p) && Number(p) <= 22);
  return z ? Number(z) : null;
});

/** Every tile on screen, so a pan is visible however the grid renumbers. */
const tilesOf = () => page.evaluate(() => [...document.querySelectorAll('img')]
  .filter((i) => /openstreetmap|MapServer|cartocdn/.test(i.src))
  .map((i) => i.src)
  .sort()
  .join(','));

const start = await zoomOf();
check(start !== null, `mapa kreslí dlaždice (zoom ${start})`);

check(await page.getByLabel('Priblížiť').count() === 1, 'tlačidlo priblíženia existuje');
check(await page.getByLabel('Oddialiť').count() === 1, 'tlačidlo oddialenia existuje');

await page.getByLabel('Priblížiť').click();
await page.waitForTimeout(800);
check(await zoomOf() === start + 1, 'tlačidlo + priblíži o jednu úroveň');

await page.getByLabel('Oddialiť').click();
await page.getByLabel('Oddialiť').click();
await page.waitForTimeout(800);
check(await zoomOf() === start - 1, 'tlačidlo − oddiali');

// --- pinch ------------------------------------------------------------------
const box = await page.evaluate(() => {
  const el = [...document.querySelectorAll('div')].find((d) => d.style.touchAction === 'none');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
});

if (!box) {
  check(false, 'mapu som na stránke nenašiel');
} else {
  const cdp = await context.newCDPSession(page);
  const before = await zoomOf();

  const touch = (type, points) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });

  // Fingers apart: 80px → 320px is four times, which is two zoom levels.
  await touch('touchStart', [{ x: box.x - 40, y: box.y, id: 1 }, { x: box.x + 40, y: box.y, id: 2 }]);
  for (const d of [80, 120, 160]) {
    await touch('touchMove', [{ x: box.x - d, y: box.y, id: 1 }, { x: box.x + d, y: box.y, id: 2 }]);
    await page.waitForTimeout(80);
  }
  await touch('touchEnd', [{ x: box.x + 160, y: box.y, id: 2 }]);
  await touch('touchEnd', []);
  await page.waitForTimeout(900);

  check(await zoomOf() === before + 2, `roztiahnutie dvoch prstov priblíži (${before} → ${await zoomOf()})`);

  // ...and back together.
  const zoomedIn = await zoomOf();
  await touch('touchStart', [{ x: box.x - 160, y: box.y, id: 1 }, { x: box.x + 160, y: box.y, id: 2 }]);
  for (const d of [120, 80, 40]) {
    await touch('touchMove', [{ x: box.x - d, y: box.y, id: 1 }, { x: box.x + d, y: box.y, id: 2 }]);
    await page.waitForTimeout(80);
  }
  await touch('touchEnd', [{ x: box.x + 40, y: box.y, id: 2 }]);
  await touch('touchEnd', []);
  await page.waitForTimeout(900);
  check(await zoomOf() === zoomedIn - 2, 'stiahnutie prstov oddiali');

  // --- drag -----------------------------------------------------------------
  const beforeTiles = await tilesOf();
  await touch('touchStart', [{ x: box.x, y: box.y, id: 1 }]);
  for (const dx of [60, 140, 220, 300]) {
    await touch('touchMove', [{ x: box.x + dx, y: box.y, id: 1 }]);
    await page.waitForTimeout(60);
  }
  await touch('touchEnd', []);
  await page.waitForTimeout(1000);
  check(await tilesOf() !== beforeTiles, 'ťahanie prstom posunie mapu');

}

await browser.close();
console.log(failures === 0 ? '\nMAPA V PORIADKU' : `\n${failures} ZLYHANÍ`);
process.exit(failures === 0 ? 0 : 1);
