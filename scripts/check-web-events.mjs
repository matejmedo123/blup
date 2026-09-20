#!/usr/bin/env node
/**
 * Hľadá DOM udalosti napísané ako props na React Native komponentoch.
 *
 *   node scripts/check-web-events.mjs
 *
 * react-native-web posiela na element len pevný zoznam handlerov. Čo v ňom
 * nie je, zahodí — bez chyby, bez varovania. Taký prop sa skontroluje
 * TypeScriptom, vykreslí sa, a nespraví nič.
 *
 * Stálo to priblíženie plánu na počítači: `onWheel` na <View> vyzeralo
 * správne v kóde aj v type-checku, a myšou sa zoomovať nedalo. Na telefóne to
 * fungovalo (tam sa zoomuje dvoma prstami), takže to nebolo ako si všimnúť.
 *
 * Riešenie je vždy rovnaké: vziať si DOM uzol cez ref a zavesiť naň
 * addEventListener. Tento skript kontroluje, že to tak aj je.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SKIP = new Set(['node_modules', '.git', 'dist', 'dist-demo', '.expo', 'android', 'ios']);

/**
 * Handlery, ktoré react-native-web NEPOSIELA ďalej.
 *
 * Zoznam toho, čo posiela, je v
 * node_modules/react-native-web/dist/modules/forwardedProps/index.js — tieto
 * tam nie sú a v praxi po nich človek siahne.
 */
const DROPPED = [
  'onWheel', 'onScroll', 'onDrag', 'onDragStart', 'onDragEnd', 'onDrop',
  'onDragOver', 'onDragEnter', 'onDragLeave', 'onPaste', 'onCopy', 'onCut',
  'onInput', 'onAnimationEnd', 'onTransitionEnd',
];

/** Komponenty, ktoré sú naozaj DOM elementy — tam sú tie props v poriadku. */
const HTML_TAG = /^[a-z]/;

const problems = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { walk(full); continue; }
    if (!/\.(tsx|jsx)$/.test(entry)) continue;

    const source = readFileSync(full, 'utf8');
    const lines = source.split('\n');

    lines.forEach((line, index) => {
      for (const handler of DROPPED) {
        // `onWheel={` ako JSX prop. Nie v komentári a nie v reťazci s DOM API.
        const match = new RegExp(`(^|\\s)${handler}\\s*=\\s*\\{`).exec(line);
        if (!match) continue;
        if (/^\s*(\*|\/\/)/.test(line)) continue;

        // Na skutočnom HTML elemente (<div onWheel=…>) je to správne a bežné —
        // web-only súbory si otvárajú DOM priamo. Otvárací tag sa hľadá
        // dozadu po riadkoch; nedá sa naň ísť regexom cez celý blok, lebo
        // props medzi tým obsahujú `=>` a znak `>` by hľadanie ukončil.
        let tag = '?';
        for (let back = index; back >= Math.max(0, index - 30); back--) {
          const found = /<([A-Za-z][\w.]*)/.exec(lines[back]);
          if (found) { tag = found[1]; break; }
        }
        if (HTML_TAG.test(tag)) continue;

        problems.push({
          file: full.replace(`${ROOT}/`, ''),
          line: index + 1,
          handler,
          tag,
        });
      }
    });
  }
}

walk(join(ROOT, 'mobile/app'));
walk(join(ROOT, 'mobile/src'));

if (problems.length > 0) {
  console.log('');
  for (const p of problems) {
    console.log(`✗ ${p.file}:${p.line}  <${p.tag} ${p.handler}={…}>`);
  }
  console.log(
    `\n${problems.length} ${problems.length === 1 ? 'prop, ktorý' : 'propov, ktoré'} `
    + 'react-native-web zahodí — v prehliadači nespravia nič.\n'
    + 'Zaves ich cez ref a addEventListener na DOM uzol.',
  );
  process.exit(1);
}

console.log('✓ Žiadne DOM udalosti napísané ako props na RN komponentoch.');
