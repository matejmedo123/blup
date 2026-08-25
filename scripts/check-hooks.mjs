#!/usr/bin/env node
/**
 * Hooks after an early return.
 *
 * React counts hooks per render. A `useQuery` sitting below `if (isGuest)
 * return …` runs on some renders and not others, and the moment that flips,
 * React tears the whole tree down:
 *
 *   Minified React error #310 — Rendered more hooks than during the
 *   previous render.
 *
 * On a static web build that is a blank screen with a minified error, which is
 * the least debuggable thing this app can do to somebody. eslint-plugin-react-
 * hooks catches it, but it is not wired into this project, and a rule nobody
 * runs is not a rule.
 *
 * This is deliberately simple: inside a component (a top-level `function Name`
 * or `export default function`), find the first top-level `return` that is
 * guarded by an `if`, then flag any hook call after it at the same depth.
 *
 *   node scripts/check-hooks.mjs
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const roots = ['mobile/app', 'mobile/src'];
const HOOK = /^\s{2}(?:const|let)\s+[^=]*=\s*use[A-Z]\w*\s*\(|^\s{2}use[A-Z]\w*\s*\(/;
// A conditional return at the body's top level, on one line or opening a block.
const EARLY_RETURN = /^\s{2}if\s*\(.*\)\s*(?:return\b|\{\s*$)/;

const findings = [];

function scanFile(file) {
  const lines = readFileSync(file, 'utf8').split('\n');

  let inComponent = false;
  let guardLine = 0;
  let depth = 0;

  lines.forEach((line, index) => {
    if (/^(export default )?function [A-Z]\w*\s*\(/.test(line)) {
      inComponent = true;
      guardLine = 0;
      depth = 0;
      return;
    }
    if (!inComponent) return;

    // A closing brace in column 0 ends the component.
    if (/^\}/.test(line)) { inComponent = false; return; }

    if (EARLY_RETURN.test(line) && !guardLine) {
      // Only count it when the guard actually returns.
      const body = lines.slice(index, index + 4).join(' ');
      if (/\breturn\b/.test(body)) guardLine = index + 1;
      return;
    }

    if (guardLine && HOOK.test(line)) {
      findings.push({
        file,
        line: index + 1,
        guardLine,
        text: line.trim().slice(0, 80),
      });
    }
  });
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { walk(full); continue; }
    if (/\.tsx$/.test(full)) scanFile(full);
  }
}

for (const root of roots) walk(root);

for (const f of findings) {
  console.log(`✗ ${f.file}:${f.line} — hook za skorým returnom (riadok ${f.guardLine})`);
  console.log(`    ${f.text}`);
}

console.log(
  findings.length === 0
    ? '✓ žiadny hook za skorým returnom'
    : `\n${findings.length} nálezov — React #310 čaká práve tu`,
);
process.exit(findings.length === 0 ? 0 : 1);
