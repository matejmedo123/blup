import { chromium } from 'playwright';
const B='http://127.0.0.1:8099';
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const must=(c,m)=>{if(!c)throw new Error('ZLYHALO: '+m); console.log('  ✓ '+m);};
const p=await b.newPage();

console.log('• správca vytvorí redaktora');
await p.goto(B+'/admin/');
await p.fill('#username','majales'); await p.fill('#password','MajalesHeslo2027');
await p.click('button[type=submit]'); await p.waitForURL('**/dashboard.php');
await p.goto(B+'/admin/pouzivatelia.php');
await p.fill('#new-username','redaktor');
await p.fill('#new-password','RedaktorHeslo123');
await p.selectOption('#new-role','editor');
await p.click('button:has-text("Vytvoriť používateľa")');
await p.waitForLoadState('networkidle');
must((await p.locator('.flash--ok').textContent()).includes('redaktor'),'redaktor je vytvorený');

console.log('• krátke heslo je odmietnuté');
await p.fill('#new-username','kratky');
await p.fill('#new-password','krátke');
await p.click('button:has-text("Vytvoriť používateľa")');
await p.waitForLoadState('networkidle');
must((await p.locator('.flash--err').textContent()).includes('10 znakov'),'heslo musí mať 10 znakov');

console.log('• posledný správca sa nedá degradovať');
const riadokSpravcu = p.locator('tbody tr', { hasText: 'majales' }).first();
await riadokSpravcu.locator('button:has-text("Na redaktora")').click();
await p.waitForLoadState('networkidle');
must((await p.locator('.flash--err').textContent()).includes('posledný správca'),'posledný správca je chránený');

console.log('• redaktor sa prihlási');
await p.goto(B+'/admin/logout.php');
await p.fill('#username','redaktor'); await p.fill('#password','RedaktorHeslo123');
await p.click('button[type=submit]'); await p.waitForURL('**/dashboard.php');
must(!(await p.content()).includes('Denník zmien'),'redaktor nevidí Denník zmien v menu');
must(!(await p.content()).includes('Používatelia'),'ani Používateľov');

console.log('• redaktor sa tam nedostane ani priamou adresou');
for (const stranka of ['pouzivatelia.php','audit.php']) {
  const r = await p.goto(B+'/admin/'+stranka);
  must(r.status()===403,'admin/'+stranka+' vráti 403 Forbidden');
}

console.log('• redaktor smie meniť obsah');
const r = await p.goto(B+'/admin/zoznam.php?typ=interpreti');
must(r.status()===200,'zoznam interpretov je pre redaktora prístupný');
must(!(await p.goto(B+'/admin/nastavenia.php')).status().toString().startsWith('4'),'nastavenia sú prístupné');
must(!(await p.content()).includes('id="f-analytics_head"'),'ale meracie kódy nevidí');

await b.close(); console.log('\nROLE OK');
