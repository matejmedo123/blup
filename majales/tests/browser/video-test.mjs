import { chromium } from 'playwright';
const B='http://127.0.0.1:8099';
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const must=(c,m)=>{if(!c)throw new Error('ZLYHALO: '+m); console.log('  ✓ '+m);};

console.log('• desktop — video sa má načítať');
let p=await b.newPage({viewport:{width:1400,height:900}});
const reqD=[]; p.on('request',r=>{if(r.url().includes('.mp4'))reqD.push(r.url());});
await p.goto(B+'/index.php',{waitUntil:'networkidle'});
must(reqD.length>0,'video sa na desktope vyžiada');
must(await p.locator('#hero-video').count()===1,'prvok videa ostal v stránke');
await p.close();

console.log('• mobil — video sa načítať nemá');
p=await b.newPage({viewport:{width:390,height:800}});
const reqM=[]; p.on('request',r=>{if(r.url().includes('.mp4'))reqM.push(r.url());});
await p.goto(B+'/index.php',{waitUntil:'networkidle'});
await p.waitForTimeout(800);
must(reqM.length===0,'video sa na telefóne vôbec nesťahuje (ušetrených ~17 MB)');
must(await p.locator('#hero-video').count()===0,'prvok videa sa odstránil');
must(await p.locator('.hero').isVisible(),'hlavička aj tak vyzerá správne');
await p.close();

console.log('• šetrenie animácií — video sa nespustí');
p=await b.newPage({viewport:{width:1400,height:900}, reducedMotion:'reduce'});
const reqR=[]; p.on('request',r=>{if(r.url().includes('.mp4'))reqR.push(r.url());});
await p.goto(B+'/index.php',{waitUntil:'networkidle'});
await p.waitForTimeout(600);
must(reqR.length===0,'pri vypnutých animáciách sa video nesťahuje');
await p.close();

await b.close(); console.log('\nVIDEO OK');
