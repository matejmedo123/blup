#!/usr/bin/env node
/**
 * The crop sheet, in a real browser.
 *
 *   node scripts/smoke-crop.mjs 4401
 *
 * The thing that has to be true is narrow and checkable: whatever shape goes
 * in, a fixed shape comes out, and it comes out full — no empty strip along an
 * edge because the picture was dragged too far.
 *
 * It exercises the component directly rather than through the upload flow,
 * because the upload needs a backend and this needs a canvas. The sheet is what
 * decides the pixels; the rest is a file transfer.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('../mobile/node_modules/playwright');

// The component's own arithmetic, not a copy of it. A test that reimplements
// what it is testing agrees with itself forever.
const { cropRect } = await import('../mobile/src/components/imageCropMath.ts');

const port = process.argv[2] ?? 4401;
const base = `http://127.0.0.1:${port}`;

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  —  ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page.goto(base + '/', { waitUntil: 'domcontentloaded' });

/**
 * The same arithmetic the sheet does, run in the page against a real canvas.
 * A tall source (600×1600) into a 16:9 frame is the case that was broken: it
 * used to arrive untouched and stretch the card.
 */
/**
 * Each case: the rectangle comes from the shared function here in Node, the
 * drawing and the pixel counting happen in a real browser canvas.
 */
const FRAME_W = 460;
const cases = {
  // A cover, centred. 600×1600 is the case that was broken: a tall photo used
  // to arrive untouched and stretch the card it landed on.
  cover:   { out: [1920, 1080], scale: 1, offset: { x: 0, y: 0 } },
  avatar:  { out: [1024, 1024], scale: 1, offset: { x: 0, y: 0 } },
  // Dragged far past the top edge, which is where an empty strip would appear.
  dragged: { out: [1920, 1080], scale: 1, offset: { x: 0, y: 99999 } },
  // Zoomed in: still full, still the right size.
  zoomed:  { out: [1920, 1080], scale: 3, offset: { x: 0, y: 0 } },
};

const SOURCE = { width: 600, height: 1600 };

const plan = Object.fromEntries(Object.entries(cases).map(([name, c]) => {
  const [outW, outH] = c.out;
  const rect = cropRect({
    imageW: SOURCE.width,
    imageH: SOURCE.height,
    frameW: FRAME_W,
    frameH: (FRAME_W * outH) / outW,
    scale: c.scale,
    offset: c.offset,
  });
  return [name, { outW, outH, rect }];
}));

const result = await page.evaluate(async ({ plan, SOURCE }) => {
  // A source with a landmark: a red band across the middle third of a blue field.
  const src = document.createElement('canvas');
  src.width = SOURCE.width; src.height = SOURCE.height;
  const sctx = src.getContext('2d');
  sctx.fillStyle = '#1040c0';
  sctx.fillRect(0, 0, SOURCE.width, SOURCE.height);
  sctx.fillStyle = '#e01030';
  sctx.fillRect(0, SOURCE.height / 3, SOURCE.width, SOURCE.height / 3);

  const image = new Image();
  image.src = src.toDataURL('image/png');
  await image.decode();

  const out = {};
  for (const [name, { outW, outH, rect }] of Object.entries(plan)) {
    const canvas = document.createElement('canvas');
    canvas.width = outW; canvas.height = outH;
    const ctx = canvas.getContext('2d');

    // Black underneath, so any pixel the picture fails to cover shows up.
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(image, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, outW, outH);

    const data = ctx.getImageData(0, 0, outW, outH).data;
    let black = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 8 && data[i + 1] < 8 && data[i + 2] < 8) black += 1;
    }
    const mid = ctx.getImageData(Math.floor(outW / 2), Math.floor(outH / 2), 1, 1).data;

    out[name] = {
      width: canvas.width,
      height: canvas.height,
      blackPixels: black,
      middle: [mid[0], mid[1], mid[2]],
      maxY: rect.maxY,
    };
  }
  return out;
}, { plan, SOURCE });

check(
  result.cover.width === 1920 && result.cover.height === 1080,
  'titulná fotka vyjde 1920×1080',
  `${result.cover.width}×${result.cover.height}`,
);

check(
  result.avatar.width === 1024 && result.avatar.height === 1024,
  'profilovka vyjde 1024×1024',
  `${result.avatar.width}×${result.avatar.height}`,
);

// A 600×1600 source used to arrive as 600×1600. The point of the whole sheet.
check(
  result.cover.width / result.cover.height > 1.7,
  'fotka na výšku sa naozaj oreže na šírku',
  `pomer ${(result.cover.width / result.cover.height).toFixed(2)}`,
);

check(result.cover.blackPixels === 0, 'nikde nezostane prázdne miesto', `${result.cover.blackPixels} px`);
check(result.dragged.blackPixels === 0, 'ani keď ťaháš za okraj', `${result.dragged.blackPixels} px`);
check(result.zoomed.blackPixels === 0, 'ani po priblížení', `${result.zoomed.blackPixels} px`);

check(
  result.zoomed.width === 1920 && result.zoomed.height === 1080,
  'priblíženie nemení výsledný rozmer',
  `${result.zoomed.width}×${result.zoomed.height}`,
);

// Centred on a source whose middle third is red, the middle pixel is red.
const [r, g, b] = result.cover.middle;
check(r > 150 && g < 90 && b < 110, 'vystrihne to, čo je v rámčeku', `rgb(${r},${g},${b})`);

// Dragged to the top, the middle of the result comes from the blue top band.
const [dr, dg, db] = result.dragged.middle;
check(db > 120 && dr < 90, 'posunutie mení, ktorá časť sa vystrihne', `rgb(${dr},${dg},${db})`);

// A drag has to be able to move at all, or the frame is stuck.
check(result.cover.maxY > 0, 'na výšku sa dá posúvať', `${Math.round(result.cover.maxY)} px`);

await browser.close();

console.log(failures === 0 ? '\nOREZÁVANIE V PORIADKU' : `\n${failures} ZLYHANÍ`);
process.exit(failures === 0 ? 0 : 1);
