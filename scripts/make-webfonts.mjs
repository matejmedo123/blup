#!/usr/bin/env node
/**
 * Vyrobí webové verzie písiem do mobile/public/fonts/.
 *
 *   pip install fonttools brotli
 *   node scripts/make-webfonts.mjs
 *
 * Prečo: appka používa sedem rezov Nunita a JetBrains Mono a `useFonts` ich
 * na webe sťahuje ako .ttf — po 129 kB každý, teda skoro 900 kB, a prvé
 * písmeno sa dovtedy neukáže. TTF je nekomprimovaný formát pre operačný
 * systém; prehliadač chce woff2, ktorý má brotli v sebe.
 *
 * Navyše sa orežú znaky. Nunito má celú škálu vrátane cyriliky a vietnamčiny;
 * slovenčine stačí latin + latin-ext. Spolu je to ~130 kB namiesto 900 kB.
 *
 * Výstupy sú v gite, takže bežný build fonttools nepotrebuje. Tento skript
 * treba spustiť len pri zmene rezov.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'mobile/public/fonts');

// latin + latin-ext, presne ako ich delí Google Fonts. Slovenské ľ, ť, ď, ň,
// ô, č, š, ž sedia v latin-ext — bez neho by sa uprostred slova prepadli do
// systémového písma.
const UNICODES = [
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC',
  'U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193',
  'U+2212,U+2215,U+FEFF,U+FFFD',
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF',
  'U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0',
  'U+2113,U+2C60-2C7F,U+A720-A7FF',
].join(',');

const FACES = [
  ['@expo-google-fonts/nunito/400Regular/Nunito_400Regular.ttf', 'Nunito_400Regular'],
  ['@expo-google-fonts/nunito/600SemiBold/Nunito_600SemiBold.ttf', 'Nunito_600SemiBold'],
  ['@expo-google-fonts/nunito/700Bold/Nunito_700Bold.ttf', 'Nunito_700Bold'],
  ['@expo-google-fonts/nunito/800ExtraBold/Nunito_800ExtraBold.ttf', 'Nunito_800ExtraBold'],
  ['@expo-google-fonts/nunito/900Black/Nunito_900Black.ttf', 'Nunito_900Black'],
  ['@expo-google-fonts/jetbrains-mono/400Regular/JetBrainsMono_400Regular.ttf', 'JetBrainsMono_400Regular'],
  ['@expo-google-fonts/jetbrains-mono/600SemiBold/JetBrainsMono_600SemiBold.ttf', 'JetBrainsMono_600SemiBold'],
];

mkdirSync(out, { recursive: true });

let before = 0;
let after = 0;

for (const [relative, name] of FACES) {
  const source = join(root, 'mobile/node_modules', relative);
  if (!existsSync(source)) {
    console.error(`Chýba ${source} — spusti najprv npm install v mobile/.`);
    process.exit(1);
  }

  const target = join(out, `${name}.woff2`);
  execFileSync('pyftsubset', [
    source,
    `--output-file=${target}`,
    '--flavor=woff2',
    `--unicodes=${UNICODES}`,
    // Bez layout funkcií, ktoré web nepoužíva, ale ktoré nesú kilobajty.
    '--layout-features=kern,liga,calt',
    '--no-hinting',
    '--desubroutinize',
  ], { stdio: 'inherit' });

  before += statSync(source).size;
  after += statSync(target).size;
  console.log(`${name.padEnd(26)} ${String(Math.round(statSync(source).size / 1024)).padStart(4)} kB → ${String(Math.round(statSync(target).size / 1024)).padStart(3)} kB`);
}

console.log(
  `\n${Math.round(before / 1024)} kB TTF → ${Math.round(after / 1024)} kB woff2 ` +
  `(${Math.round((1 - after / before) * 100)} % menej)`,
);
