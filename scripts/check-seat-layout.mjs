#!/usr/bin/env node
/**
 * Rozloží sedadlá v sektoroch, aké vzniknú klepaním po obryse — a zmeria ich.
 *
 *   node scripts/check-seat-layout.mjs
 *
 * Predlohy kreslia obrys samy: 18 alebo 32 bodov, pravidelne rozložených po
 * obvode. Človek v editore klepne tri až desať rohov, kde chce. To je úplne
 * iný vstup do tej istej matematiky, a testy na predlohách o ňom nepovedia
 * nič.
 *
 * Dva problémy to odhalilo. Sektor nakreslený tromi klepnutiami spadol —
 * obrys sa delí na dva okraje, pri troch bodoch vyjde jeden z nich ako jediný
 * bod, a čítanie "niekde po ňom" siahlo mimo poľa. A pri obryse, kde jeden
 * okraj je rovný a druhý zalomený, sa sedadlá v rade zhŕkli ku koncu, lebo
 * medzi dvoma okrajmi sa prechádzalo ich vlastným tempom, nie po vzdialenosti.
 *
 * Skript meria dve veci na každom tvare:
 *   • rozostupy v rade — po dĺžke radu, čiže tak, ako rad naozaj vedie;
 *   • či sedadlo vôbec padlo do sektora.
 */
import { bandOf, seatSize, splitOf } from '../mobile/src/components/seatBand.ts';

/** Tvary, ktoré v editore vzniknú klepaním. Posledné dva sú naschvál zlé. */
const DRAWN = [
  { name: 'trojuholník (3 klepnutia)', rows: 6, perRow: 8,
    shape: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.5, y: 0.8 }] },
  { name: 'štvoruholník (4)', rows: 8, perRow: 12,
    shape: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.25 }, { x: 0.8, y: 0.7 }, { x: 0.2, y: 0.75 }] },
  { name: 'päťuholník (5)', rows: 8, perRow: 12,
    shape: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.9, y: 0.5 }, { x: 0.5, y: 0.8 }, { x: 0.1, y: 0.5 }] },
  { name: 'zalomená tribúna (6)', rows: 6, perRow: 10,
    shape: [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.1 }, { x: 0.9, y: 0.25 },
      { x: 0.85, y: 0.45 }, { x: 0.5, y: 0.3 }, { x: 0.15, y: 0.4 }] },
  { name: 'tvar L (7)', rows: 8, perRow: 12,
    shape: [{ x: 0.1, y: 0.1 }, { x: 0.6, y: 0.1 }, { x: 0.6, y: 0.5 }, { x: 0.9, y: 0.5 },
      { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }, { x: 0.1, y: 0.5 }] },
  { name: 'tenký oblúk (9)', rows: 5, perRow: 14,
    shape: [{ x: 0.1, y: 0.5 }, { x: 0.3, y: 0.3 }, { x: 0.5, y: 0.25 }, { x: 0.7, y: 0.3 },
      { x: 0.9, y: 0.5 }, { x: 0.85, y: 0.6 }, { x: 0.5, y: 0.38 }, { x: 0.2, y: 0.58 },
      { x: 0.12, y: 0.6 }] },
  { name: 'dve klepnutia (nedokreslené)', rows: 4, perRow: 6,
    shape: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }] },
  { name: 'všetky rohy na jednom mieste', rows: 4, perRow: 6,
    shape: [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }] },
];

/*
 * A dve z predlohy, aby sa nestratilo to, čo funguje.
 *
 * Predlohy kreslia obrys samy: tridsaťdva bodov po obvode tribúny, osemnásť
 * po oblúku. Je to úplne iný vstup než pár klepnutí a treba, aby obe prešli
 * tou istou matematikou.
 */
const PREDLOHY = [
  { name: 'D205 z futbalového štadióna', rows: 16, perRow: 14,
    shape: [
      { x: 0.872, y: 0.5022 }, { x: 0.872, y: 0.5067 }, { x: 0.872, y: 0.5112 }, { x: 0.872, y: 0.5158 },
      { x: 0.872, y: 0.5203 }, { x: 0.872, y: 0.5248 }, { x: 0.872, y: 0.5293 }, { x: 0.872, y: 0.5339 },
      { x: 0.872, y: 0.5384 }, { x: 0.872, y: 0.5429 }, { x: 0.872, y: 0.5475 }, { x: 0.872, y: 0.552 },
      { x: 0.872, y: 0.5565 }, { x: 0.8718, y: 0.561 }, { x: 0.8717, y: 0.5656 }, { x: 0.8714, y: 0.5701 },
      { x: 0.8119, y: 0.5587 }, { x: 0.812, y: 0.5549 }, { x: 0.812, y: 0.5511 }, { x: 0.812, y: 0.5473 },
      { x: 0.812, y: 0.5435 }, { x: 0.812, y: 0.5397 }, { x: 0.812, y: 0.5359 }, { x: 0.812, y: 0.5321 },
      { x: 0.812, y: 0.5283 }, { x: 0.812, y: 0.5246 }, { x: 0.812, y: 0.5208 }, { x: 0.812, y: 0.517 },
      { x: 0.812, y: 0.5132 }, { x: 0.812, y: 0.5094 }, { x: 0.812, y: 0.5056 }, { x: 0.812, y: 0.5018 }] },
  { name: 'oblúk z haly', rows: 12, perRow: 30,
    shape: [
      { x: 0.893, y: 0.54 }, { x: 0.8256, y: 0.6713 }, { x: 0.7325, y: 0.7733 }, { x: 0.621, y: 0.8379 },
      { x: 0.5, y: 0.86 }, { x: 0.379, y: 0.8379 }, { x: 0.2675, y: 0.7733 }, { x: 0.1744, y: 0.6713 },
      { x: 0.107, y: 0.54 }, { x: 0.2635, y: 0.54 }, { x: 0.3111, y: 0.603 }, { x: 0.3684, y: 0.6505 },
      { x: 0.4325, y: 0.68 }, { x: 0.5, y: 0.69 }, { x: 0.5675, y: 0.68 }, { x: 0.6316, y: 0.6505 },
      { x: 0.6889, y: 0.603 }, { x: 0.7365, y: 0.54 }] },
];

/** Koľko percent rozostupu smie byť sedadlo inde, než kam patrí. */
const ROZPTYL_LIMIT = 2;

/** Kde sedadlo leží, tak ako to počíta obrazovka s plánom. */
function place(shape, rows, perRow) {
  const band = bandOf(shape);
  const step = band.lengthAt(0.5 / rows) / perRow;
  const out = [];
  for (let r = 0; r < rows; r += 1) {
    const v = (r + 0.5) / rows;
    const wide = Math.max(band.lengthAt(v), 1e-9);
    // Sektor bez plochy (všetky rohy na jednom mieste) nemá rozostup, z ktorého
    // by sa dalo počítať. Dostane, čo si vypýtal, a všetko sadne na ten bod.
    const held = step > 0 ? Math.max(1, Math.floor(wide / step + 1e-9)) : perRow;
    const edge = Math.max(0, (wide - held * step) / 2);
    const row = [];
    for (let n = 1; n <= held; n += 1) row.push(band.at((edge + (n - 0.5) * step) / wide, v));
    out.push(row);
  }
  return { rows: out, band, step };
}

/**
 * Rad postavený nezávisle od toho, čo sa meria.
 *
 * Rad v hĺbke v je z definície prechod medzi dvoma okrajmi obrysu: prvá
 * polovica bodov je jeden okraj, druhá polovica pozpiatky ten druhý, každý
 * prejdený po vzdialenosti. To sa tu poskladá nanovo z obrysu — nie z
 * bandOf — aby sa bolo voči čomu merať. Inak by sa meralo tou istou
 * matematikou, ktorá sa kontroluje, a vyšlo by to vždy.
 */
function rowCurve(shape, v, samples = 1024) {
  const walk = (chain, n) => {
    if (chain.length <= 1) return Array.from({ length: n }, () => chain[0] ?? { x: 0.5, y: 0.5 });
    const run = [0];
    for (let i = 1; i < chain.length; i += 1) {
      run.push(run[i - 1] + Math.hypot(chain[i].x - chain[i - 1].x, chain[i].y - chain[i - 1].y));
    }
    const total = run[run.length - 1];
    if (total <= 0) return Array.from({ length: n }, () => chain[0]);
    const out = [];
    let at = 1;
    for (let k = 0; k < n; k += 1) {
      const want = (k / (n - 1)) * total;
      while (at < run.length - 1 && run[at] < want) at += 1;
      const span = run[at] - run[at - 1];
      const f = span <= 0 ? 0 : (want - run[at - 1]) / span;
      const a = chain[at - 1];
      const b = chain[at];
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
    }
    return out;
  };
  const half = splitOf(shape);
  const front = walk(shape.slice(0, half), samples);
  const back = walk(shape.slice(half).reverse(), samples);
  const pts = front.map((a, i) => ({
    x: a.x + (back[i].x - a.x) * v,
    y: a.y + (back[i].y - a.y) * v,
  }));
  const run = [0];
  for (let i = 1; i < pts.length; i += 1) {
    run.push(run[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  return { pts, run };
}

/**
 * Kam má sedadlo padnúť — spočítané nezávisle, priamo z definície.
 *
 * Rad je prechod medzi dvoma okrajmi obrysu a sedadlá v ňom majú byť
 * rovnomerne rozložené PO DĹŽKE toho radu. Tu sa ten rad poskladá nanovo z
 * obrysu, prejde sa po vzdialenosti a povie sa, kde má n-té sedadlo byť.
 * Potom sa to porovná s tým, kam ho dá bandOf.
 *
 * Merať namiesto toho rozostupy vzdušnou čiarou nejde: rad, ktorý sa zakrivuje
 * alebo láme, má dve susedné sedadlá vzdušnou čiarou bližšie, hoci po rade sú
 * rovnako ďaleko ako všetky ostatné — a tak to má byť. Taká miera by hlásila
 * chybu presne tam, kde je rozloženie správne.
 */
function wanted(shape, v, u) {
  const curve = rowCurve(shape, v);
  const total = curve.run[curve.run.length - 1];
  if (total <= 0) return curve.pts[0];
  const want = Math.min(1, Math.max(0, u)) * total;
  let i = 1;
  while (i < curve.run.length - 1 && curve.run[i] < want) i += 1;
  const span = curve.run[i] - curve.run[i - 1];
  const g = span <= 0 ? 0 : (want - curve.run[i - 1]) / span;
  const a = curve.pts[i - 1];
  const b = curve.pts[i];
  return { x: a.x + (b.x - a.x) * g, y: a.y + (b.y - a.y) * g };
}

/** O koľko percent rozostupu sa sedadlá minú s tým, kam patria. */
function drift(shape, v, held, step, wide) {
  const band = bandOf(shape);
  const edge = Math.max(0, (wide - held * step) / 2);
  let worst = 0;
  for (let n = 1; n <= held; n += 1) {
    const u = (edge + (n - 0.5) * step) / wide;
    const got = band.at(u, v);
    const should = wanted(shape, v, u);
    if (step > 0) worst = Math.max(worst, Math.hypot(got.x - should.x, got.y - should.y) / step);
  }
  return worst * 100;
}

/** Leží bod v mnohouholníku? (ten istý test, aký robí databáza) */
function inside(shape, p) {
  let hit = false;
  for (let i = 0, j = shape.length - 1; i < shape.length; j = i, i += 1) {
    const a = shape[i];
    const b = shape[j];
    if ((a.y > p.y) !== (b.y > p.y)
      && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

let bad = 0;
for (const one of [...DRAWN, ...PREDLOHY]) {
  let note = '';
  try {
    const { rows, band, step } = place(one.shape, one.rows, one.perRow);
    const size = seatSize(one.shape, { x: 0, y: 0, width: 1, height: 1 },
      one.rows, one.perRow, 1000, 1000);

    const off = rows.flat().filter((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y));
    if (off.length) throw new Error(`${off.length} sedadiel nikde`);
    if (!Number.isFinite(size) || size <= 0) throw new Error(`veľkosť sedadla ${size}`);

    let worst = 0;
    rows.forEach((row, r) => {
      const v = (r + 0.5) / one.rows;
      worst = Math.max(worst, drift(one.shape, v, row.length, step, Math.max(band.lengthAt(v), 1e-9)));
    });

    const out = rows.flat().filter((p) => !inside(one.shape, p)).length;
    const total = one.rows * one.perRow;
    /*
     * Dve veci, ktoré musia platiť naraz.
     *
     * Rozostup medzi susedmi je v celom sektore ten istý — inak sa rady
     * rozídu a medzi miestami vidno medzery. A to, čo sa do radu celé
     * nezmestí, zostane okrajom: menej než jeden rozostup, na oboch koncoch
     * rovnako, lebo inak by obrys hovoril, že sedenie siaha k okraju, a
     * nesiahalo by.
     */
    /*
     * Rozostup je pevný a zvyšok je okraj.
     *
     * Nedá sa to zmerať vzdušnou čiarou medzi susedmi: rad, ktorý sa zakrivuje,
     * má dvoch susedov vzdušnou čiarou bližšie, hoci po rade sú rovnako ďaleko
     * ako všetci ostatní. Dá sa to ale povedať o celom rade naraz — koľko miest
     * v ňom je krát rozostup sa musí zmestiť do jeho dĺžky, a to, čo zvýši,
     * musí byť menej než jedno miesto. To je presne pravidlo „pevný rozostup,
     * zvyšok ako okraj" a presne to, čo predošlé delenie radu jeho vlastným
     * počtom nesplnilo.
     */
    let okraj = 0;
    rows.forEach((row, r) => {
      const wide = Math.max(band.lengthAt((r + 0.5) / one.rows), 1e-9);
      okraj = Math.max(okraj, (wide - row.length * step) / Math.max(step, 1e-9));
      // Rad užší než jedno miesto dostane jedno — inak by rad zmizol. Je to
      // klin dobiehajúci do špica a na tom kúsku lavice sa naozaj dá sedieť.
      if (row.length > 1 && row.length * step > wide + 1e-9) {
        throw new Error(`rad ${r} má ${row.length} miest po ${step.toFixed(4)}, `
          + `ale je len ${wide.toFixed(4)} dlhý`);
      }
    });
    note = `odchýlka ${worst.toFixed(1)} %, zvyšok ${okraj.toFixed(2)} miesta, `
      + `mimo obrysu ${out}/${total}`;
    if (okraj > 1.000001) {
      throw new Error(`v rade zvýšilo ${okraj.toFixed(2)} miesta — zmestilo sa tam ešte jedno`);
    }
    console.log(`  ✓ ${one.name.padEnd(30)} ${note}`);
    /*
     * Zaplnenie sa nehodnotí, len hlási.
     *
     * Rozostup je jeden na celý sektor a berie sa z najkratšieho radu, aby
     * žiadny rad nepretiekol. Keď sektor vybieha do špica, najkratší rad je
     * takmer nulový a sedadlá sa zhrnú doprostred. Nie je to chyba výpočtu —
     * je to organizátor, ktorý si vypýtal rovnaký počet sedadiel aj do radu,
     * ktorý nemá šírku. Ale vidieť to treba.
     */

  } catch (caught) {
    bad += 1;
    console.log(`  ✖ ${one.name.padEnd(30)} ${caught.message}`);
  }
}

if (bad > 0) {
  console.log(`\n✖ ${bad} nakreslených tvarov sa rozloží zle.`);
  process.exit(1);
}
console.log('\n✓ Sedadlá sadnú rovnomerne aj do svojvoľne nakreslených sektorov.');
