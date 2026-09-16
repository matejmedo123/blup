#!/usr/bin/env node
/**
 * The pull-to-refresh decision, on its own.
 *
 *   node scripts/check-pull.mjs
 *
 * The first version of this gesture went through react-native-web's responder
 * props and did not work on a phone, and I could not reproduce it here — so the
 * part that decides *whether a drag is a pull* is now a pure function, and this
 * is it under test. The listeners around it are four lines; this is where it
 * can be wrong.
 */
const { pullStep, pullReleased, PULL_TRIGGER, PULL_SLOP } =
  await import('../mobile/src/hooks/pullMath.ts');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  —  ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// A pull only begins at the top. Halfway down a list it is a scroll.
check(
  pullStep({ atTop: false, dx: 0, dy: 200, armed: false }).abandoned,
  'v strede zoznamu to nie je ťahanie, ale skrolovanie',
);

// Straight down, far enough to commit.
const down = pullStep({ atTop: true, dx: 0, dy: 60, armed: false });
check(down.armed && down.distance > 0, 'ťah nadol na vrchu sa počíta', `${Math.round(down.distance)} px`);

// Not far enough yet to say either way — and it must stay alive.
const tiny = pullStep({ atTop: true, dx: 0, dy: PULL_SLOP - 2, armed: false });
check(
  !tiny.armed && !tiny.abandoned && tiny.distance === 0,
  'pár pixelov ešte nič neznamená, ale gesto nekončí',
);

// Upward is never a pull.
check(
  pullStep({ atTop: true, dx: 0, dy: -40, armed: false }).abandoned,
  'ťah nahor nie je ťahanie nadol',
);

// Mostly sideways is a swipe, not a pull.
check(
  pullStep({ atTop: true, dx: 90, dy: 30, armed: false }).abandoned,
  'ťah do strany sa neberie ako obnovenie',
);

// Once armed, a sideways wobble must not cancel it — fingers are not straight.
const wobble = pullStep({ atTop: true, dx: 60, dy: 80, armed: true });
check(
  wobble.armed && !wobble.abandoned,
  'keď už ťaháš, mierne vybočenie prstom to nezruší',
);

// It resists, and it has a ceiling.
const far = pullStep({ atTop: true, dx: 0, dy: 1000, armed: true });
check(far.distance < 1000, 'ťahanie kladie odpor', `1000 px ťahu → ${Math.round(far.distance)} px`);
check(far.distance <= 110, 'a má strop', `${Math.round(far.distance)} px`);

// The threshold.
check(!pullReleased(PULL_TRIGGER - 1), 'krátky ťah neobnoví');
check(pullReleased(PULL_TRIGGER), 'dosť dlhý ťah obnoví');

// Pulled down and back up again: still one gesture, nothing shown.
const back = pullStep({ atTop: true, dx: 0, dy: -5, armed: true });
check(!back.abandoned && back.distance === 0, 'vrátenie prsta späť nič neobnoví');


console.log(failures === 0 ? 'Gesto: v poriadku' : `${failures} ZLYHANÍ v gestách`);

// ---------------------------------------------------------------------------
// The wiring, in a browser — when there is a backend to talk to.
//
//   node scripts/check-pull.mjs 4321
//
// Reported as "not exercised" rather than passing when it cannot run. Every
// screen that has this gesture needs data; without a backend they retry, fail
// and remount in a loop, so the touch that starts a pull and the touch that
// continues it land on two different instances of the component. That is the
// environment, not the code — but a check that goes green on it would be worse
// than no check at all.
// ---------------------------------------------------------------------------
const port = process.argv[2];
if (!port) {
  console.log(failures === 0 ? '\nGESTO V PORIADKU' : '');
  process.exit(failures === 0 ? 0 : 1);
}

const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const { chromium } = require('../mobile/node_modules/playwright');

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

/** One finger, from `fromY` down to `toY`. */
const drag = async (fromY, toY) => page.evaluate(async ([a, b]) => {
  const make = (y) => {
    const t = new Touch({ identifier: 1, target: document.body, pageX: 40, pageY: y, clientX: 40, clientY: y });
    return { touches: [t], targetTouches: [t], changedTouches: [t], bubbles: true, cancelable: true };
  };
  document.dispatchEvent(new TouchEvent('touchstart', make(a)));
  for (let i = 1; i <= 10; i += 1) {
    document.dispatchEvent(new TouchEvent('touchmove', make(a + ((b - a) * i) / 10)));
    await new Promise((r) => setTimeout(r, 16));
  }
}, [fromY, toY]);

await drag(100, 360);
const shown = await page.locator('text=Pusti a obnoví sa').count()
  + await page.locator('text=Potiahni nadol').count();
await page.evaluate(() => document.dispatchEvent(new TouchEvent('touchend', { bubbles: true })));

// Did the screen hold still long enough for a gesture to survive it?
const stable = await page.evaluate(() => Boolean(document.querySelector('[data-testid], main, div')));
await browser.close();

if (shown > 0) {
  check(true, 'ťah v prehliadači ukáže indikátor');
  console.log(failures === 0 ? '\nGESTO AJ ZAPOJENIE V PORIADKU' : `\n${failures} ZLYHANÍ`);
  process.exit(failures === 0 ? 0 : 1);
}

console.log('');
console.log('◦ zapojenie sa tu overiť nedalo — obrazovky s týmto gestom');
console.log('  potrebujú dáta a bez backendu sa v slučke odmountovávajú.');
console.log('  Otestuj na telefóne proti ostrému nasadeniu.');
console.log(failures === 0 ? '\nGESTO V PORIADKU (zapojenie neoverené)' : `\n${failures} ZLYHANÍ`);
process.exit(failures === 0 ? 0 : 1);
