#!/usr/bin/env node
/**
 * Vodorovný pás, ktorý žerie zvislé miesto.
 *
 * `<ScrollView horizontal>` vnorený do zvislého si bez `flexGrow: 0` vypýta
 * všetko zvislé miesto, ktoré je k dispozícii. Z prepínača vysokého 34 px
 * vyjde pás cez pol obrazovky, medzi nadpisom a obsahom zostane diera a celé
 * rozhranie pôsobí rozsekane a poskakuje podľa toho, koľko obsahu je pod ním.
 *
 * Nevidno to v typoch, nevidno to v builde a na telefóne to často ujde, lebo
 * tam je obsahu dosť na to, aby pás stlačil. Preto táto kontrola.
 *
 *   node scripts/check-rails.mjs
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const roots = [join(ROOT, 'mobile/app'), join(ROOT, 'mobile/src')];
const findings = [];

function scan(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!/<ScrollView\b/.test(lines[i])) continue;
    // Prečítaj celý otvárací tag.
    let tag = '';
    for (let j = i; j < Math.min(i + 24, lines.length); j += 1) {
      tag += lines[j] + '\n';
      if (lines[j].includes('>')) break;
    }
    if (!/\bhorizontal\b/.test(tag)) continue;
    // Má vlastný `style`? Ak nie, nič mu zvislý rast nezastaví.
    if (!/\bstyle=\{/.test(tag)) {
      findings.push({ file: file.replace(ROOT + '/', ''), line: i + 1 });
    }
  }
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) continue;
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(tsx|jsx)$/.test(name)) scan(full);
  }
}
for (const dir of roots) walk(dir);

if (!findings.length) {
  console.log('✓ Každý vodorovný pás má vlastný štýl — žiadny nežerie zvislé miesto.');
  process.exit(0);
}
for (const f of findings) {
  console.log(`✗ ${f.file}:${f.line} — <ScrollView horizontal> bez vlastného style`);
}
console.log(`\n${findings.length} nálezov — pridaj style={{ flexGrow: 0 }}`);
process.exit(1);
