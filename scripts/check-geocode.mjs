#!/usr/bin/env node
/**
 * How long the address box takes to answer.
 *
 *   node scripts/check-geocode.mjs
 *
 * Needs the network, so it is not part of the offline suite — it is here
 * because "the address search is slow" is a complaint with a number behind it,
 * and the number should be checkable rather than argued about.
 *
 * What it measures: the suggestion path (Photon), the resolve path (Nominatim),
 * and that the cache answers without a request at all.
 */
import { cachedSuggestions, geocodeAddress, suggestAddresses } from '../mobile/src/maps/geocode.ts';

const NEAR = { latitude: 48.3069, longitude: 18.0864 };   // Nitra
const QUERIES = ['mostna nit', 'hlavna bratislava', 'stefanikova trnava', 'nam slobody'];

let failed = 0;
const ok = (label, condition, detail = '') => {
  console.log(`${condition ? '✓' : '✗'} ${label}${detail ? `  —  ${detail}` : ''}`);
  if (!condition) failed++;
};

const times = [];
for (const query of QUERIES) {
  const started = Date.now();
  let hits = [];
  try {
    hits = await suggestAddresses(query, { near: NEAR });
  } catch (error) {
    ok(`„${query}"`, false, String(error).slice(0, 80));
    continue;
  }
  const took = Date.now() - started;
  times.push(took);
  ok(`„${query}"`, hits.length > 0, `${took} ms · ${hits.length} návrhov · ${hits[0]?.label ?? '—'}`);
}

const worst = Math.max(...times);
ok('žiadny dotaz netrvá viac než 2 s', worst < 2000, `najpomalší ${worst} ms`);

// The second time costs nothing: no request, no waiting, no flicker.
const cachedStart = Date.now();
const again = await suggestAddresses(QUERIES[0], { near: NEAR });
const cachedTook = Date.now() - cachedStart;
ok('zopakovaný dotaz ide z pamäte', cachedTook < 20 && again.length > 0, `${cachedTook} ms`);
ok('cachedSuggestions vráti to isté bez siete',
  (cachedSuggestions(QUERIES[0], NEAR)?.length ?? 0) === again.length);

// Two characters are not a question worth asking anybody.
ok('dva znaky sa nehľadajú', (await suggestAddresses('ni', { near: NEAR })).length === 0);

// The resolve path still works — it is what the "find it" button uses.
const resolveStart = Date.now();
const hit = await geocodeAddress('Mostná 13, Nitra');
const resolveTook = Date.now() - resolveStart;
ok('presná adresa sa nájde', Boolean(hit), `${resolveTook} ms · ${hit?.label ?? '—'}`);
ok('a trafí Nitru', Boolean(hit && Math.abs(hit.latitude - 48.31) < 0.1), hit ? `${hit.latitude.toFixed(3)}, ${hit.longitude.toFixed(3)}` : '');

// BLUP listuje eventy na Slovensku. Adresa v Brne alebo vo Viedni sa v zozname
// nedá odlíšiť od domácej, kým ju človek nedočíta do konca — a potom už má
// event na mieste, kde sa nekoná.
const FOREIGN = [
  ['vaclavske namesti praha', 'Praha'],
  ['stephansplatz wien', 'Viedeň'],
  ['andrassy ut budapest', 'Budapešť'],
];

for (const [query, where] of FOREIGN) {
  const hits = await suggestAddresses(query, { near: NEAR });
  ok(
    `${where} sa neponúka`,
    hits.length === 0,
    hits.length === 0 ? 'žiadny návrh' : `vrátilo ${hits.length}: ${hits[0].label}`,
  );
}

console.log(failed === 0 ? '\nADRESY V PORIADKU' : `\nZLYHALO: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
