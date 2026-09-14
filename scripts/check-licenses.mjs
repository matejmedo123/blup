#!/usr/bin/env node
/**
 * Dependency licence audit.
 *
 *   node scripts/check-licenses.mjs            # mobile/ (the shipped app)
 *   node scripts/check-licenses.mjs --all      # every workspace with a lockfile
 *   node scripts/check-licenses.mjs --list     # print every package, grouped
 *
 * Why this exists
 * ---------------
 * BLUP is distributed two ways at once: as a web page anyone can load, and as
 * an app in two stores. That makes three licence families behave differently:
 *
 *   * AGPL activates on *providing software over a network*. One AGPL package
 *     anywhere in the runtime tree obliges us to publish the whole service's
 *     source. This script FAILS on it.
 *   * GPL/LGPL activate on distribution — which an App Store build is. Also a
 *     failure, with the LGPL dynamic-linking argument being something nobody
 *     wants to be making to a reviewer.
 *   * MPL-2.0 is file-level copyleft: keeping the modified files open is enough,
 *     so it is allowed but reported, because it is a condition somebody has to
 *     actually know about.
 *
 * Dev-only tooling is not distributed, so a copyleft build tool is not the same
 * finding as a copyleft runtime library. The two are separated below.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const PERMISSIVE = new Set([
  'MIT', 'MIT-0', 'ISC', 'BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'BSD-3-Clause-Clear',
  '0BSD', 'Apache-2.0', 'Unlicense', 'CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0',
  'Python-2.0', 'BlueOak-1.0.0', 'WTFPL', 'Zlib', 'Artistic-2.0', 'UPL-1.0',
  'OFL-1.1', 'SEE LICENSE IN LICENSE',
]);
// File-level copyleft: usable in a proprietary product, but a real condition.
const WEAK_COPYLEFT = /^(MPL-2\.0|EPL-|CDDL|CPL-)/i;
// Distribution-triggered copyleft.
const STRONG_COPYLEFT = /(^|[^A-Za-z])(GPL-[23]|LGPL|GPL)([^A-Za-z]|$)/i;
// Network-triggered copyleft — the one that can make the project unsellable.
const NETWORK_COPYLEFT = /AGPL/i;

/** Reduces an SPDX expression to the set of identifiers it mentions. */
function idsOf(spdx) {
  return String(spdx)
    .replace(/[()]/g, ' ')
    .split(/\s+(?:OR|AND)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function licenceOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license === 'object' && pkg.license.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map((l) => (typeof l === 'string' ? l : l.type)).filter(Boolean).join(' OR ');
  }
  return null;
}

/** Every installed package, following nested node_modules all the way down. */
function* packages(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name === '.bin' || entry.name === '.cache') continue;

    const full = join(dir, entry.name);
    // Scopes (@expo, @babel, …) hold packages one level further down.
    if (entry.name.startsWith('@')) { yield* packages(full); continue; }

    const manifest = join(full, 'package.json');
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        if (pkg.name) yield { dir: full, pkg };
      } catch { /* a package.json we cannot parse tells us nothing */ }
    }

    const nested = join(full, 'node_modules');
    if (existsSync(nested)) yield* packages(nested);
  }
}

/** Names reachable from the manifest's runtime deps, transitively. */
function runtimeClosure(workspace, seen = new Set()) {
  const manifest = join(workspace, 'package.json');
  if (!existsSync(manifest)) return seen;
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));

  const walk = (names) => {
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      const dep = join(workspace, 'node_modules', name, 'package.json');
      if (!existsSync(dep)) continue;
      try {
        const sub = JSON.parse(readFileSync(dep, 'utf8'));
        walk(Object.keys(sub.dependencies ?? {}));
        // peerDependencies that are not optional end up in the bundle too.
        const optional = sub.peerDependenciesMeta ?? {};
        walk(Object.keys(sub.peerDependencies ?? {}).filter((n) => !optional[n]?.optional));
      } catch { /* ignore */ }
    }
  };

  walk(Object.keys(pkg.dependencies ?? {}));
  return seen;
}

const workspaces = process.argv.includes('--all')
  ? [join(ROOT, 'mobile'), ROOT]
  : [join(ROOT, 'mobile')];

const findings = { network: [], strong: [], weak: [], unknown: [] };
const counts = new Map();
let total = 0;

for (const workspace of workspaces) {
  const modules = join(workspace, 'node_modules');
  if (!existsSync(modules)) {
    // The repo root carries only the seed script's dev dependencies and is
    // often not installed. Nothing there reaches a user, so a missing install
    // is a gap in coverage to mention, not a failure.
    if (workspace === ROOT) {
      console.log(`(preskočené: ${workspace}/node_modules nie je nainštalované)\n`);
      continue;
    }
    console.error(`✖ ${workspace}/node_modules neexistuje — spusti npm install`);
    process.exit(1);
  }

  const runtime = runtimeClosure(workspace);
  const seen = new Set();

  for (const { pkg } of packages(modules)) {
    const key = `${pkg.name}@${pkg.version ?? '?'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total += 1;

    const raw = licenceOf(pkg);
    const label = raw ?? '(neuvedená)';
    counts.set(label, (counts.get(label) ?? 0) + 1);

    const entry = {
      name: key,
      licence: label,
      // Whether this package can end up in something a user receives.
      shipped: runtime.has(pkg.name),
    };

    if (!raw) { findings.unknown.push(entry); continue; }

    const ids = idsOf(raw);
    // A dual licence with any permissive option is fine: we take that option.
    const hasPermissiveOption = /\sOR\s/i.test(raw) && ids.some((id) => PERMISSIVE.has(id));
    if (hasPermissiveOption) continue;

    if (NETWORK_COPYLEFT.test(raw)) findings.network.push(entry);
    else if (STRONG_COPYLEFT.test(raw)) findings.strong.push(entry);
    else if (WEAK_COPYLEFT.test(raw)) findings.weak.push(entry);
    else if (!ids.every((id) => PERMISSIVE.has(id))) findings.unknown.push(entry);
  }
}

const show = (list) => list
  .sort((a, b) => Number(b.shipped) - Number(a.shipped) || a.name.localeCompare(b.name))
  .map((e) => `    ${e.shipped ? '▲' : ' '} ${e.name}  —  ${e.licence}`)
  .join('\n');

console.log(`Preskúmaných balíkov: ${total}`);
console.log('▲ = dostane sa k používateľovi (runtime), bez značky = iba nástroj pri builde\n');

if (process.argv.includes('--list')) {
  for (const [licence, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${licence}`);
  }
  console.log('');
}

let failed = false;

if (findings.network.length) {
  failed = true;
  console.error('✖ AGPL — sieťový copyleft. Aktivuje sa tým, že softvér poskytuješ cez sieť:');
  console.error(show(findings.network) + '\n');
}

const shippedStrong = findings.strong.filter((e) => e.shipped);
if (shippedStrong.length) {
  failed = true;
  console.error('✖ GPL/LGPL v runtime — aktivuje sa distribúciou, a build v App Store ňou je:');
  console.error(show(shippedStrong) + '\n');
}

const toolStrong = findings.strong.filter((e) => !e.shipped);
if (toolStrong.length) {
  console.log('⚠ GPL/LGPL iba v nástrojoch pri builde — nedistribuuje sa, takže to nie je chyba:');
  console.log(show(toolStrong) + '\n');
}

if (findings.weak.length) {
  console.log('⚠ Súborový copyleft (MPL/EPL/CDDL) — použiteľné, ale ak súbor upravíš, musí zostať otvorený:');
  console.log(show(findings.weak) + '\n');
}

if (findings.unknown.length) {
  console.log('⚠ Neuvedená alebo neznáma licencia — pozri ručne:');
  console.log(show(findings.unknown) + '\n');
}

if (failed) {
  console.error('✖ Audit licencií zlyhal.');
  process.exit(1);
}

console.log('✓ Žiadna AGPL a žiadna GPL v tom, čo sa distribuuje.');
