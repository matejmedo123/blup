/**
 * Every screen has a title in the header, and it is set on the right layout.
 *
 * Expo Router gives a screen to the nearest Stack above it. A <Stack.Screen>
 * registered on any other layout is not an error and not a warning — it is
 * simply ignored, and the header falls back to the route name. That is how
 * `plan/[id]` came to be written across the top of the seating editor: the
 * title was set, on the root layout, for a screen that lives under
 * organizer/_layout.tsx and never reaches it.
 *
 * Six more screens had the same thing, including the one people use most —
 * "create", which said `create`. None of it shows up in a type check, a lint
 * pass or a browser smoke test, because every one of those pages renders
 * perfectly well with the wrong words in the header.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'mobile', 'app');

let missing = 0;
let checked = 0;

/** Route name as Expo Router sees it: path from the layout, without .tsx. */
function routeNames(dir) {
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);

      if (statSync(full).isDirectory()) {
        // A directory with its own _layout owns its screens; this one only
        // registers the group.
        if (readdirSync(full).includes('_layout.tsx')) continue;
        walk(full, prefix ? `${prefix}/${entry}` : entry);
        continue;
      }

      if (!entry.endsWith('.tsx')) continue;
      if (entry === '_layout.tsx' || entry.startsWith('+')) continue;

      // foo.web.tsx and foo.tsx are one screen.
      const base = entry.replace(/\.web\.tsx$/, '').replace(/\.tsx$/, '');
      const name = prefix ? `${prefix}/${base}` : base;
      if (!out.includes(name)) out.push(name);
    }
  };
  walk(dir, '');
  return out;
}

/** Every directory that has a Stack of its own. */
function layouts(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    if (entry === 'node_modules') continue;
    if (readdirSync(full).includes('_layout.tsx')) found.push(full);
    layouts(full, found);
  }
  return found;
}

const roots = [APP, ...layouts(APP)];

for (const dir of roots) {
  const layoutPath = join(dir, '_layout.tsx');
  let layout;
  try {
    layout = readFileSync(layoutPath, 'utf8');
  } catch {
    continue;
  }
  // Only a Stack gives a header with a title in it. Tabs and plain wrappers
  // do not, so they are not held to this.
  if (!/<Stack\b/.test(layout)) continue;

  for (const name of routeNames(dir)) {
    checked += 1;
    if (layout.includes(`name="${name}"`)) continue;

    missing += 1;
    console.log(`✗ ${relative(APP, join(dir, name))} — bez titulku v ${relative(APP, layoutPath)}`);
  }
}

console.log();
if (missing > 0) {
  console.log(`${missing} obrazoviek ukáže v hlavičke názov cesty namiesto názvu.`);
  console.log('Zaregistruj ich v TOM layoute, ktorý je nad nimi — inde sa titulok ignoruje.');
  process.exit(1);
}
console.log(`✓ Všetkých ${checked} obrazoviek má titulok na správnom layoute.`);
