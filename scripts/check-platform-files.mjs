#!/usr/bin/env node
/**
 * A platform pair must share an extension.
 *
 *   node scripts/check-platform-files.mjs
 *
 * Metro resolves platform variants extension-major: every candidate for `.ts`
 * is tried before any candidate for `.tsx`. So `foo.ts` beats `foo.web.tsx`,
 * the web build quietly gets the native file, and nothing reports it — the
 * feature is simply absent.
 *
 * It has happened twice in this project. `tags.ts` shadowed `tags.web.tsx` and
 * the cookie bar never appeared on the web for weeks; `usePullToRefresh.ts`
 * shadowed `usePullToRefresh.web.tsx` and pull-to-refresh did nothing on a
 * phone. Both looked like a working build.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not .pathname: a file URL percent-encodes what a path may
// legally contain, so a project unzipped into "blup-zdrojaky (1)" arrived
// here as "blup-zdrojaky%20(1)" — a directory that does not exist. The
// script then died on ENOENT before it checked a single thing, and the
// build stopped on its very first step.
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SKIP = new Set(['node_modules', '.git', 'dist', 'dist-demo', '.expo', 'android', 'ios']);

/** base name -> { platformExt, baseExt } as found on disk */
const seen = new Map();

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { walk(full); continue; }

    const platform = entry.match(/^(.*)\.(web|native|ios|android)\.(ts|tsx|js|jsx)$/);
    if (platform) {
      const key = join(dir, platform[1]);
      const record = seen.get(key) ?? {};
      record.variants = [...(record.variants ?? []), { file: full, ext: platform[3], platform: platform[2] }];
      seen.set(key, record);
      continue;
    }

    const plain = entry.match(/^(.*)\.(ts|tsx|js|jsx)$/);
    if (plain) {
      const key = join(dir, plain[1]);
      const record = seen.get(key) ?? {};
      // A list, not a single value: a name can legitimately have more than one
      // plain file during a rename, and keeping only the last one meant the
      // check looked at whichever `readdir` happened to return second.
      record.bases = [...(record.bases ?? []), { file: full, ext: plain[2] }];
      seen.set(key, record);
    }
  }
}

walk(join(ROOT, 'mobile', 'src'));
walk(join(ROOT, 'mobile', 'app'));

const problems = [];
for (const [, record] of seen) {
  if (!record.bases?.length || !record.variants?.length) continue;
  for (const variant of record.variants) {
    for (const base of record.bases) {
      if (variant.ext !== base.ext) {
        problems.push(
          `${relative(ROOT, variant.file)}  (.${variant.ext})\n`
          + `    tieni ho  ${relative(ROOT, base.file)}  (.${base.ext})`,
        );
      }
    }
  }
}

if (problems.length) {
  console.error('✖ Platformové dvojice s rôznou príponou — tá bez platformy vyhráva:\n');
  for (const p of problems) console.error('  ' + p + '\n');
  console.error('  Premenuj ich tak, aby mali rovnakú príponu (aj keď v jednom nie je JSX).');
  process.exit(1);
}

console.log('✓ Každá platformová dvojica má rovnakú príponu.');
