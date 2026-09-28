#!/usr/bin/env node
/**
 * Či má každá tvár v appke krúžok príbehu — alebo napísaný dôvod, prečo nie.
 *
 *   node scripts/check-avatars.mjs
 *
 * Krúžok okolo profilovky nemá zmysel len nad feedom. Keď niekto niečo pridal,
 * má to byť vidieť všade, kde je jeho tvár — v komunite, pod eventom, medzi
 * tými, čo idú — a má sa to dať odtiaľ rovno pozrieť. O to sa stará `Avatar`
 * sám, ale len keď dostane `userId`. Bez neho nakreslí obyčajnú tvár a nikde
 * to nezasvieti; nič nespadne, nič sa nevypíše, len jedna obrazovka ticho
 * nevie o príbehoch.
 *
 * Presne to sa aj stalo: `userId` malo deväť miest z dvadsiatich piatich.
 * Preto sa to tu počíta.
 *
 * Nie každá tvár krúžok chce — logo organizácie príbehy nemá, avatar
 * v nastaveniach je tlačidlo na zmenu fotky a v preložených tvárach pod kartou
 * eventu by sa krúžky prekrývali. Také miesto musí mať NAPÍSANÉ prečo,
 * komentárom `bez krúžku:` tesne nad sebou. Dôvod v komentári je lacný; dôvod,
 * ktorý si nikto nezapísal, sa o pol roka nedá odlíšiť od zabudnutia.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['mobile/app', 'mobile/src'];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (path.endsWith('.tsx')) out.push(path);
  }
  return out;
}

/** Koniec značky `<Avatar …>`, s ohľadom na zátvorky vo vnútri atribútov. */
function tagEnd(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '>' && depth === 0) return i;
  }
  return text.length - 1;
}

let ringed = 0;
let excused = 0;
const missing = [];

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');

    for (const match of text.matchAll(/<Avatar\b/g)) {
      const tag = text.slice(match.index, tagEnd(text, match.index) + 1);
      const line = text.slice(0, match.index).split('\n').length;

      if (tag.includes('userId')) { ringed += 1; continue; }

      // Dôvod sa hľadá v troch riadkoch nad značkou — toľko zaberie
      // dvojriadkový komentár aj s otváracou zátvorkou ternárneho výrazu.
      const above = lines.slice(Math.max(0, line - 4), line - 1).join(' ');
      if (above.includes('bez krúžku')) { excused += 1; continue; }

      missing.push(`${file}:${line}  ${tag.split('\n').map((s) => s.trim()).join(' ').slice(0, 90)}`);
    }
  }
}

console.log(`  ${ringed} tvárí s krúžkom príbehu`);
console.log(`  ${excused} s napísaným dôvodom, prečo ho nemajú`);

if (missing.length > 0) {
  console.error('\nTieto tváre nemajú ani krúžok, ani dôvod:\n');
  for (const line of missing) console.error(`  ${line}`);
  console.error(
    '\nPridaj `userId={…}`, aby sa príbeh dal otvoriť odtiaľto — alebo komentár'
    + '\n`bez krúžku: <prečo>` tesne nad značku.',
  );
  process.exit(1);
}

console.log('\nKaždá tvár v appke buď vie o príbehoch, alebo má napísané prečo nie.');
