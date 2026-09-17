#!/usr/bin/env node
/**
 * The map's arithmetic, without a browser.
 *
 *   node scripts/check-maptiles.mjs
 *
 * Projection bugs do not throw — they put a town in the wrong country, and the
 * only way anybody notices is by recognising the shape of a coastline.
 */
import {
  bubbleRadius, fitPoints, latToY, lonToX, projectToViewport, tilesFor, xToLon, yToLat,
} from '../mobile/src/components/mapTiles.ts';

let failed = 0;
const ok = (label, condition, detail = '') => {
  console.log(`${condition ? '✓' : '✗'} ${label}${detail ? `  —  ${detail}` : ''}`);
  if (!condition) failed++;
};

const NITRA = { latitude: 48.3069, longitude: 18.0864 };
const BRATISLAVA = { latitude: 48.1486, longitude: 17.1077 };
const KOSICE = { latitude: 48.7164, longitude: 21.2611 };

// --- projection round-trips --------------------------------------------------
for (const z of [3, 7, 11, 16]) {
  const x = lonToX(NITRA.longitude, z);
  const y = latToY(NITRA.latitude, z);
  ok(`z=${z} späť na tie isté súradnice`,
    Math.abs(xToLon(x, z) - NITRA.longitude) < 1e-9
    && Math.abs(yToLat(y, z) - NITRA.latitude) < 1e-9);
}

// --- east is right, north is up ---------------------------------------------
const w = 800, h = 500;
const centre = BRATISLAVA;
const pNitra = projectToViewport(NITRA, centre, 8, w, h);
const pKosice = projectToViewport(KOSICE, centre, 8, w, h);
ok('Nitra je od Bratislavy napravo', pNitra.x > w / 2, `x=${pNitra.x.toFixed(0)}`);
ok('a Košice ešte viac napravo', pKosice.x > pNitra.x, `${pKosice.x.toFixed(0)} > ${pNitra.x.toFixed(0)}`);
ok('Nitra je severnejšie, teda vyššie', pNitra.y < h / 2, `y=${pNitra.y.toFixed(0)}`);

// --- fitting -----------------------------------------------------------------
const fit = fitPoints([BRATISLAVA, KOSICE], w, h);
ok('dve mestá sa zmestia na jednu obrazovku', fit.zoom >= 3 && fit.zoom <= 12, `z=${fit.zoom}`);
const a = projectToViewport(BRATISLAVA, fit.centre, fit.zoom, w, h);
const b = projectToViewport(KOSICE, fit.centre, fit.zoom, w, h);
ok('a obe sú naozaj vnútri',
  a.x > 0 && a.x < w && b.x > 0 && b.x < w && a.y > 0 && a.y < h && b.y > 0 && b.y < h,
  `${a.x.toFixed(0)},${a.y.toFixed(0)} · ${b.x.toFixed(0)},${b.y.toFixed(0)}`);

const one = fitPoints([NITRA], w, h);
ok('jedno mesto sa nepribliži donekonečna', one.zoom === 11);
const none = fitPoints([], w, h);
ok('žiadne mesto ukáže Slovensko', none.zoom === 7 && Math.abs(none.centre.latitude - 48.7) < 0.1);

// --- tiles -------------------------------------------------------------------
const tiles = tilesFor(centre, 8, w, h);
ok('dlaždice pokryjú celé okno', tiles.length > 0, `${tiles.length} dlaždíc`);
ok('žiadna dlaždica nemá zápornú súradnicu', tiles.every((t) => t.x >= 0 && t.y >= 0));
ok('a mriežka presahuje okno na oboch stranách',
  Math.min(...tiles.map((t) => t.left)) <= 0 && Math.max(...tiles.map((t) => t.left)) >= w - 256);

// --- bubbles -----------------------------------------------------------------
// The one that matters: four times the tickets is twice the radius, so the AREA
// is what grows with the value. Scaling the radius directly is how a bubble map
// turns a busy town into a visual lie.
const r1 = bubbleRadius(25, 100, 0, 40);
const r4 = bubbleRadius(100, 100, 0, 40);
ok('štvornásobok vstupeniek je dvojnásobný polomer',
  Math.abs(r4 / r1 - 2) < 0.001, `${r1.toFixed(1)} → ${r4.toFixed(1)}`);
ok('nula má stále viditeľný bod', bubbleRadius(0, 100, 6, 40) === 6);
ok('a žiadny predaj nikde nespadne', bubbleRadius(0, 0, 6, 40) === 6);

console.log(failed === 0 ? '\nMAPA V PORIADKU' : `\nZLYHALO: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
