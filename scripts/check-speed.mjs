#!/usr/bin/env node
/**
 * Koľko trvá, kým sa stránka naozaj otvorí.
 *
 *   node scripts/check-speed.mjs              # mobile/dist, telefón na 4G
 *   node scripts/check-speed.mjs --fast       # bez brzdenia siete a procesora
 *   node scripts/check-speed.mjs https://blup.sk
 *
 * „Dlho sa načítava" je merateľná vec a doteraz sa nemerala. Tento skript
 * otvorí stránky v prehliadači spomalenom na priemerný telefón na slovenskej
 * mobilnej sieti a povie tri čísla:
 *
 *   · koľko bajtov si stiahol (v tom, v čom to naozaj chodí — brotli),
 *   · kedy sa objavilo prvé písmenko (FCP),
 *   · kedy bola stránka naozaj použiteľná (obsah, nie skeleton).
 *
 * Rozpočty dole nie sú ideál, ale hranica, pod ktorou to prestáva byť „appka"
 * a začína byť „čakanie". Keď ich build prekročí, skript spadne.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

// Playwright lives in mobile/node_modules, same as every other browser check.
const require = createRequire(new URL('../mobile/', import.meta.url));

const args = process.argv.slice(2);
const FAST = args.includes('--fast');
const target = args.find((a) => a.startsWith('http'));
const DIST = 'mobile/dist';

// Priemerný telefón, nie ten tvoj: štvornásobne pomalší procesor a linka,
// ktorá sa dá chytiť aj v meste. Na rýchlom notebooku je totiž pomalá stránka
// nerozoznateľná od rýchlej.
const NETWORK = {
  offline: false,
  latency: 150,
  downloadThroughput: (4 * 1024 * 1024) / 8,
  uploadThroughput: (1 * 1024 * 1024) / 8,
};
const CPU_SLOWDOWN = 4;

/** Rozpočty v milisekundách a bajtoch. */
const BUDGET = {
  transferredBytes: 1_600_000,
  firstPaintMs: 4000,
  usableMs: 9000,
};

const PAGES = [
  { path: '/', label: 'Domov', ready: 'text=/Blup|Objav|Zatiaľ/i' },
  { path: '/discover', label: 'Objav', ready: null },
  { path: '/premium', label: 'Premium', ready: null },
];

async function main() {
  const { chromium } = require('playwright');

  let server = null;
  let base = target;

  if (!base) {
    if (!existsSync(`${DIST}/index.html`)) {
      console.error(`Nie je build v ${DIST}. Spusti: cd mobile && npm run build:web`);
      process.exit(1);
    }
    const port = 4399;
    server = spawn('node', ['scripts/serve-web.mjs', DIST, String(port)], { stdio: 'ignore' });
    base = `http://localhost:${port}`;
    await new Promise((resolve) => setTimeout(resolve, 900));
  }

  const browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  const results = [];

  try {
    for (const page of PAGES) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      });
      const tab = await context.newPage();

      const cdp = await context.newCDPSession(tab);

      // Bajty sa počítajú tak, ako idú po drôte — teda skomprimované.
      // `response.body()` vracia UŽ ROZBALENÝ obsah, takže by ukázal 5 MB tam,
      // kde sa naozaj stiahne 900 kB; jediné pravdivé číslo je
      // `encodedDataLength` z protokolu prehliadača.
      let transferred = 0;
      let requests = 0;
      const urls = new Map();
      const heaviest = new Map();
      await cdp.send('Network.enable');
      cdp.on('Network.requestWillBeSent', (e) => {
        requests += 1;
        urls.set(e.requestId, e.request.url);
      });
      cdp.on('Network.loadingFinished', (e) => {
        transferred += e.encodedDataLength ?? 0;
        heaviest.set(urls.get(e.requestId) ?? '?', e.encodedDataLength ?? 0);
      });

      if (!FAST) {
        await cdp.send('Network.emulateNetworkConditions', NETWORK);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
      }

      const started = Date.now();
      await tab.goto(`${base}${page.path}`, { waitUntil: 'commit', timeout: 120_000 });

      // Prvé písmenko na obrazovke. Nie „stránka sa načítala" — to je moment,
      // keď človek prestane pozerať na prázdno.
      let firstPaint = null;
      try {
        firstPaint = await tab.evaluate(() => new Promise((resolve) => {
          const seen = performance.getEntriesByName('first-contentful-paint');
          if (seen.length) return resolve(seen[0].startTime);
          new PerformanceObserver((list, observer) => {
            const entry = list.getEntries().find((e) => e.name === 'first-contentful-paint');
            if (entry) { observer.disconnect(); resolve(entry.startTime); }
          }).observe({ type: 'paint', buffered: true });
          setTimeout(() => resolve(null), 30_000);
        }), { timeout: 40_000 });
      } catch {
        firstPaint = null;
      }

      // A kedy sa dá naozaj niečo robiť: keď je na obrazovke text, nie kostra.
      let usable = null;
      try {
        await tab.waitForFunction(
          () => document.body && document.body.innerText.trim().length > 40,
          { timeout: 60_000 },
        );
        usable = Date.now() - started;
      } catch {
        usable = null;
      }

      results.push({
        label: page.label,
        path: page.path,
        transferred,
        requests,
        heaviest: [...heaviest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
        firstPaint: firstPaint === null ? null : Math.round(firstPaint),
        usable,
      });

      await context.close();
    }
  } finally {
    await browser.close();
    if (server) server.kill();
  }

  console.log(`\nRýchlosť${FAST ? ' (bez brzdenia)' : ' — telefón, 4 Mbit, 4× pomalší procesor'}\n`);

  let failures = 0;
  for (const r of results) {
    const overSize = r.transferred > BUDGET.transferredBytes;
    const overPaint = r.firstPaint !== null && r.firstPaint > BUDGET.firstPaintMs;
    const overUsable = r.usable !== null && r.usable > BUDGET.usableMs;
    const missed = r.firstPaint === null || r.usable === null;

    if (!FAST && (overSize || overPaint || overUsable || missed)) failures += 1;

    const kb = `${Math.round(r.transferred / 1024)} kB`.padStart(9);
    const fcp = (r.firstPaint === null ? 'nikdy' : `${r.firstPaint} ms`).padStart(9);
    const use = (r.usable === null ? 'nikdy' : `${r.usable} ms`).padStart(9);

    console.log(
      `${overSize || overPaint || overUsable || missed ? '✗' : '✓'} ${r.label.padEnd(10)}` +
      `${kb}${overSize ? ' !' : '  '}  prvé písmeno ${fcp}${overPaint ? ' !' : '  '}` +
      `  použiteľné ${use}${overUsable ? ' !' : ''}   (${r.requests} požiadaviek)`,
    );

    // Keď je stránka nad rozpočtom, jediná užitočná ďalšia informácia je, čo
    // ju tam dostalo — inak sa optimalizuje poslepiačky.
    if (overSize) {
      for (const [url, bytes] of r.heaviest) {
        console.log(`    ${String(Math.round(bytes / 1024)).padStart(6)} kB  ${url.replace(/^https?:\/\/[^/]+/, '')}`);
      }
    }
  }

  console.log('');
  if (failures > 0) {
    console.log(
      `${failures} ${failures === 1 ? 'stránka je' : 'stránky sú'} nad rozpočtom ` +
      `(${Math.round(BUDGET.transferredBytes / 1024)} kB / ${BUDGET.firstPaintMs} ms / ` +
      `${BUDGET.usableMs} ms).`,
    );
    process.exit(1);
  }
  console.log('Všetko v rozpočte.');
}

await main();
