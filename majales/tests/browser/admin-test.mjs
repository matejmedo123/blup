import { chromium } from 'playwright';
const B = 'http://127.0.0.1:8099';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 1400, height: 950 } });
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
const step = (s) => console.log('• ' + s);
const must = (cond, msg) => { if (!cond) { throw new Error('ZLYHALO: ' + msg); } console.log('  ✓ ' + msg); };

// prihlásenie zlým heslom
await p.goto(B + '/admin/');
await p.fill('#username', 'majales');
await p.fill('#password', 'zle-heslo');
await p.click('button[type=submit]');
must(await p.locator('.flash--err').isVisible(), 'zlé heslo je odmietnuté');

step('prihlásenie');
await p.fill('#username', 'majales');
await p.fill('#password', 'MajalesHeslo2027');
await p.click('button[type=submit]');
await p.waitForURL('**/dashboard.php');
must(await p.locator('.page-title').textContent() === 'Prehľad', 'prehľad sa otvoril');

step('prechádzam všetky stránky adminu');
for (const [url, title] of [
  ['dashboard.php','Prehľad'], ['obsah.php','Texty na stránke'],
  ['zoznam.php?typ=interpreti','Interpreti'], ['zoznam.php?typ=vstupenky','Vstupenky'],
  ['zoznam.php?typ=galeria','Galéria'], ['zoznam.php?typ=zony','Zóny'],
  ['zoznam.php?typ=otazky','Časté otázky'], ['zoznam.php?typ=partneri','Partneri'],
  ['media.php','Knižnica fotiek'], ['odberatelia.php','Odberatelia noviniek'],
  ['nastavenia.php','Nastavenia'], ['pouzivatelia.php','Používatelia'], ['audit.php','Denník zmien'],
]) {
  const r = await p.goto(B + '/admin/' + url);
  must(r.status() === 200 && (await p.locator('.page-title').textContent()).trim() === title, url + ' → ' + title);
}

step('úprava textu na stránke');
await p.goto(B + '/admin/obsah.php');
const novyNadpis = 'HUDBA A ZÁBAVA ' + Date.now();
await p.fill('#f-intro_heading', novyNadpis);
await p.click('button[type=submit]');
await p.waitForLoadState('networkidle');
must((await p.locator('.flash--ok').textContent()).includes('Uložené'), 'text sa uložil');
await p.goto(B + '/index.php');
must((await p.locator('#uvod-nadpis').textContent()) === novyNadpis, 'zmena je hneď na webe');

step('pridanie interpreta');
await p.goto(B + '/admin/polozka.php?typ=interpreti');
await p.fill('#f-name', 'TESTOVACÍ INTERPRET');
await p.fill('#f-tag', 'SKÚŠKA');
await p.fill('#f-bio', 'Popis pre modálne okno.');
await p.fill('#f-url_spotify', 'https://open.spotify.com/artist/test');
await p.click('button[name=save_and_back]');
await p.waitForURL('**/zoznam.php?typ=interpreti');
must((await p.content()).includes('TESTOVACÍ INTERPRET'), 'interpret je v zozname');
await p.goto(B + '/index.php');
must((await p.content()).includes('TESTOVACÍ INTERPRET'), 'interpret je na webe');

step('overenie kontroly formulára');
await p.goto(B + '/admin/polozka.php?typ=interpreti');
await p.fill('#f-url_facebook', 'javascript:alert(1)');
await p.click('button[type=submit]');
await p.waitForLoadState('networkidle');
must(await p.locator('.field__err').first().isVisible(), 'chybné pole je označené');
must((await p.locator('#f-url_facebook-err').textContent()).includes('https'), 'javascript: odkaz je odmietnutý');
must(await p.locator('#f-url_facebook').getAttribute('class') === ' is-err', 'chybné políčko má červený rám');
must((await p.content()).includes('Meno interpreta treba vyplniť'), 'povinné pole je vynútené');

step('zmena poradia a skrytie');
await p.goto(B + '/admin/zoznam.php?typ=otazky');
const before = await p.locator('tbody tr td:nth-child(1)').first().textContent();
await p.locator('tbody tr').first().locator('form button[type=submit]').nth(1).click(); // šípka dole
await p.waitForLoadState('networkidle');
const after = await p.locator('tbody tr td:nth-child(1)').first().textContent();
must(before !== after, 'poradie sa zmenilo (' + before.slice(0,25) + ' → ' + after.slice(0,25) + ')');

await p.locator('tbody tr').first().locator('button:has-text("Skryť")').click();
await p.waitForLoadState('networkidle');
must((await p.locator('tbody tr').first().locator('.tag--off').textContent()) === 'skryté', 'položka je skrytá');
await p.goto(B + '/index.php');
must(!(await p.content()).includes(after.trim()), 'skrytá otázka nie je na webe');

console.log(errs.length ? '\nCHYBY V KONZOLE:\n' + errs.join('\n') : '\nžiadne chyby v konzole');
await b.close();
console.log('\nADMIN OK');
