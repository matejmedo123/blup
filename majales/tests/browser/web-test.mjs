import { chromium } from 'playwright';
const B='http://127.0.0.1:8099';
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const must=(c,m)=>{if(!c)throw new Error('ZLYHALO: '+m); console.log('  ✓ '+m);};
const errs=[];

async function novaStranka(w=1400){
  const p=await b.newPage({viewport:{width:w,height:900}});
  p.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
  p.on('console',m=>{if(m.type()==='error'&&!m.text().includes('hero-video'))errs.push('CONSOLE: '+m.text());});
  await p.goto(B+'/index.php',{waitUntil:'networkidle'});
  return p;
}

let p = await novaStranka();

console.log('• odpočet');
const d1 = await p.locator('[data-cd="secs"]').textContent();
await p.waitForTimeout(1600);
const d2 = await p.locator('[data-cd="secs"]').textContent();
must(d1 !== d2, 'sekundy bežia (' + d1 + ' → ' + d2 + ')');
must(/^\d{2}$/.test(d2), 'sekundy sú doplnené nulou');

console.log('• modál interpreta');
await p.locator('.artist').first().click();
await p.waitForSelector('#artist-modal:not([hidden])');
must((await p.locator('#artist-name').textContent()).length > 0, 'modál ukazuje meno');
must(await p.locator('body').evaluate(el=>el.classList.contains('is-locked')), 'stránka pod modálom je zamknutá');
await p.locator('.modal').click({position:{x:20,y:120}});
must(!(await p.locator('#artist-modal').isHidden()), 'klik dovnútra modál nezavrie');
await p.keyboard.press('Escape');
must(await p.locator('#artist-modal').isHidden(), 'Escape modál zavrie');
must(!(await p.locator('body').evaluate(el=>el.classList.contains('is-locked'))), 'scroll sa odomkol');

console.log('• lightbox galérie');
await p.locator('.gallery__item').first().click();
await p.waitForSelector('#lightbox:not([hidden])');
must((await p.locator('#lightbox-img').getAttribute('src')).includes('uploads/'), 'otvorila sa nahratá fotka');
await p.locator('#lightbox').click({position:{x:5,y:5}});
must(await p.locator('#lightbox').isHidden(), 'klik na pozadie zavrie lightbox');

console.log('• časté otázky');
const q = p.locator('.faq__q').first();
must(await q.getAttribute('aria-expanded') === 'false', 'odpoveď je na začiatku zbalená');
await q.click();
must(await q.getAttribute('aria-expanded') === 'true', 'po kliknutí sa rozbalí');
must(await p.locator('.faq__a').first().isVisible(), 'odpoveď je viditeľná');
must(await q.locator('.faq__mark').textContent() === '–', 'znamienko sa zmenilo na –');
await q.click();
must(await p.locator('.faq__a').first().isHidden(), 'druhý klik zbalí');

console.log('• ukazovateľ scrollu');
// Stránka scrolluje plynulo — počkáme, kým naozaj dôjde na koniec.
await p.evaluate(()=>window.scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'}));
await p.waitForTimeout(600);
const w = await p.locator('#progress').evaluate(el=>parseFloat(el.style.width));
must(w > 95, 'na konci stránky je pás takmer plný (' + w.toFixed(1) + '%)');

console.log('• odber noviniek — zlý e-mail');
await p.evaluate(()=>document.getElementById('subscribe').scrollIntoView());
await p.fill('#news-email','toto-nie-je-email');
await p.click('#subscribe button');
await p.waitForTimeout(300);
must((await p.locator('#subscribe button').textContent()).includes('ZADAJ EMAIL'), 'tlačidlo upozorní');
must(await p.locator('.confetti').count() === 0, 'konfety pri chybe nelietajú');

console.log('• odber noviniek — správny e-mail');
await p.fill('#news-email','navstevnik@example.sk');
await p.click('#subscribe button');
await p.waitForFunction(()=>document.querySelector('#subscribe button').textContent.includes('ĎAKUJEME'),null,{timeout:8000});
must(true,'tlačidlo potvrdí: ĎAKUJEME!');
must(await p.locator('.confetti').count() === 1, 'konfety sa spustili');
must((await p.locator('#subscribe-status').textContent()).length > 0, 'hláška sa zobrazila');

console.log('• opakovaný odber toho istého e-mailu');
await p.fill('#news-email','navstevnik@example.sk');
await p.click('#subscribe button');
await p.waitForTimeout(900);
must((await p.locator('#subscribe-status').textContent()).includes('už'), 'server povie, že už je prihlásený');
await p.close();

console.log('• mobilné menu (390 px)');
p = await novaStranka(390);
must(await p.locator('#menu').isHidden(), 'menu je zbalené');
must(await p.locator('.nav__links').isHidden(), 'plné menu je na mobile skryté');
await p.click('#burger');
must(await p.locator('#menu').isVisible(), 'burger menu otvorí');
must(await p.locator('#burger').getAttribute('aria-expanded') === 'true', 'aria-expanded je správne');
await p.locator('#menu a').first().click();
await p.waitForTimeout(200);
must(await p.locator('#menu').isHidden(), 'klik na odkaz menu zavrie');
await p.close();

console.log(errs.length ? '\nCHYBY:\n'+errs.join('\n') : '\nžiadne chyby v konzole');
await b.close(); console.log('\nWEB OK');
