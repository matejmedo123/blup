#!/usr/bin/env node
/**
 * Overí DNS záznamy, na ktorých stojí doručovanie e-mailov.
 *
 *   node scripts/check-dns.mjs            # blup.sk
 *   node scripts/check-dns.mjs mojadomena.sk
 *
 * Prečo to je skript a nie odsek v dokumentácii: e-mail, ktorý sa odošle a
 * skončí v spame, vyzerá v našich logoch presne ako e-mail, ktorý dorazil.
 * Jediné miesto, kde je ten rozdiel vidieť vopred, je DNS — či doménu vieme
 * podpísať (DKIM), či smieme za ňu odosielať (SPF) a čo má prijímateľ robiť,
 * keď to nesedí (DMARC). Bez týchto troch záznamov Gmail aj Seznam hádžu poštu
 * do spamu bez ohľadu na to, čo je v nej napísané.
 *
 * Skript nič nemení. Len sa pozrie a povie, čo chýba.
 */
import { Resolver } from 'node:dns/promises';

const domain = (process.argv[2] ?? 'blup.sk').replace(/^https?:\/\//, '').replace(/\/.*$/, '');

// Verejné resolvery: lokálny resolver v kontajneri často odpovedá z cache
// alebo vôbec, a tu nás zaujíma, čo vidí svet.
const resolver = new Resolver();
resolver.setServers(['1.1.1.1', '8.8.8.8']);

let problems = 0;
let warnings = 0;

function ok(label, detail) {
  console.log(`✓ ${label}${detail ? `  ${detail}` : ''}`);
}
function bad(label, detail) {
  problems += 1;
  console.log(`✗ ${label}${detail ? `  ${detail}` : ''}`);
}
function warn(label, detail) {
  warnings += 1;
  console.log(`! ${label}${detail ? `  ${detail}` : ''}`);
}

async function txt(name) {
  try {
    const records = await resolver.resolveTxt(name);
    return records.map((chunks) => chunks.join(''));
  } catch (error) {
    if (error.code === 'ENOTFOUND' || error.code === 'ENODATA') return [];
    throw error;
  }
}

/**
 * SPF sa nekontroluje na doméne v poli From, ale na doméne v Return-Path —
 * teda tam, kam sa vracajú nedoručenky. Resend používa `send.<doména>`, a práve
 * tam patrí jeho include. Koreňová doména si ponecháva SPF svojho poštového
 * servera (websupport), a to je správne: sú to dve rôzne cesty pošty.
 *
 * Preto tu prejde ktorékoľvek z dvoch nastavení — Resend na podxdoméne alebo
 * Resend priamo v koreňovom SPF — a neprejde stav, keď nie je ani jedno.
 */
async function checkSpf() {
  const root = (await txt(domain)).filter((r) => r.toLowerCase().startsWith('v=spf1'));

  if (root.length === 0) {
    bad('SPF chýba na koreňovej doméne', `pridaj TXT na ${domain}, napr. "v=spf1 a mx ~all"`);
  } else if (root.length > 1) {
    // Dva SPF záznamy nie sú "dvakrát lepšie" — podľa RFC 7208 je to trvalá
    // chyba a prijímateľ vyhodnotí SPF ako permerror, čiže ako keby nebol.
    bad('SPF je dvakrát', 'doména smie mať práve jeden TXT so "v=spf1"; zlúč ich do jedného');
  } else {
    ok('SPF (koreň)', root[0]);
    if (/\+all/.test(root[0])) {
      bad('SPF končí na +all', 'to dovolí odosielať za tvoju doménu komukoľvek; použi ~all alebo -all');
    }
  }

  const rootIncludesSender = root.some((r) => /include:(_spf\.resend\.com|amazonses\.com)/i.test(r));

  const bounceDomain = `send.${domain}`;
  const sub = (await txt(bounceDomain)).filter((r) => r.toLowerCase().startsWith('v=spf1'));
  const subIncludesSender = sub.some((r) => /include:(amazonses\.com|_spf\.resend\.com)/i.test(r));

  if (subIncludesSender) {
    ok(`SPF (${bounceDomain})`, sub[0]);
  } else if (rootIncludesSender) {
    ok('SPF odosielateľa', 'Resend je priamo v koreňovom SPF');
  } else {
    bad(
      'SPF neobsahuje odosielateľa',
      `ani ${domain}, ani ${bounceDomain} nepúšťajú Resend — doplň TXT na ${bounceDomain}: ` +
      '"v=spf1 include:amazonses.com ~all"',
    );
  }

  // Bez MX na tejto poddoméne sa nedoručenky nemajú kam vrátiť, takže sa
  // nedozvieme o mŕtvych adresách — a práve tie kazia reputáciu domény.
  try {
    const mx = await resolver.resolveMx(bounceDomain);
    if (mx.length > 0) ok(`Nedoručenky (${bounceDomain})`, mx.map((r) => r.exchange).join(', '));
    else warn(`Nedoručenky (${bounceDomain})`, 'chýba MX — bounce reporty sa nemajú kam vrátiť');
  } catch {
    warn(`Nedoručenky (${bounceDomain})`, 'chýba MX — bounce reporty sa nemajú kam vrátiť');
  }
}

async function checkDkim() {
  // Resend podpisuje kľúčom na selektore `resend`.
  const records = await txt(`resend._domainkey.${domain}`);
  const key = records.find((r) => r.includes('p='));

  if (!key) {
    bad(
      'DKIM chýba',
      `pridaj TXT na resend._domainkey.${domain} — presnú hodnotu ti dá Resend po pridaní domény`,
    );
    return;
  }
  if (/[; ]p=(;|$)/.test(key)) {
    bad('DKIM kľúč je prázdny', 'p= bez hodnoty znamená odvolaný kľúč — vygeneruj nový');
    return;
  }
  ok('DKIM', `resend._domainkey — kľúč je nastavený (${key.length} znakov)`);
}

async function checkDmarc() {
  const records = (await txt(`_dmarc.${domain}`)).filter((r) => r.toLowerCase().startsWith('v=dmarc1'));

  if (records.length === 0) {
    bad(
      'DMARC chýba',
      `pridaj TXT na _dmarc.${domain}: "v=DMARC1; p=none; rua=mailto:dmarc@${domain}"`,
    );
    return;
  }

  const dmarc = records[0];
  ok('DMARC', dmarc);

  const policy = /p=([a-z]+)/i.exec(dmarc)?.[1]?.toLowerCase();
  if (policy === 'none') {
    // p=none je správny prvý krok, nie cieľ: zbiera reporty, ale nechráni.
    warn('DMARC je na p=none', 'nechaj tak pár týždňov, potom prejdi na p=quarantine');
  }
  if (!/rua=/i.test(dmarc)) {
    warn('DMARC nemá rua=', 'bez reportov sa nedozvieš, že ti niekto doménu zneužíva');
  }
}

async function checkMx() {
  try {
    // "Null MX" (RFC 7505) je jeden záznam s prázdnym cieľom a znamená
    // „na túto doménu sa pošta neprijíma" — nie že MX existuje.
    const mx = (await resolver.resolveMx(domain)).filter((r) => r.exchange);
    if (mx.length === 0) {
      warn('MX chýba', 'na doménu sa nedá odpísať — odpovede na tvoje e-maily sa stratia');
      return;
    }
    ok('MX', mx.map((r) => `${r.exchange} (${r.priority})`).join(', '));
  } catch {
    warn('MX chýba', 'na doménu sa nedá odpísať — odpovede na tvoje e-maily sa stratia');
  }
}

async function main() {
  console.log(`\nDNS pre ${domain}\n`);

  try {
    await checkSpf();
    await checkDkim();
    await checkDmarc();
    await checkMx();
  } catch (error) {
    console.error(`\nDNS sa nepodarilo overiť: ${error.message}`);
    process.exit(2);
  }

  console.log('');
  if (problems > 0) {
    console.log(
      `${problems} ${problems === 1 ? 'záznam chýba' : 'záznamov chýba'}. ` +
      'Kým ich nedoplníš, e-maily budú končiť v spame.',
    );
    process.exit(1);
  }
  if (warnings > 0) {
    console.log(`E-mailové DNS je v poriadku (${warnings} odporúčaní hore).`);
    process.exit(0);
  }
  console.log('E-mailové DNS je v poriadku.');
}

await main();
