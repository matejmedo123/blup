-- ============================================================================
-- The first published version of each legal document.
--
-- Seeded as a migration rather than left to the admin screen, because a
-- deployment with no terms is a deployment that cannot legally sell anything —
-- and because "you agreed to this" needs the text to have existed at the time.
--
-- The placeholders are filled in by the operator in Admin → Právne dokumenty
-- before going live: publishing a new version is how these change, never an
-- edit in place, which the freeze trigger enforces.
-- ============================================================================

insert into public.legal_documents (kind, version, locale, title, body, published_at)
values ('terms', '1.0', 'sk', 'Obchodné podmienky', $doc$# Obchodné podmienky

**Prevádzkovateľ:** {{PREVADZKOVATEL}}
**Kontakt:** {{KONTAKT_EMAIL}}
**Účinné od:** {{DATUM}}

## 1. Čo BLUP je a čo nie je

BLUP je platforma, na ktorej organizátori zverejňujú svoje eventy a predávajú
na ne vstupenky. **Organizátorom eventu nie sme my.** Zmluva o vstupe na event
vzniká medzi tebou a organizátorom; my sprostredkúvame predaj a inkasujeme
platbu v jeho mene.

Znamená to, že za priebeh, kvalitu, zrušenie alebo presun eventu zodpovedá
organizátor. Jeho identitu — vrátane obchodného mena a IČO — nájdeš na
vstupenke.

## 2. Účet

Účet si môže založiť osoba staršia ako 16 rokov. Zodpovedáš za to, čo sa cez
tvoj účet deje, a za pravdivosť údajov, ktoré zadáš.

Účet môžeme pozastaviť, ak cez neho niekto porušuje tieto podmienky alebo
zákon. Ak to nie je nevyhnutné okamžite, upozorníme ťa najprv.

## 3. Vstupenky a platby

Platbu spracúva **Stripe**. Vstupenka je platná až po tom, ako Stripe potvrdí
prijatie platby — samotné odoslanie formulára vstupenku nevytvára.

Ku každej vstupenke sa účtuje **archívny poplatok**, ktorého výšku uvidíš v
pokladni pred zaplatením. Cenu vstupenky určuje organizátor.

Vstupenka je viazaná na kód, ktorý je jedinečný. **Odovzdaním kódu inému
človeku odovzdávaš aj vstupenku** — kto ho použije prvý, ten vojde.

## 4. Vrátenie peňazí

**Ak sa event zruší**, máš nárok na vrátenie ceny vstupenky. Vracia ju
organizátor; my mu na to poskytneme prostriedky, ktoré od teba vybral, ak ich
ešte nemá vyplatené.

**Ak sa event presunie**, vstupenka platí na nový termín. Ak sa ti nový termín
nehodí, môžeš do 14 dní od oznámenia požiadať o vrátenie.

**Ak sa event koná tak, ako bol ohlásený**, nárok na vrátenie nevzniká. Podľa
§ 7 ods. 6 písm. k) zákona č. 102/2014 Z. z. sa na vstupenky na podujatie s
určeným termínom **nevzťahuje 14-dňové právo na odstúpenie od zmluvy**.

Reklamáciu podávaš organizátorovi. Ak sa s ním nedohodneš, napíš nám na
{{KONTAKT_EMAIL}} — pomôžeme sprostredkovať, ale nemôžeme rozhodnúť za neho.

## 5. Čo na BLUP nepatrí

Nezverejňuj obsah, ktorý je protiprávny, podnecuje k nenávisti alebo násiliu,
porušuje cudzie práva duševného vlastníctva, alebo je klamlivý. Nezverejňuj
event, ktorý neexistuje alebo ktorý nemáš právo organizovať.

Takýto obsah odstránime. Pri opakovanom alebo závažnom porušení účet zrušíme.

## 6. Obsah, ktorý nahráš

Zostáva tvoj. Nahratím nám udeľuješ **bezodplatnú, nevýhradnú licenciu** ho
zobrazovať v rámci služby a v jej propagácii — v rozsahu nevyhnutnom na to,
aby ho ľudia videli tam, kde si ho umiestnil. Licencia zaniká zmazaním obsahu,
okrem kópií v zálohách a tam, kde ho už niekto ďalej použil v dobrej viere.

## 7. Dostupnosť služby

Snažíme sa, aby BLUP fungoval. **Negarantujeme nepretržitú dostupnosť** a
službu môžeme obmedziť kvôli údržbe, bezpečnosti alebo zákonnej povinnosti.

## 8. Zodpovednosť

Zodpovedáme za škodu spôsobenú **úmyselne alebo hrubou nedbanlivosťou**, a za
škodu na zdraví — tú obmedziť nemožno a ani sa o to nepokúšame.

V ostatných prípadoch je naša zodpovednosť obmedzená sumou, ktorú si cez BLUP
zaplatil za posledných 12 mesiacov. Nezodpovedáme za ušlý zisk, ani za konanie
organizátora.

Ak si spotrebiteľ, tieto obmedzenia sa neuplatnia tam, kde ich zákon
nedovoľuje.

## 9. Predplatné BLUP Premium

Predplatné sa obnovuje automaticky na konci obdobia, kým ho nezrušíš. Zrušiť ho
vieš kedykoľvek — platí do konca zaplateného obdobia a nevracia sa alikvotná
časť. Ak si ho kúpil cez App Store, spravuješ ho v nastaveniach Apple ID.

## 10. Riešenie sporov

Ak si spotrebiteľ, môžeš sa obrátiť na **Slovenskú obchodnú inšpekciu** alebo
na platformu EÚ pre riešenie sporov online:
[ec.europa.eu/consumers/odr](https://ec.europa.eu/consumers/odr).

Vzťah sa spravuje právom Slovenskej republiky. Voľba práva nezbavuje
spotrebiteľa ochrany podľa práva krajiny jeho pobytu.

## 11. Zmeny podmienok

Zmeny zverejníme tu. Podstatné zmeny oznámime aspoň **15 dní vopred** v
aplikácii alebo e-mailom. Ak so zmenou nesúhlasíš, môžeš účet zrušiť; ďalším
používaním po účinnosti zmeny ju prijímaš.
$doc$, now())
on conflict (kind, version, locale) do nothing;

insert into public.legal_documents (kind, version, locale, title, body, published_at)
values ('privacy', '1.0', 'sk', 'Ochrana osobných údajov', $doc$# Ochrana osobných údajov

**Prevádzkovateľ:** {{PREVADZKOVATEL}}
**Kontakt:** {{KONTAKT_EMAIL}}
**Účinné od:** {{DATUM}}

Tento dokument opisuje, aké údaje BLUP spracúva, prečo, ako dlho a komu ich
odovzdáva. Je písaný podľa toho, čo aplikácia skutočne robí.

## 1. Aké údaje spracúvame

**Údaje účtu.** E-mail, meno alebo prezývka, ktoré si zadáš, heslo (uložené
výhradne ako kryptografický odtlačok — nikdy ho nevidíme), a voliteľne
profilová fotka, krátky popis a mesto.

**Poloha.** Ak jej použitie povolíš, ukladáme poslednú známu polohu, aby sme
vedeli zoradiť eventy podľa vzdialenosti. Presnú polohu nezverejňujeme —
ostatní vidia najviac mesto, a aj to len ak si to nevypneš v Nastavenia →
Súkromie.

**Aktivita v aplikácii.** Na ktoré eventy sa prihlásiš, čo si uložíš, čo si
otvoríš, čo napíšeš do komentárov a chatov. Tieto údaje používame na
zostavenie odporúčaní.

**Objednávky a vstupenky.** Čo si kúpil, za koľko a kedy. **Číslo tvojej
platobnej karty sa k nám nikdy nedostane** — platbu spracúva Stripe na
vlastnej stránke a nám vracia len výsledok.

**Overenie organizátora.** Ak predávaš vstupenky: obchodné meno, IČO, DIČ,
adresa, kontaktné údaje a doklady, ktoré nahráš.

**Technické údaje.** IP adresa a typ zariadenia v prevádzkových záznamoch,
ktoré vznikajú automaticky pri každom prístupe.

## 2. Prečo ich spracúvame a na akom základe

| Účel | Právny základ (GDPR čl. 6) |
| --- | --- |
| Vedenie účtu a prihlásenie | plnenie zmluvy — čl. 6 ods. 1 písm. b) |
| Predaj a doručenie vstupeniek | plnenie zmluvy — písm. b) |
| Účtovné a daňové povinnosti | zákonná povinnosť — písm. c) |
| Overenie organizátora | zákonná povinnosť a plnenie zmluvy |
| Odporúčania a zoradenie eventov | oprávnený záujem — písm. f) |
| Upozornenia v prehliadači a e-maily o novinkách | súhlas — písm. a) |
| Bezpečnosť, prevencia zneužitia | oprávnený záujem — písm. f) |

Súhlas vieš kedykoľvek odvolať v **Nastavenia → Upozornenia**. Odvolanie nemá
vplyv na zákonnosť spracúvania pred odvolaním.

## 3. Komu údaje odovzdávame

Nepredávame ich nikomu. Odovzdávame ich len tým, bez ktorých by služba
nefungovala:

| Príjemca | Čo dostane | Kde spracúva |
| --- | --- | --- |
| **Supabase** (databáza, prihlasovanie, úložisko) | všetky údaje účtu a obsahu | EÚ |
| **Stripe** (platby a výplaty) | e-mail, suma, údaje o objednávke; údaje o karte zadávaš priamo im | EÚ / USA |
| **Resend** (odosielanie e-mailov) | e-mail príjemcu a obsah správy | EÚ / USA |
| **CARTO** (mapové podklady) | IP adresa pri načítaní mapy | EÚ / USA |
| **OpenStreetMap / Nominatim** (vyhľadanie adresy) | adresa, ktorú organizátor zadá | EÚ |
| **Anthropic** (slovné vysvetlenia odporúčaní, ak je zapnuté) | názvy a kategórie eventov, nie tvoje meno ani e-mail | USA |
| **Apple** (predplatné cez App Store, ak ho použiješ) | doklad o nákupe | USA |

Pri prenosoch mimo EÚ sa uplatňujú štandardné zmluvné doložky Európskej
komisie.

**Organizátorovi** eventu, na ktorý sa prihlásiš, sprístupníme tvoje meno,
profilovú fotku a to, že ideš. Pri kúpe vstupenky aj tvoj e-mail — potrebuje
ho, ak sa event zruší alebo presunie.

## 4. Ako dlho ich uchovávame

| Údaje | Doba |
| --- | --- |
| Účet a profil | kým účet nezrušíš |
| Obsah, ktorý si vytvoril (komentáre, fotky) | kým ho nezmažeš, alebo do zrušenia účtu |
| Objednávky, vstupenky a účtovné doklady | **10 rokov** — zákon o účtovníctve, bez ohľadu na zrušenie účtu |
| Overovacie doklady organizátora | 10 rokov od skončenia spolupráce |
| Prevádzkové záznamy | 12 mesiacov |
| Signály pre odporúčania | 24 mesiacov od poslednej aktivity |

Po zrušení účtu zostávajú len tie údaje, ktoré musíme uchovať zo zákona.
Ostatné mažeme do 30 dní.

## 5. Tvoje práva

Máš právo na **prístup** k svojim údajom, ich **opravu**, **vymazanie**,
**obmedzenie spracúvania**, **prenosnosť** a právo **namietať** proti
spracúvaniu na základe oprávneného záujmu — vrátane odporúčaní.

Väčšinu vybavíš sám v **Nastavenia → Súkromie** (export a zrušenie účtu).
Inak napíš na {{KONTAKT_EMAIL}}; odpovedáme do 30 dní.

Ak si myslíš, že spracúvame tvoje údaje v rozpore so zákonom, môžeš podať
sťažnosť na **Úrad na ochranu osobných údajov SR**, Hraničná 12, 820 07
Bratislava, [dataprotection.gov.sk](https://dataprotection.gov.sk).

## 6. Automatizované rozhodovanie

Poradie eventov, ktoré vidíš, určuje algoritmus zo šiestich signálov: zhoda s
tvojimi záujmami, vzdialenosť, koho zo svojich kruhov tam máš, na čo si
chodieval, popularita eventu a to, ako skoro sa koná. **Nejde o rozhodnutie s
právnym účinkom** — nič ti neodopiera ani nepriznáva. Ovplyvniť ho vieš úpravou
záujmov, a zoradenie vieš prepnúť na „Všetko".

Zaplatené propagované eventy sú vždy označené ako **Propagované**.

## 7. Deti

Služba nie je určená osobám mladším ako 16 rokov. Ak zistíme, že sme založili
účet dieťaťu mladšiemu ako 16 rokov bez súhlasu zákonného zástupcu, zmažeme ho.

## 8. Cookies a podobné technológie

Používame len to, čo je nevyhnutné na chod služby: prihlasovacie tokeny a
lokálne uložené nastavenia. Žiadne reklamné ani sledovacie cookies tretích
strán nenasadzujeme bez tvojho súhlasu.

## 9. Zmeny

Zmeny zverejníme na tejto stránke. Ak pôjde o podstatnú zmenu, upozorníme ťa
v aplikácii alebo e-mailom aspoň 15 dní vopred.
$doc$, now())
on conflict (kind, version, locale) do nothing;

insert into public.legal_documents (kind, version, locale, title, body, published_at)
values ('organizer_agreement', '1.0', 'sk', 'Zmluva o sprostredkovaní predaja vstupeniek', $doc$# Zmluva o sprostredkovaní predaja vstupeniek

**Sprostredkovateľ:** {{PREVADZKOVATEL}} (ďalej „BLUP")
**Organizátor:** subjekt uvedený v overovacej žiadosti, ku ktorej je táto zmluva pripojená
**Verzia:** {{VERZIA}}

Organizátor prijíma túto zmluvu odoslaním žiadosti o overenie. BLUP ju
podpisuje schválením žiadosti. Obe strany majú jej znenie a čas prijatia
uložené v systéme.

## 1. Predmet

BLUP sprostredkúva predaj vstupeniek na eventy Organizátora a inkasuje zaň
platby **v mene a na účet Organizátora**. BLUP nie je organizátorom eventu,
nie je predávajúcim vstupenky a nevstupuje do zmluvy medzi Organizátorom a
návštevníkom.

## 2. Čo vyhlasuje Organizátor

Odoslaním žiadosti o overenie Organizátor vyhlasuje, že:

a) údaje v žiadosti sú pravdivé a úplné, a doklady sú pravé;
b) je oprávnený event usporiadať a vstupenky naň predávať;
c) má všetky povolenia, ohlásenia a licencie, ktoré event vyžaduje —
   vrátane vysporiadania autorských práv (SOZA, LITA a obdobné);
d) event neporušuje právne predpisy ani práva tretích osôb;
e) je platiteľom alebo neplatiteľom DPH tak, ako uviedol, a sám si plní daňové
   a účtovné povinnosti z predaja.

Ak sa niektoré z týchto vyhlásení ukáže ako nepravdivé, BLUP môže predaj
okamžite zastaviť a výplatu pozastaviť.

## 3. Provízia a poplatky

BLUP si účtuje **províziu** z ceny predanej vstupenky vo výške uvedenej v
nástenke Organizátora, a **archívny poplatok** za každú vydanú vstupenku.
Aktuálne sadzby sú vždy zobrazené pred zverejnením eventu a v sekcii
Účtovníctvo.

Zmenu sadzieb oznámi BLUP aspoň **30 dní vopred**. Do vtedy zverejnených
eventov sa zmena nepremieta.

Poplatky poskytovateľa platieb (Stripe) sa účtujú podľa jeho cenníka.

## 4. Výplaty

Prostriedky vybrané od návštevníkov drží BLUP pre Organizátora a vypláca ich
na účet pripojený cez overenie totožnosti (KYC) u poskytovateľa platieb.

Výplata je splatná po uplynutí **zúčtovacieho obdobia** uvedeného v nástenke,
najskôr po skončení eventu. BLUP môže výplatu **zadržať**, ak:

a) prebieha spor, reklamácia alebo spätné zúčtovanie (chargeback);
b) existuje dôvodné podozrenie z podvodu alebo porušenia tejto zmluvy;
c) to vyžaduje rozhodnutie orgánu verejnej moci.

O zadržaní BLUP Organizátora informuje spolu s dôvodom.

## 5. Zrušenie alebo presun eventu

Ak Organizátor event zruší, **je povinný vrátiť cenu vstupeniek** všetkým
kupujúcim. BLUP na to použije prostriedky, ktoré ešte nevyplatil; ak
nepostačujú, rozdiel uhradí Organizátor do **14 dní** od výzvy.

Provízia a archívny poplatok za zrušený event sa nevracajú, ak už boli
vynaložené náklady na spracovanie platby.

Pri presune termínu vstupenky platia na nový termín; kupujúcemu, ktorý o to
požiada do 14 dní od oznámenia, vracia cenu Organizátor.

## 6. Spätné zúčtovania a reklamácie

Spätné zúčtovanie (chargeback) rieši Organizátor a znáša jeho náklady vrátane
poplatku poskytovateľa platieb. BLUP poskytne podklady, ktoré má k dispozícii.

Reklamácie návštevníkov vybavuje Organizátor. BLUP ich môže preposielať, ale
nerozhoduje o nich.

## 7. Zodpovednosť Organizátora voči BLUP

Organizátor **odškodní BLUP** za škodu, pokuty a náklady (vrátane primeraných
nákladov právneho zastúpenia), ktoré BLUP vzniknú v dôsledku:

a) porušenia vyhlásení podľa čl. 2;
b) nároku návštevníka alebo tretej osoby súvisiaceho s eventom;
c) nároku z autorských práv k obsahu, ktorý Organizátor nahral;
d) rozhodnutia orgánu verejnej moci týkajúceho sa eventu.

## 8. Zodpovednosť BLUP

BLUP zodpovedá za škodu spôsobenú úmyselne alebo hrubou nedbanlivosťou. V
ostatných prípadoch je jeho zodpovednosť voči Organizátorovi obmedzená
**súhrnom provízií, ktoré BLUP od Organizátora prijal za posledných 12
mesiacov**.

BLUP nezodpovedá za ušlý zisk, za nepredané vstupenky, ani za výpadok služby
spôsobený treťou stranou.

## 9. Údaje návštevníkov

Údaje kupujúcich sprístupnené Organizátorovi (meno, e-mail, stav vstupenky)
smie Organizátor použiť **výhradne** na zabezpečenie eventu a komunikáciu o
ňom. Marketingové použitie je možné len s osobitným súhlasom kupujúceho.

Vo vzťahu k týmto údajom je Organizátor samostatným prevádzkovateľom a
zodpovedá za splnenie povinností podľa GDPR.

## 10. Trvanie a ukončenie

Zmluva sa uzatvára na dobu neurčitú. Ktorákoľvek strana ju môže vypovedať s
**30-dňovou výpovednou lehotou**.

BLUP môže odstúpiť **s okamžitou účinnosťou**, ak Organizátor podstatne porušil
zmluvu, uviedol nepravdivé údaje alebo ohrozuje návštevníkov.

Ukončenie nemá vplyv na už predané vstupenky — event sa musí uskutočniť alebo
sa musia vrátiť peniaze — ani na články 6, 7, 8 a 9, ktoré platia ďalej.

## 11. Rozhodné právo

Zmluva sa spravuje právom Slovenskej republiky. Spory rieši vecne a miestne
príslušný súd Slovenskej republiky podľa sídla BLUP.
$doc$, now())
on conflict (kind, version, locale) do nothing;
