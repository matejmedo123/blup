#!/usr/bin/env node
/**
 * Koľko úrovní zoomu spraví skutočné koleso a skutočný trackpad.
 *
 *   node scripts/check-map-zoom.mjs
 *
 * Odďaľovanie mapy bolo dvakrát zle a zakaždým opačne. Najprv preletela pol
 * Európy pri jednom švihu; po oprave sa naopak takmer nehýbala. Obe verzie
 * vyzerali v kóde rozumne a ani jedna sa nedala posúdiť čítaním — rozdiel je
 * v tom, koľko udalostí pošle zariadenie, a to sa dá len prehrať.
 *
 * Skript prehrá štyri reálne vstupy a povie, o koľko úrovní sa mapa pohla.
 * Čísla vychádzajú z toho, čo prehliadače naozaj posielajú:
 *
 *   • myš v Chrome         jedna udalosť, deltaY 100, deltaMode 0
 *   • myš vo Firefoxe      jedna udalosť, deltaY 3,   deltaMode 1
 *   • trackpad, jemne      ~12 udalostí po 8 px
 *   • trackpad, švih       ~30 udalostí po 18 px
 */
import {
  wheelZoomStep, IDLE_WHEEL, MAX_LEVELS_PER_GESTURE, GESTURE_GAP_MS,
} from '../mobile/src/components/mapZoomMath.ts';

/**
 * Prehrá postupnosť udalostí a vráti, o koľko úrovní sa celkovo pohlo.
 *
 * Čas je súčasť vstupu, nie detail: to, či dve udalosti patria do jedného
 * gesta, rozhoduje o strope. Preto ho skript zadáva sám a nespolieha sa na
 * to, ako rýchlo beží.
 */
function replay(events, gapMs = 16) {
  let state = IDLE_WHEEL;
  let levels = 0;
  let clock = 1000;
  for (const [deltaY, deltaMode, jump] of events) {
    clock += jump ?? gapMs;
    const step = wheelZoomStep(deltaY, deltaMode, state, clock);
    state = step.state;
    levels += step.levels;
  }
  return levels;
}

const repeat = (count, deltaY, deltaMode = 0) =>
  Array.from({ length: count }, () => [deltaY, deltaMode]);

/** Zárezy myšou, tak ako ich robí ruka — s pauzou medzi nimi. */
const notches = (count, deltaY) =>
  Array.from({ length: count }, () => [deltaY, 0, GESTURE_GAP_MS + 20]);

const cases = [
  {
    name: 'myš v Chrome, jeden zárez nadol (oddialiť)',
    events: [[100, 0]],
    want: -1,
  },
  {
    name: 'myš v Chrome, jeden zárez nahor (priblížiť)',
    events: [[-100, 0]],
    want: 1,
  },
  {
    name: 'myš vo Firefoxe, jeden zárez nadol',
    events: [[3, 1]],
    want: -1,
  },
  {
    name: 'trackpad, jemné potiahnutie nadol (12 × 8 px)',
    events: repeat(12, 8),
    want: -1,
  },
  {
    name: 'trackpad, švih nadol (30 × 18 px)',
    events: repeat(30, 18),
    want: -5,
  },
  {
    name: 'tri zárezy myšou nadol za sebou',
    events: notches(3, 100),
    want: -3,
  },
  {
    name: 'desať zárezov myšou — mapa neuletí',
    events: notches(10, 100),
    want: -10,
  },
  {
    name: 'zotrvačné rolovanie na Macu (80 × 40 px)',
    events: repeat(80, 40),
    want: -MAX_LEVELS_PER_GESTURE,
  },
  {
    name: 'nepatrné chvenie prsta (4 × 3 px) nehýbe ničím',
    events: repeat(4, 3),
    want: 0,
  },
];

let failed = 0;
for (const testCase of cases) {
  const got = replay(testCase.events);
  const ok = got === testCase.want;
  if (!ok) failed += 1;
  console.log(
    `${ok ? '  OK ' : 'ZLE '} ${testCase.name.padEnd(48)} ` +
    `${String(got).padStart(3)} úrovní${ok ? '' : ` (čakalo sa ${testCase.want})`}`,
  );
}

// Priblíženie a oddialenie musia byť rovnako silné. Sťažnosť znela na
// oddaľovanie, takže symetria je to, na čo sa treba pýtať priamo.
const out = replay(repeat(30, 18));
const back = replay(repeat(30, -18));
if (out !== -back) {
  failed += 1;
  console.log(`ZLE  oddialenie ${out} a priblíženie ${back} nie sú rovnako silné`);
} else {
  console.log(`  OK  oddialenie a priblíženie sú rovnako silné       ${back} úrovní`);
}

if (failed > 0) {
  console.error(`\n${failed} zlyhaní.`);
  process.exit(1);
}
console.log('\nVšetko sedí.');
