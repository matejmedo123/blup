#!/usr/bin/env node
/**
 * Layout smoke test: catches the two ways a react-native-web screen breaks in
 * a browser without throwing anything.
 *
 *   1. horizontal overflow — the page scrolls sideways
 *   2. squeezed text — a row child that cannot shrink gets crushed to a sliver
 *      and stacks its characters vertically, one per line
 *
 * The second is the one that hides: nothing errors, the text is all there, and
 * it only shows up on a narrow viewport. It is detected by shape rather than by
 * width — a box far taller than it is wide is holding stacked characters.
 *
 *   node scripts/serve-web.mjs mobile/dist 4401
 *   node scripts/smoke-layout.mjs [base-url]
 */
import { createRequire } from 'module';
const require = createRequire(new URL('../mobile/', import.meta.url));
const { chromium } = require('playwright');

const BASE = process.argv[2] ?? 'http://127.0.0.1:4401';
const b = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });

const PATHS = ['/', '/search', '/discover', '/feed', '/community', '/organizer', '/organizer/create', '/cart', '/settings', '/badges', '/premium', '/organizer/profile', '/org/abc', '/connect/abc', '/legal/terms', '/legal/privacy', '/event/seats/abc', '/organizer/plan/abc', '/organizer/seating/abc', '/invite', '/settings/emails', '/organizer/announce/abc', '/pozvanka/ABC123'];
for (const [label, vp] of [['telefon',{width:390,height:844}], ['desktop',{width:1280,height:900}]]) {
  const ctx = await b.newContext({ viewport: vp });
  const p = await ctx.newPage();
  console.log(`\n--- ${label} (${vp.width}px) ---`);
  for (const path of PATHS) {
    await p.goto(BASE+path, { waitUntil:'networkidle' });
    await p.waitForTimeout(1200);
    const r = await p.evaluate(() => {
      const doc = document.documentElement;
      // elements whose text box is narrower than ~3 characters but hold real text
      const squeezed = [...document.querySelectorAll('*')].filter(el => {
        const t = (el.textContent||'').trim();
        if (t.length < 8 || el.children.length) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        // Text squeezed into a sliver stacks its characters: the box ends up
        // far taller than it is wide. That ratio is the tell, not raw width —
        // a 52px-wide box holding 180px of stacked text is just as broken as
        // a 12px one.
        return r.height > r.width * 2.5 && r.height > 60;
      }).map(el => (el.textContent||'').trim().slice(0,24));
      return {
        hOverflow: doc.scrollWidth - doc.clientWidth,
        squeezed: squeezed.slice(0,3),
        squeezedCount: squeezed.length,
      };
    });
    const flag = (r.hOverflow > 2 || r.squeezedCount > 0) ? '✗' : '✓';
    console.log(`${flag} ${path.padEnd(20)} pretecenie: ${String(r.hOverflow).padStart(4)}px  stlacenych: ${r.squeezedCount}${r.squeezed.length? '  '+JSON.stringify(r.squeezed):''}`);
  }
  await ctx.close();
}
await b.close();
