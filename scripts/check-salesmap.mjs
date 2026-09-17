#!/usr/bin/env node
/**
 * The sales map, rendered with real numbers, in a real browser.
 *
 *   CHROMIUM_PATH=... node scripts/check-salesmap.mjs
 *
 * The component needs data the sandbox has no backend to provide, so the data
 * is supplied here and the maths module — the part that can silently put a town
 * in the wrong place — is the same one the app imports.
 */
import { createRequire } from 'module';
const { chromium } = createRequire('/home/user/blup/mobile/')('playwright');
const { bubbleRadius, fitPoints, projectToViewport } =
  await import('/home/user/blup/mobile/src/components/mapTiles.ts');

const CITIES = [
  { city: 'Bratislava', tickets: 120, latitude: 48.1486, longitude: 17.1077 },
  { city: 'Nitra',      tickets: 30,  latitude: 48.3069, longitude: 18.0864 },
  { city: 'Košice',     tickets: 12,  latitude: 48.7164, longitude: 21.2611 },
  { city: 'Žilina',     tickets: 4,   latitude: 49.2231, longitude: 18.7394 },
];

const W = 900, H = 360;
const view = fitPoints(CITIES, W, H);
const max = Math.max(...CITIES.map((c) => c.tickets));

const bubbles = CITIES.map((c) => {
  const p = projectToViewport(c, view.centre, view.zoom, W, H);
  return { ...c, ...p, r: bubbleRadius(c.tickets, max) };
});

const html = `<!doctype html><html><body style="margin:0;background:#0A0D12">
<div id="map" style="position:relative;width:${W}px;height:${H}px;overflow:hidden">
${bubbles.map((b) => `<div data-city="${b.city}" data-r="${b.r}" style="position:absolute;left:${b.x - b.r}px;top:${b.y - b.r}px;width:${b.r * 2}px;height:${b.r * 2}px;border-radius:50%;background:rgba(0,128,255,.34);border:1.5px solid #0080FF"></div>`).join('')}
</div></body></html>`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.setContent(html);

let failed = 0;
const ok = (label, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail ? `  —  ${detail}` : ''}`);
  if (!cond) failed++;
};

const boxes = await page.$$eval('[data-city]', (nodes) => nodes.map((n) => {
  const rect = n.getBoundingClientRect();
  return { city: n.dataset.city, x: rect.x, y: rect.y, w: rect.width, right: rect.right, bottom: rect.bottom };
}));

ok('všetky mestá sú vykreslené', boxes.length === CITIES.length, `${boxes.length}`);
ok('žiadne nevypadlo z mapy',
  boxes.every((b) => b.x >= -2 && b.y >= -2 && b.right <= W + 2 && b.bottom <= H + 2),
  boxes.map((b) => `${b.city}(${b.x.toFixed(0)},${b.y.toFixed(0)})`).join(' '));

const ba = boxes.find((b) => b.city === 'Bratislava');
const ke = boxes.find((b) => b.city === 'Košice');
const za = boxes.find((b) => b.city === 'Žilina');
ok('Košice sú napravo od Bratislavy', ke.x > ba.x, `${ke.x.toFixed(0)} > ${ba.x.toFixed(0)}`);
ok('Žilina je severnejšie ako Bratislava', za.y < ba.y, `${za.y.toFixed(0)} < ${ba.y.toFixed(0)}`);

// 120 vs 30 tickets is 4×, so the bubble must be exactly twice as wide.
const ni = boxes.find((b) => b.city === 'Nitra');
ok('štvornásobok vstupeniek je dvojnásobná bublina',
  Math.abs((ba.w - 12) / (ni.w - 12) - 2) < 0.15,
  `${ni.w.toFixed(1)} → ${ba.w.toFixed(1)} px`);

await page.screenshot({ path: '/tmp/salesmap.png' });
console.log(failed === 0 ? '\nMAPA PREDAJA V PORIADKU' : `\nZLYHALO: ${failed}`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
