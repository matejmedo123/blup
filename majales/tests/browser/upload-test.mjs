import { chromium } from 'playwright';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Najmenší platný JPEG (1×1 px) — na overenie cesty nahrávania stačí.
const JPEG_1PX = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
const dir = mkdtempSync(join(tmpdir(), 'majfoto-'));
const fotky = [1, 2, 3].map(function (i) {
  const cesta = join(dir, 'foto-' + i + '.jpg');
  writeFileSync(cesta, JPEG_1PX);
  return cesta;
});
const B='http://127.0.0.1:8099';
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const p=await b.newPage({viewport:{width:1400,height:1000}});
const errs=[]; p.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
const must=(c,m)=>{if(!c)throw new Error('ZLYHALO: '+m); console.log('  ✓ '+m);};

await p.goto(B+'/admin/');
await p.fill('#username','majales'); await p.fill('#password','MajalesHeslo2027');
await p.click('button[type=submit]'); await p.waitForURL('**/dashboard.php');

console.log('• nahrávanie fotiek');
await p.goto(B+'/admin/media.php');
await p.setInputFiles('#photos', fotky);
await p.click('button:has-text("Nahrať")');
await p.waitForLoadState('networkidle');
must((await p.locator('.flash--ok').textContent()).includes('3'), 'nahrali sa 3 fotky naraz');
must(await p.locator('table tbody tr').count() >= 3, 'sú v knižnici');
const rozmer = await p.locator('tbody tr').first().locator('td').nth(3).textContent();
must(/\d+×\d+ px/.test(rozmer), 'rozmer sa uložil: ' + rozmer.trim().split('\n')[0]);

console.log('• odmietnutie súboru, ktorý nie je obrázok');
await p.setInputFiles('#photos', { name:'zlomyselny.php', mimeType:'application/x-php', buffer: Buffer.from('<?php echo "hack"; ?>') });
await p.click('button:has-text("Nahrať")');
await p.waitForLoadState('networkidle');
must(await p.locator('.flash--err').isVisible(), 'PHP súbor je odmietnutý');
must((await p.locator('.flash--err').textContent()).includes('obrázok'), 'hláška to vysvetľuje');

console.log('• priradenie fotky do galérie cez knižnicu');
await p.goto(B+'/admin/zoznam.php?typ=galeria');
await p.locator('tbody tr').first().locator('a:has-text("Upraviť")').click();
await p.waitForLoadState('networkidle');
await p.click('[data-pick]');
await p.waitForSelector('#media-picker:not([hidden])');
await p.locator('.mediacard').first().click();
must(await p.locator('#media-picker').isHidden(), 'okno sa po výbere zavrelo');
must(await p.locator('img.mediapick__preview').isVisible(), 'náhľad sa zobrazil');
await p.click('button[name=save_and_back]');
await p.waitForURL('**/zoznam.php?typ=galeria');
must(await p.locator('tbody tr').first().locator('img.thumb').isVisible(), 'fotka je v zozname');

console.log('• fotka sa zobrazí na webe');
await p.goto(B+'/index.php');
must(await p.locator('.gallery__item').count() >= 1, 'galéria zobrazuje fotky');

console.log(errs.length ? 'CHYBY:\n'+errs.join('\n') : 'žiadne chyby v konzole');
await b.close(); console.log('\nNAHRÁVANIE OK');
