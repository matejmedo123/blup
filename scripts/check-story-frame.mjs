#!/usr/bin/env node
/**
 * Či má príbeh naozaj jeden rozmer — 1080 × 1920 — nech doň vojde čokoľvek.
 *
 *   node scripts/check-story-frame.mjs
 *
 * Dve tvrdenia, ktoré sa dajú overiť len počtom:
 *
 *   1. Rámček má vždy presne pomer 9:16 a vždy sa zmestí do toho, čo dostal.
 *      Na širokom monitore ho obmedzuje výška, na úzkom telefóne šírka — a
 *      keby to bolo naopak, rámček by vytŕčal z obrazovky.
 *
 *   2. Výrez z ľubovoľne tvarovanej fotky je tiež presne 9:16 a celý leží
 *      vnútri fotky. To druhé je dôležitejšie, než sa zdá: výrez, ktorý čo i
 *      len o pixel presahuje okraj, `expo-image-manipulator` odmietne a z
 *      pridávania príbehu sa stane chybová hláška.
 *
 * Fotky sú skutočné rozmery, nie vymyslené: na šírku z foťáku, štvorec z
 * Instagramu, na výšku z telefónu, panoráma a veľmi vysoký sken.
 */
import { storyFrame, STORY_ASPECT, STORY_WIDTH, STORY_HEIGHT }
  from '../mobile/src/components/storyShape.ts';
import { cropRect } from '../mobile/src/components/imageCropMath.ts';
import {
  clampSpot, overlayType, overlayWidthAt, OVERLAY_BOUNDS, OVERLAY_MAX_WIDTH,
} from '../mobile/src/components/storyOverlayMath.ts';

const near = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;

let failed = 0;
const check = (ok, line) => {
  if (!ok) failed += 1;
  console.log(`${ok ? '  OK ' : 'ZLE '} ${line}`);
};

console.log(`Príbeh je ${STORY_WIDTH} × ${STORY_HEIGHT} (${STORY_ASPECT.toFixed(4)})\n`);

// --- 1. rámček ---------------------------------------------------------------
const screens = [
  ['telefón na výšku',      390, 844],
  ['malý telefón',          320, 568],
  ['tablet na výšku',       820, 1180],
  ['notebook na šírku',    1440, 900],
  ['široký monitor',       2560, 1080],
  ['takmer štvorec',        800, 800],
  ['veľmi vysoké okno',     400, 1600],
];

for (const [name, w, h] of screens) {
  const frame = storyFrame(w, h);
  const ratio = frame.width / frame.height;
  const fits = frame.width <= w + 1e-9 && frame.height <= h + 1e-9;
  const biggest =
    near(frame.width, w) || near(frame.height, h);
  check(
    near(ratio, STORY_ASPECT, 1e-9) && fits && biggest,
    `${name.padEnd(20)} ${String(w).padStart(4)}×${String(h).padStart(4)} → `
    + `${frame.width.toFixed(0)}×${frame.height.toFixed(0)} (${ratio.toFixed(4)})`,
  );
}

// Nulové rozmery nesmú vyrobiť NaN — rámček sa meria po rozložení a prvý
// priechod ho má nulový.
const empty = storyFrame(0, 0);
check(empty.width === 0 && empty.height === 0, 'nezmeraná plocha dá nulový rámček, nie NaN');

// --- 2. výrez ----------------------------------------------------------------
console.log('');
const photos = [
  ['na šírku z foťáku',   4032, 3024],
  ['štvorec',             1080, 1080],
  ['na výšku z telefónu', 1170, 2532],
  ['panoráma',            8000, 1800],
  ['veľmi vysoký sken',    900, 4000],
  ['presne 9:16',         1080, 1920],
  ['drobná fotka',         320,  240],
];

const frame = storyFrame(390, 844);

for (const [name, iw, ih] of photos) {
  // Od najmenšieho priblíženia po slušné, a posunuté až za okraj — klampovanie
  // v cropRect je práve to, čo má zaručiť, že výrez zostane vnútri.
  for (const scale of [1, 1.4, 2.5, 5]) {
    for (const offset of [{ x: 0, y: 0 }, { x: 9999, y: 9999 }, { x: -9999, y: -9999 }]) {
      const rect = cropRect({
        imageW: iw, imageH: ih,
        frameW: frame.width, frameH: frame.height,
        scale, offset,
      });

      const inside = rect.sx >= -1e-6 && rect.sy >= -1e-6
        && rect.sx + rect.sw <= iw + 1e-6
        && rect.sy + rect.sh <= ih + 1e-6;
      const shaped = near(rect.sw / rect.sh, STORY_ASPECT, 1e-9);

      if (!inside || !shaped) {
        failed += 1;
        console.log(
          `ZLE  ${name} pri ${scale}× a posune ${offset.x}: `
          + `výrez ${rect.sx.toFixed(1)},${rect.sy.toFixed(1)} `
          + `${rect.sw.toFixed(1)}×${rect.sh.toFixed(1)} — `
          + `${inside ? '' : 'mimo fotky '}${shaped ? '' : 'zlý pomer'}`,
        );
      }
    }
  }
  console.log(`  OK  ${name.padEnd(20)} ${String(iw).padStart(4)}×${String(ih).padStart(4)} — `
    + 'každý výrez je 9:16 a leží vnútri fotky');
}

// ---------------------------------------------------------------------------
// 3. Text pristane tam, kam ho človek dal
// ---------------------------------------------------------------------------
//
// Toto je ten bug, ktorý sa nedal nájsť čítaním: editor kreslil text na 42 %
// výšky, uložil 50 % a prehrávač nakreslil 50 %. Rozdiel bolo vidieť, príčinu
// nie. Odkedy majú všetky tri obrazovky jednu matematiku, dá sa na ňu pýtať
// číslom — a to je jediný spôsob, ako tvrdenie „uvidia to tam, kde si to dal"
// overiť bez toho, aby sa na to niekto pozeral.
console.log('\nText cez príbeh');

// Poloha je ZLOMOK, takže rovnaké čísla musia dať rovnaké miesto v rámčeku
// ľubovoľnej veľkosti. Malý je editor na mobile, veľký prehrávač na desktope.
for (const [fw, fh] of [[320, 569], [405, 720], [1080, 1920]]) {
  const spot = clampSpot({ x: 0.3, y: 0.7 });
  const width = overlayWidthAt(spot.x);
  const left = fw * (spot.x - width / 2);
  const right = left + fw * width;
  check(
    left >= -0.001 && right <= fw + 0.001,
    `rámček ${fw}×${fh}: text od ${left.toFixed(1)} do ${right.toFixed(1)} `
    + `je celý vnútri (0…${fw})`,
  );
  // Stred textu je presne tam, kam ukazuje zlomok — na ňom celé „čo vidíš, to
  // dostaneš" stojí.
  check(near((left + right) / 2 / fw, spot.x, 1e-9), `rámček ${fw}×${fh}: stred sedí na x`);
}

// Písmo je tiež zlomok šírky, takže text zaberá v každom rámčeku ten istý
// podiel obrazu. Pevná veľkosť by pristála správne, ale vyzerala by inak.
{
  const small = overlayType('m', 320);
  const big = overlayType('m', 1080);
  check(
    near(big.fontSize / 1080, small.fontSize / 320, 0.002),
    `písmo rastie s rámčekom: ${small.fontSize} bodov pri 320, ${big.fontSize} pri 1080`,
  );
  check(overlayType('s', 320).fontSize < overlayType('l', 320).fontSize, 'S je menšie než L');
  check(overlayType('m', 0).fontSize >= 8, 'neodmeraný rámček nedá písmo nula');
}

// Žiadne ťahanie nesmie dostať text mimo. Vrátane nezmyslov, ktoré by mohli
// doraziť zo staršej verzie appky alebo z ručne upraveného dotazu.
for (const bad of [
  { x: -5, y: -5 }, { x: 9, y: 9 }, { x: NaN, y: 0.5 }, {}, null,
]) {
  const spot = clampSpot(bad);
  const inside = spot.x >= OVERLAY_BOUNDS.minX && spot.x <= OVERLAY_BOUNDS.maxX
    && spot.y >= OVERLAY_BOUNDS.minY && spot.y <= OVERLAY_BOUNDS.maxY;
  check(inside, `poloha ${JSON.stringify(bad)} sa zrovnala na ${spot.x}, ${spot.y}`);
}

// Na strede je text najširší; ku kraju sa zužuje, aby nepretiekol.
check(near(overlayWidthAt(0.5), OVERLAY_MAX_WIDTH), 'na strede je text najširší');
check(overlayWidthAt(0.2) < overlayWidthAt(0.5), 'pri kraji sa text zúži');

if (failed > 0) {
  console.error(`\n${failed} zlyhaní.`);
  process.exit(1);
}
console.log('\nVšetko sedí.');
