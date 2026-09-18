/**
 * The plan of a hall is drawn on by dragging, and a browser fights that twice.
 *
 * On a pointer: pressing on an <img> starts the browser's own drag-and-drop
 * before React Native's responder system sees anything, so the gesture draws
 * nothing and drags the picture instead. That was the bug — reported as "keď
 * ťahám po pláne, ťahá mi to obrázok, čo je pod tým nahratý".
 *
 * On a touch screen: the page scrolls, and a scroll the browser has already
 * begun cannot be cancelled from JavaScript.
 *
 * Neither is visible without a backend, an admin session and an uploaded plan,
 * so neither shows up in the browser suites. This checks the two halves of the
 * fix instead: that the components keep the picture out of the hit path, and
 * that the stylesheet which ships actually applies touch-action to the surface.
 */
import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// playwright is a devDependency of the app, not of the repo root.
const require = createRequire(new URL('../mobile/', import.meta.url));
const { chromium } = require('playwright');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] ?? 'http://127.0.0.1:4401';

let failed = 0;
const ok = (msg) => console.log(`✓ ${msg}`);
const bad = (msg) => { console.log(`✗ ${msg}`); failed += 1; };

// --- half one: the picture is not in the hit path -------------------------
// A source check, because the screen that shows it needs an admin session and
// an uploaded plan — neither of which exists in a build with no backend.
const SCREENS = [
  ['mobile/app/organizer/plan/[id].tsx', 'editor sály'],
  ['mobile/app/event/seats/[id].tsx', 'plán pre kupujúceho'],
];

for (const [file, label] of SCREENS) {
  const src = readFileSync(join(ROOT, file), 'utf8');

  // Every <Image> that draws the uploaded plan must sit inside a wrapper that
  // takes no pointer events. Matching the wrapper rather than the Image is
  // deliberate: `pointerEvents` on expo-image is its business to forward, and
  // on a View react-native-web is documented to emit `pointer-events: none`.
  const wrapped = /<View style={StyleSheet\.absoluteFill} pointerEvents="none">\s*<Image/g;
  const images = /<Image\s+source={{ uri: map[.\w?]*\.image_url }}/g;

  const nWrapped = (src.match(wrapped) ?? []).length;
  const nImages = (src.match(images) ?? []).length;

  if (nImages === 0) {
    bad(`${label}: nenašiel som obrázok plánu — zmenil sa tvar kódu, uprav túto kontrolu`);
  } else if (nWrapped >= nImages) {
    ok(`${label}: obrázok plánu je mimo dosahu gesta (${nWrapped}×)`);
  } else {
    bad(`${label}: obrázok plánu nie je obalený <View pointerEvents="none"> — `
      + 'ťahanie po pláne bude ťahať obrázok namiesto kreslenia');
  }
}

// --- half two: the stylesheet that ships actually does it ------------------
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });

const surface = await page.evaluate(() => {
  const el = document.createElement('div');
  el.id = 'blup-plan-surface';
  el.style.width = '200px';
  el.style.height = '200px';
  document.body.appendChild(el);
  const style = getComputedStyle(el);
  return { touchAction: style.touchAction, userDrag: style.webkitUserDrag ?? null };
});

if (surface.touchAction === 'none') {
  ok('plán má touch-action: none — ťahanie prstom kreslí, nescrolluje stránku');
} else {
  bad(`plán má touch-action: ${surface.touchAction} — na telefóne sa bude stránka `
    + 'posúvať namiesto kreslenia. Chýba pravidlo v mobile/app/+html.tsx.');
}

// And the thing the bug was actually about: an image inside the surface must
// not start a native drag.
const dragged = await page.evaluate(async () => {
  const surfaceEl = document.getElementById('blup-plan-surface');
  const img = document.createElement('img');
  // A 1×1 transparent GIF: enough to be draggable, no network needed.
  img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  img.style.width = '100%';
  img.style.height = '100%';
  surfaceEl.appendChild(img);

  let started = false;
  img.addEventListener('dragstart', () => { started = true; });
  // draggable is what the browser consults before firing dragstart.
  return { started, draggable: img.draggable, userDrag: getComputedStyle(img).webkitUserDrag ?? null };
});

if (dragged.userDrag === 'none' || dragged.userDrag === null) {
  ok(`obrázok v pláne sa nedá vytiahnuť z stránky (-webkit-user-drag: ${dragged.userDrag ?? 'nepodporované'})`);
} else {
  bad(`obrázok v pláne má -webkit-user-drag: ${dragged.userDrag} — dá sa vytiahnuť zo stránky`);
}

await browser.close();

console.log();
if (failed > 0) {
  console.log(`${failed} PROBLÉMOV`);
  process.exit(1);
}
console.log('KRESLENIE PLÁNU V PORIADKU');
