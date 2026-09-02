# ENZO — návod na nasadenie na Websupport

Kompletný web **aj s objednávkovým systémom**: zákazník objedná, príde mu e‑mail
s dokladom, ty na prevádzke odklikneš, o koľko minút to bude hotové, a jemu
okamžite odletí e‑mail s časom. Všetko sa zbiera do prehľadu pre účtovníčku.

Návod je písaný tak, aby ho zvládol človek, ktorý nikdy nič nenahrával na hosting.
Počítaj s **30 – 45 minútami** pri prvom nasadení.

---

## Čo je v balíku

```
enzo-web.zip
├── index.html, objednavka/, pokladna/, …   ← samotný web (statické stránky)
├── _next/, images/, brand/                 ← štýly, skripty, fotky, logá
├── .htaccess                               ← nastavenie servera (nemazať!)
│
├── api/            ← objednávkový systém (PHP)
│   ├── config.example.php                  ← vzor konfigurácie
│   ├── menu.php, settings.php, orders.php, order.php
│   ├── lib/, payment/, sql/                ← vnútro systému, netreba sa hrabať
│   └── .htaccess                           ← chráni konfiguráciu
│
├── admin/          ← prihlásenie pre prevádzku
│   ├── index.php (prihlásenie), dashboard.php (živý prehľad objednávok)
│   ├── menu.php, product.php (úprava menu), settings.php (nastavenia webu)
│   ├── accounting.php, export.php (podklady pre účtovníctvo)
│   └── users.php (ďalší používatelia)
│
├── storage/        ← denníky, databáza pri SQLite (zvonku neprístupné)
├── install.php     ← jednorazová inštalácia, po nej ju ZMAŽ
└── NAVOD.md        ← tento návod
```

---

## Rýchly prehľad — 8 krokov

1. Rozbaliť ZIP
2. V administrácii Websupportu vytvoriť **MySQL databázu**
3. Z `api/config.example.php` urobiť `api/config.php` a vyplniť údaje
4. Všetko nahrať do priečinka `web` (alebo `public_html`)
5. Otvoriť `https://tvojadomena.sk/install.php` a založiť účet správcu
6. **Zmazať `install.php`**
7. Zapnúť SSL certifikát
8. Poslať si skúšobnú objednávku a odkliknúť ju v admine

---

## 1. Rozbalenie balíka

Rozbaľ `enzo-web.zip` u seba v počítači. Vznikne priečinok so súbormi zo zoznamu
vyššie. **Nahrávaš obsah tohto priečinka, nie priečinok samotný** — na serveri
musí `index.html` ležať priamo v `web/`, nie v `web/enzo-web/`.

Súbory začínajúce bodkou (`.htaccess`) bývajú skryté. Vo Windows Prieskumníkovi
si ich zapni cez *Zobraziť → Skryté položky*, na Macu klávesou `Cmd + Shift + .`.

---

## 2. Databáza na Websupporte

1. Prihlás sa do administrácie Websupportu.
2. **Databázy → Vytvoriť databázu** (MySQL / MariaDB).
3. Zapíš si štyri údaje, ktoré ti hosting ukáže:

| Údaj | Vyzerá napríklad takto |
|------|------------------------|
| Server (host) | `mariadb103.websupport.sk` alebo `localhost` |
| Názov databázy | `enzosk` |
| Používateľ | `enzosk` |
| Heslo | to, ktoré si zadal |

> Ak si na hostingu, kde MySQL nie je, systém vie bežať aj na **SQLite** —
> databáza je potom obyčajný súbor v `storage/`. Nastavenie je v kroku 3.
> Pri bežnej prevádzke reštaurácie je to úplne v pohode, ale MySQL je istejšie.

---

## 3. Konfigurácia — `api/config.php`

V priečinku `api/` je súbor `config.example.php`. **Skopíruj ho** a kópiu
premenuj na `config.php`. Potom v nej vyplň svoje údaje.

Najdôležitejšie časti:

```php
'db' => [
    'driver'   => 'mysql',                       // alebo 'sqlite'
    'host'     => 'mariadb103.websupport.sk',
    'database' => 'enzosk',
    'username' => 'enzosk',
    'password' => 'TVOJE_HESLO',
],

'app' => [
    'url'    => 'https://enzo.sk',               // bez lomítka na konci
    'secret' => 'VLOZ_SEM_DLHY_NAHODNY_RETAZEC', // aspoň 32 znakov
],

'mail' => [
    'transport'  => 'smtp',
    'host'       => 'smtp.m.websupport.sk',
    'port'       => 465,
    'encryption' => 'ssl',                       // pri porte 587 daj 'tls'
    'username'   => 'objednavky@enzo.sk',
    'password'   => 'HESLO_K_MAILU',
    'from_email' => 'objednavky@enzo.sk',
    'from_name'  => 'ENZO Smash Burgers & Pizza',
    'shop_notify'=> 'prevadzka@enzo.sk',         // sem chodia nové objednávky
],
```

**`secret`** je tajný kľúč, ktorým sa podpisujú relácie. Vygeneruj si dlhý
náhodný reťazec (napr. na <https://passwordsgenerator.net/>, dĺžka 40) a nikomu
ho nedávaj. Keď ho neskôr zmeníš, všetci sa odhlásia z adminu — nič iné sa nestane.

> ⚠️ **`config.php` nikdy nikam neposielaj a nedávaj na GitHub.** Sú v ňom heslá.
> Do balíka, ktorý si sťahoval, sa nikdy nepribalí — je tam len vzor.

### E‑mailová schránka

Aby maily naozaj chodili, potrebuješ na Websupporte vytvorenú schránku
(**E‑maily → Vytvoriť e‑mailovú schránku**), napríklad `objednavky@enzo.sk`.
Odosielať cez cudziu adresu (gmail, azet) neskúšaj — server ju odmietne
alebo mail skončí v spame.

Ak si chceš najprv len vyskúšať, ako maily vyzerajú, daj dočasne
`'transport' => 'log'`. Maily sa potom neodosielajú, len sa ukladajú ako súbory
do `storage/mail/` a vieš si ich pozrieť.

---

## 4. Nahratie na hosting

### Cez administráciu Websupportu (najjednoduchšie)

1. **Súbory → Správca súborov**
2. Vojdi do priečinka `web` (niekde sa volá `public_html`)
3. Ak tam je nejaký uvítací `index.html` od hostingu, zmaž ho
4. Nahraj **obsah** rozbaleného priečinka aj s `.htaccess`

### Cez FTP (rýchlejšie, súborov je vyše 150)

Stiahni si [FileZillu](https://filezilla-project.org/). Prihlasovacie údaje na
FTP nájdeš v administrácii pod **Prístupy → FTP**.

```
Hostiteľ:  ftp.tvojadomena.sk
Meno:      (z administrácie)
Heslo:     (z administrácie)
Port:      21
```

Vo FileZille zapni *Server → Vynútiť zobrazenie skrytých súborov*, aby sa
`.htaccess` naozaj nahral.

### Práva na priečinok `storage`

`storage/` musí byť **zapisovateľný** — systém doň píše denníky. Ak inštalácia
zahlási, že sa nedá zapisovať, klikni v správcovi súborov pravým tlačidlom na
`storage` → **Práva / Permissions** a nastav `755` (keď to nestačí, `775`).

---

## 5. Inštalácia

Otvor v prehliadači:

```
https://tvojadomena.sk/install.php
```

Uvidíš kontrolu servera — všetky riadky by mali svietiť *v poriadku*. Ak niečo
chýba, obvykle je zle vyplnený `config.php` (najčastejšie heslo k databáze).

Potom vyplň **účet správcu** — svoje meno, e‑mail a heslo (aspoň 10 znakov).
Týmto sa budeš prihlasovať do adminu. Klikni **Nainštalovať**.

Systém sám:
- vytvorí tabuľky v databáze,
- naplní menu (8 kategórií, 40 položiek, doplnky),
- predvyplní nastavenia prevádzky,
- založí tvoj účet.

### ⚠️ Hneď potom zmaž `install.php`

Kým je na serveri, mohol by ho spustiť ktokoľvek. Zmaž ho v správcovi súborov
alebo cez FTP. Systém ti to pripomenie aj sám.

---

## 6. SSL certifikát (https)

V administrácii **Domény → SSL certifikát → Let's Encrypt (zdarma) → Aktivovať**.
Aktivácia trvá pár minút.

Bez https prehliadač pri objednávke ukáže „Nezabezpečené“ a zákazníci odídu.
Presmerovanie z `http` na `https` už v `.htaccess` je, zapne sa samo.

---

## 7. Skúška po nasadení

Prejdi si to ako zákazník:

| Čo skúsiť | Čo má nastať |
|-----------|--------------|
| `https://tvojadomena.sk` | načíta sa domovská stránka |
| Prepínanie kategórií v menu | menu sa mení, fotky sa načítajú |
| Pridanie burgra do košíka | košík vyskočí, počíta sumu |
| Objednávka do konca | vyskočí stránka s číslom objednávky |
| Tvoj e‑mail | do minúty príde doklad |
| `tvojadomena.sk/admin/` | prihlásiš sa, objednávka je v stĺpci **Nové** |
| Odklikneš **20 min** | zákazníkovi príde mail „hotové o …“ |

Ak mail nepríde, pozri sa do adminu na detail objednávky — dole je
**denník e‑mailov** a je v ňom napísané, čo sa pokazilo.

---

## Denná prevádzka — čo robí obsluha

Nechaj si na prevádzke otvorené `tvojadomena.sk/admin/dashboard.php`.
Stránka sa sama obnovuje každých 10 sekúnd a pri novej objednávke **pípne**.

Sú tam tri stĺpce:

**NOVÉ** → objednávka práve prišla. Klikneš na minúty (15 / 20 / 25 / 30 / 45 / 60)
podľa toho, ako si zaneprázdnený. Zákazníkovi okamžite odletí e‑mail
*„Hotové o 18:35 (približne 20 minút)“* a objednávka sa presunie ďalej.

**V PRÍPRAVE** → robí sa. Keď je jedlo hotové, klikneš **Pripravené** —
zákazník dostane mail, že si môže prísť / že kuriér vyráža.

**PRIPRAVENÉ** → keď si zákazník prevezme a zaplatí, klikneš **Vybavené**.
Vtedy sa objednávke pridelí **číslo dokladu** (napr. `2026/000042`) a pri platbe
v hotovosti sa označí ako zaplatená.

Na detaile objednávky je tlačidlo **Tlačiť** — vytlačí bloček na 80 mm
termotlačiarni (aj na obyčajnej A4 to vyzerá dobre).

### Keď zrovna nestíhaš

V admine hore je prepínač **Prijímame objednávky**. Keď ho vypneš, na webe sa
objednávky nedajú odoslať a zákazníkovi sa ukáže tvoj odkaz (text si nastavíš
v **Nastavenia**). Hodí sa cez obedný nápor alebo keď dôjde mäso.

---

## Úprava menu a webu — bez programátora

Všetko je v admine, žiadne súbory sa už neupravujú.

### Menu → jednotlivé položky
- cena, názov, popis, štítok (`NOVINKA`, `NAJPREDÁVANEJŠIE`)
- **Dostupné** — keď odškrtneš, položka na webe ostane vidieť, ale je
  prečiarknutá ako *Vypredané* a nedá sa objednať. Ideálne, keď niečo dôjde.
- doplnky priradené k položke (extra mäso, syr…)
- fotka — cesta k obrázku v `images/products/`

### Menu → kategórie
Poradie kategórií, názvy, popisky sekcií, skrytie celej kategórie.

### Nastavenia
- adresa, telefón, e‑mail, otváracie hodiny, obce kam rozvážaš
- **poplatok za doručenie**, **doručenie zdarma od**, **minimálna objednávka**
- predpokladané časy prípravy
- text, ktorý sa ukáže, keď neprijímaš objednávky

Zmeny sú na webe **okamžite**, netreba nič znova nahrávať.

> Fotky nových jedál nahraj cez správcu súborov do `images/products/`
> a v admine k položke zadaj cestu `/images/products/nazov.webp`.
> Ideálna veľkosť je 1200 × 900 px, formát `.webp` alebo `.jpg`.

---

## Platby

### Hotovosť
Funguje hneď. Zákazník platí pri prevzatí, ty pri kliknutí na **Vybavené**
označíš objednávku ako zaplatenú.

### Platba kartou (Stripe)

1. Založ si účet na <https://stripe.com> (slovenská firma, IČO, bankový účet).
2. V Stripe → **Developers → API keys** si skopíruj `Secret key` (`sk_live_…`).
3. V `api/config.php` vyplň:

```php
'payments' => [
    'cash_enabled' => true,
    'stripe' => [
        'enabled'        => true,
        'secret_key'     => 'sk_live_...',
        'publishable_key'=> 'pk_live_...',
        'webhook_secret' => 'whsec_...',
    ],
],
```

4. V Stripe → **Developers → Webhooks → Add endpoint** zadaj:
   `https://tvojadomena.sk/api/payment/webhook.php`
   a vyber udalosť `checkout.session.completed`. Stripe ti ukáže
   `whsec_…` — ten vlož do `webhook_secret`.

Kým `enabled` nie je `true`, platba kartou sa zákazníkovi v pokladni vôbec
neponúkne — uvidí len hotovosť. Nič sa nerozbije.

Peniaze chodia na tvoj účet cez Stripe (poplatok cca 1,5 % + 0,25 € za platbu
z európskej karty). Objednávka sa pustí do prípravy až po zaplatení.

---

## Účtovníctvo

V admine je záložka **Účtovníctvo**. Za každý mesiac ukáže:

- celkovú tržbu a počet objednávok
- rozdelenie **hotovosť / karta / neuhradené**
- rozpis DPH (ak si platiteľ)
- **Export CSV** — zvlášť objednávky, zvlášť položky

CSV je v kódovaní UTF‑8 s BOM a s bodkočiarkou ako oddeľovačom, takže sa
v Exceli otvorí správne aj s diakritikou. Účtovníčke stačí poslať tieto dva
súbory.

Ak si **platiteľ DPH**, nastav to v `api/config.php`:

```php
'accounting' => [
    'vat_payer'  => true,
    'vat_number' => 'SK2122832888',
    'vat_food'   => 19.0,   // jedlo
    'vat_drinks' => 23.0,   // nápoje
    'doc_prefix' => 'ENZO',
],
```

Systém potom pri každej objednávke počíta základ dane a DPH zvlášť pre jedlo
a nápoje a vypíše to aj na doklad.

### ⚠️ Toto nenahrádza eKasu

Systém eviduje objednávky a vystavuje k nim doklady, ale **nie je registračná
pokladnica podľa zákona o eKase**. Ak podľa zákona musíš mať eKasu, musíš ju
mať naďalej a bločky vydávať cez ňu. Doklady odtiaľto slúžia ako interná
evidencia a podklad pre účtovníčku — je to na nich aj napísané.

Konkrétnu situáciu si over so svojou účtovníčkou alebo na finančnej správe.

---

## Zálohovanie

**Databáza** — v administrácii Websupportu **Databázy → Zálohy**, alebo cez
phpMyAdmin *Export → Rýchly → SQL*. Rob to aspoň raz mesačne; sú v nej všetky
objednávky.

Ak používaš SQLite, stačí si stiahnuť súbor `storage/enzo.sqlite`.

**Súbory** — pôvodný `enzo-web.zip` si odlož. Jediné, čo si na serveri
vytvoril navyše, je `api/config.php` a nahraté fotky.

---

## Bezpečnosť — čo je už vyriešené

| Riziko | Ako je ošetrené |
|--------|-----------------|
| Podvrhnutá cena v objednávke | ceny sa **vždy** počítajú na serveri z databázy, čokoľvek pošle prehliadač sa ignoruje |
| Vymyslený doplnok zadarmo | akceptujú sa len doplnky naozaj priradené k danej položke |
| Cudzí človek si pozrie objednávku | k objednávke treba 32‑znakový prístupový kód z e‑mailu |
| Zaplavenie falošnými objednávkami | limit objednávok na IP za hodinu (`rate_limit_per_hour`) |
| Prelomenie hesla do adminu | heslá cez bcrypt, obmedzený počet pokusov |
| Cudzí formulár odošle akciu za teba | CSRF token v každom formulári aj v akciách adminu |
| Stiahnutie `config.php` s heslami | `.htaccess` v `api/` prístup zakazuje |
| Prezretie databázy pri SQLite | `.htaccess` zamyká celý priečinok `storage/` |

Čo musíš spraviť ty: **dlhé heslo do adminu**, **zmazať `install.php`**
a **nikomu neposielať `config.php`**.

---

## Aktualizácia webu

Keď dostaneš novú verziu balíka:

1. Zazálohuj si databázu.
2. Nahraj nové súbory a **prepíš** staré.
3. **`api/config.php` nechaj tak, ako je** — nový balík ho neobsahuje,
   takže sa neprepíše.
4. Ak je v balíku `install.php`, po prípadnej aktualizácii databázy ho zmaž.

Menu a nastavenia sú v databáze, aktualizácia ich neprepíše.

---

## Riešenie problémov

**„Menu sa nenačítava“ / na stránke je stará ponuka**
Web má v sebe záložnú kópiu menu pre prípad, že server neodpovie. Ak vidíš
staré ceny, otvor `https://tvojadomena.sk/api/menu.php` — musí sa zobraziť text
začínajúci `{"ok":true`. Ak je tam chyba, pozri `storage/logs/php-error.log`.

**„Objednávku sa nepodarilo odoslať“**
Skoro vždy je to zle vyplnený `config.php`. Skontroluj údaje k databáze.

**Neprichádzajú e‑maily**
V admine na detaile objednávky je denník e‑mailov s presnou chybou.
Najčastejšie: zlé heslo k schránke, alebo port. Skús `587` + `tls`
namiesto `465` + `ssl`.

**Do adminu sa neviem prihlásiť**
Heslo sa nedá poslať e‑mailom, keď mail ešte nefunguje. Iný správca ti ho vie
zmeniť v **Používatelia**. Ak si sám a heslo si zabudol, ozvi sa —
dá sa prepísať priamo v databáze.

**Biela stránka**
Otvor `storage/logs/php-error.log`. Býva to preklep v `config.php` —
napríklad chýbajúca čiarka alebo apostrof.

**Stránka `/pokladna` hodí 404**
Nenahral sa `.htaccess`. Zapni si zobrazenie skrytých súborov a nahraj ho.

**Zmenil som menu, ale na webe je stará cena**
Menu sa na pol minúty ukladá do vyrovnávacej pamäte. Počkaj chvíľu
alebo obnov stránku cez `Ctrl + F5`.

---

## Logá na stiahnutie

V `brand/` sú pripravené vo všetkých variantoch — na tlač, na sociálne siete,
na obal aj na tmavé pozadie:

| Súbor | Kedy použiť |
|-------|-------------|
| `enzo-wordmark-burgundy.svg` | základné logo na svetlom podklade |
| `enzo-wordmark-cream.svg` | na bordovom / tmavom podklade |
| `enzo-wordmark-black.svg` | jednofarebná tlač, pečiatky |
| `enzo-wordmark-*-transparent.png` | do dokumentov a na sociálne siete |
| `enzo-badge-burgundy.svg` | okrúhly odznak — nálepky, obaly, profilovka |
| `enzo-lockup-horizontal.svg` | do hlavičky, na banner, na auto |

SVG je vektor — dá sa zväčšiť na billboard bez straty kvality. PNG majú
priehľadné pozadie a šírku okolo 2400 px.

---

## Čo doplniť pred ostrým spustením

- [ ] Skutočné fotky jedál namiesto ilustračných
- [ ] Overiť cenu Kofoly (2,00 € je odhad, na tlačenom menu nebola)
- [ ] Doplniť odkazy na Instagram a Facebook v **Nastaveniach**
- [ ] Prejsť si obchodné podmienky a ochranu osobných údajov s právnikom
- [ ] Nastaviť, či a ako riešiš eKasu
- [ ] Vyskúšať objednávku na mobile aj na počítači
- [ ] Nastaviť si na prevádzke tablet alebo starý notebook s otvoreným dashboardom

---

Keby čokoľvek nefungovalo, napíš — najviac pomôže screenshot chyby
a obsah `storage/logs/php-error.log`.
