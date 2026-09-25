# Aktualizácia bežiacej inštalácie

Toto je postup pre prípad, keď na `blup.sk` **už beží staršia verzia a v databáze
sú skutočné dáta** — účty, eventy, prihlásenia. Nič sa nemaže a nič sa nemusí
zakladať odznova.

Počítaj s **20 minútami**, z toho väčšina je čakanie na build.

> **Zálohu si sprav aj tak.** Supabase → **Database → Backups → Create backup**.
> Trvá to minútu a je to jediná vec v tomto postupe, ktorá sa nedá vrátiť späť,
> ak ju vynecháš.


---

## Čo je nové v tomto balíku

Desať vecí z tvojho posledného zoznamu — štyri chyby a šesť nových vecí.
Pri každej je aj to, čo presne bolo zle.

**Chat**

- **Zmazanie chatu.** Dlhé podržanie konverzácie v Správach, alebo kôš v hlavičke
  otvoreného chatu. Zmaže sa **tebe**: história zmizne, chat vypadne zo zoznamu.
  Druhej strane nezmizne nič — to sa nedá a appka to ani netvrdí. Keď ti dotyčný
  napíše, chat sa vráti, ale už len s novými správami. Schválne to **nie je**
  odchod z konverzácie: to by znamenalo, že ti ten človek už nikdy nenapíše,
  čiže blok vydávaný za mazanie.
- **GIFy.** Tlačidlo `GIF` v lište pri písaní. Dve cesty: vyhľadávanie (ide cez
  našu serverovú funkciu, kľúč k poskytovateľovi zostáva na serveri a nikdy sa
  nedostane do appky) a **vlastný GIF z fotiek**, ktorý funguje vždy. Keď kľúč
  nie je nastavený, picker to **povie** namiesto prázdnej mriežky. GIF sa
  nahráva bez prekódovania — všetko ostatné sa u nás prevádza na JPEG, a JPEG má
  jeden snímok, takže by z animácie ostala fotka.
- **Lupa v Správach konečne hľadá ľudí.** Predtým otvárala hľadanie eventov —
  sebavedivá odpoveď na otázku, ktorú v schránke nikto nekladie. Teraz hľadá
  v tvojich chatoch podľa mena aj @prezývky a pod nimi ponúkne ľudí, ktorých
  sleduješ a ešte si im nepísal. Cudzích neponúka.

**Feed a príbehy**

- **Príbehy na 24 hodín** — pre bežného používateľa aj pre organizátora (ten
  môže pridávať pod menom organizácie). Krúžok nad feedom **svieti len vtedy,
  keď je v ňom niečo nepozreté**; predtým to bol zoznam ľudí, ktorých sleduješ,
  s farebným krúžkom okolo každého, a ten krúžok neznamenal nič. Autor vidí,
  kto mu príbeh pozrel; nikto iný ten počet nevidí. Po 24 hodinách sa riadky aj
  obrázky naozaj mažú, nielen skryjú (nový cron `blup-stories`).
- **Nový event od niekoho, koho sleduješ, je vo feede.** Nezapisuje sa žiadny
  falošný príspevok — feed sa pýta na dve veci naraz (čo ľudia napísali a čo
  vypísali) a premieša ich podľa času. Karta má odznak `NOVÝ EVENT`.
- **Platená reklama vo feede.** Po treťom príspevku, označená `SPONZOROVANÉ`,
  z toho istého systému boostov, ktorý už funguje — čiže sa ukáže **len keď
  niekto naozaj zaplatil**. Keď taký nikto nie je, nie je tam ani slot.

**Pri dverách**

- **Koľko ešte treba odbaviť.** V štatistikách eventu pribudla sekcia
  *Pri dverách*: **vnútri**, **ešte treba odbaviť**, platné vstupenky a percento.
  To isté vidí skener po každom načítaní. Menovateľ sú **platné** vstupenky, nie
  predané — predané rátajú aj vrátené, takže by si pri dverách do rána čakal na
  ľudí, ktorým sa už vrátili peniaze.

**Opravené chyby**

- **„Tvoje kruhy dnes niekam idú" klamalo.** Riadok sa bral z „koho sleduješ",
  bez akejkoľvek zmienky o dnešku — stačilo sledovať jedného človeka a appka
  každý večer tvrdila, že tvoje kruhy niekam idú. Teraz to je presne tá otázka,
  ktorú ten riadok celý čas predstieral, a keď je jediný, povie aj **na aký
  event** ten človek ide.
- **Odznak pri mene pohlcovalo pozadie.** Emotikon visel priamo na tmavom
  podklade, a dobrá polovica katalógu je tmavý znak (✍️ 🎲 🧭 🎒) — na `#0A0D12`
  z toho bola diera v riadku. Každý odznak má teraz svetlý kruh pod sebou.
- **Ťahanie eventu v „Blupni si program" ťahalo titulnú fotku.** Prehliadač
  začne vlastné drag-and-drop v momente, keď stlačenie pristane na obrázku — a
  karta v Objave je prevažne plagát, takže gesto kradol plagát. Rovnaká vec,
  aká sa už riešila na pláne haly; teraz je to zakázané globálne.
- **Preview backend vracal iný tvar než ostrá databáza.** Funkcia, ktorá vracia
  zoznam, prichádzala ako jeden objekt namiesto poľa, takže obrazovky padali
  len v náhľade. Vyzeralo to ako chyba appky a bola to chyba náhľadu.

**Príbehy ako na Instagrame**

- **Fotíš a natáčaš rovno v príbehu.** Ťuknutie na spúšť je fotka, podržanie
  natáča — a okolo spúšte sa plní krúžok, ktorý po pätnástich sekundách
  dobehne a nahrávanie **skončí samo**. Pätnásť nie je náhodné číslo: presne
  tak dlho sa príbeh prehráva, takže dlhšie video by sa aj tak nedopozeralo.
  Dlhé podržanie kruhu „Pridať" berie niečo, čo už v telefóne máš.
- **Text cez príbeh.** Napíšeš ho rovno cez fotku alebo video, päť farieb, tri
  veľkosti. Neukladá sa vypálený do obrázka — vypálený text sa nedá opraviť,
  neprečíta ho čítačka pre nevidiacich a pri videu by ho bolo treba zakódovať
  do každého snímku. Ukladá sa ako údaj a kreslí sa nad médiom.
- **Krúžok okolo profilovky zmizne, keď si príbeh pozrieš.** Predtým zošedivel
  — lenže sivý krúžok je kútikom oka stále krúžok, takže riadok vyzeral rovnako
  plný, či v ňom niečo nové bolo alebo nie. Teraz krúžok znamená jedinú vec:
  **toto si ešte nevidel**. Nič sa tým nestráca — v tom riadku sú aj tak len
  ľudia, ktorí príbeh majú, a dá sa na nich ťuknúť rovnako.
- **Druhý príbeh sa pridáva z hlavičky toho tvojho** — `＋` vedľa koša. Obe sú
  veci, ktoré robíš so svojím príbehom, tak sú vedľa seba a sú na obrazovke od
  prvej snímky. Predtým to bolo dole pod popisom a zoznamom divákov, kde sa to
  posúvalo a zavadzalo tomu, kvôli čomu si tam prišiel.
- **Galéria je v kamere**, vedľa spúšte — tam, kde si, keď si to rozmyslíš a
  chceš radšej včerajšiu fotku. Dlhé podržanie kruhu „Pridať" ju otvorí tiež.
- **Veľkosť videa sa rieši pri nahrávaní, nie odmietaním.** Mal si pravdu, že
  25 MB je zlá páka: pätnásť sekúnd z telefónu má bežne 20–30 MB, lebo kamera
  natáča 1080p60 pri vysokom toku. Appka teraz natáča **720p** a sám záznamník
  si stráži strop 12 MB, takže celých pätnásť sekúnd vyjde okolo **5 MB**.
  Strop na nahratie zostal len ako poistka pre súbor, ktorý príde inou cestou,
  a zdvihol sa na 75 MB, aby neblokoval zbytočne.

**A ešte osem vecí z druhého kola**

- **Futbalový štadión v plánoch sa konečne načíta.** Predloha má 67 sektorov a
  jej použitie trvalo **77 sekúnd**, čiže z appky neprešlo vôbec — requestu
  vyprší čas a ty vidíš len to, že sa nič nestalo. Obrys tribúny má 32 bodov a
  funkcia, ktorá počíta miesta, ten obrys prechádzala znova pre každé jedno
  miesto: asi **17 miliónov čítaní JSONu** na jeden štadión. Teraz sa tvar
  rozparsuje raz. **77 s → 1,1 s**, a plán je do posledného sedadla ten istý
  (porovnané, 10 356 miest, nula rozdielov).
- **Event, ktorý nebolo vidno na mape.** Mapa hlásila, akú časť sveta ukazuje,
  **iba raz** — a to ešte predtým, než si nastavila zoom podľa polomeru. Appka
  teda načítala eventy pre výrez, ktorý mapa mala jednu snímku, a nie pre ten,
  v ktorom skončila. Event na obrazovke bez špendlíka. Teraz sa výrez hlási
  vždy, keď sa zmení.
- **Mapa pri odďaľovaní.** Každá udalosť kolieska brala celý stupeň zoomu — a
  trackpad ich pošle desiatky za jedno gesto, takže jedno šmyknutie prepadlo o
  päť stupňov. Teraz sa načítava, kým to nie je jedno celé cvaknutie.
- **Kategórie:** kvíz, šport, hokej, tenis, fitness, koncert, párty, stand-up,
  comedy, trhy, konferencia, workshop, esport, pre rodiny, charita. Pätnásť,
  ktoré chýbali — dovtedy museli ísť pod „Iné", čo event vyradí z filtrov aj zo
  záujmov naraz.
- **Karta vo feede už nie je roztiahnutá.** Feed sa rozťahoval na celú šírku
  okna, takže na monitore mala karta dvetisíc pixelov a obálka stále 190 —
  z plagátu bol prúžok. Teraz má feed šírku karty a obálka si berie pomer
  strán obrázka.
- **Premium pri tvojom mene.** Odznak bol na profiloch všetkých ostatných a na
  tvojom vlastnom nie — čiže jediný človek, ktorý zaň platí, bol jediný, kto ho
  nevidel.
- **Príbeh beží 10 sekúnd** a pás hore sa počas toho plní, takže je vidieť,
  koľko zostáva. Podržaním sa zastaví — príbeh s popisom inak rozhoduje za
  teba, ako dlho ho smieš čítať.
- **Príbeh môže byť video.** Do 15 sekúnd; systémový výber ho rovno prekóduje
  vlastným hardvérom, takže z klipu je pár megabajtov a nie pár desiatok.
  Prehráva sa stlmene a dokola. Nad 25 MB to appka odmietne vetou, nie chybou
  z úložiska.
- **Keď pridáš príbeh, je to vidieť:** tvoj kruh sa rozsvieti ako každý iný a
  plusko zmizne. Ďalší príbeh sa pridáva zvnútra toho tvojho.

### Čo si k tomu musíš nastaviť

Nič, okrem dvoch nepovinných vecí:

- **Cron na príbehy** — riadok `blup-stories` v SPUSTENIE.md, kapitola o cron
  jobs. Bez neho príbehy **nikto neuvidí** po 24 hodinách (to zariaďuje každé
  čítanie), len sa riadky nebudú mazať.
- **`TENOR_API_KEY`** — ak chceš vyhľadávanie GIFov. Bez neho funguje posielanie
  vlastných GIFov a picker to povie nahlas.

---

Deväť vecí z predchádzajúceho zoznamu. Pri každej je aj to, čo presne bolo zle
— nie preto, aby to znelo dôkladne, ale aby si vedel, čo presne overiť.

**Objav a odporúčanie**

- **„Mohlo by ťa zaujímať" pri vzdialenom evente.** Keď je niečo ďalej, ale
  sedí ti to, event sám povie prečo sa oplatí ísť — koľko je to cesty, či tam
  ide niekto, koho poznáš, a či sa také niečo pri tebe vôbec deje. Keď niet čo
  povedať, nepovie nič; nepíše sa tam veta do každého eventu.
- **Prepracovaný ranking.** Deväť signálov namiesto piatich, vzdialenosť plynulo
  namiesto skoku na hranici, správanie s polčasom rozpadu 60 dní, „trending"
  ako rýchlosť a nie ako súčet. **A chyba, ktorá skrývala celé eventy:** záujmy
  sa porovnávali len s hlavnou kategóriou, takže event s kategóriami *hudba +
  techno* sa človeku, ktorý má rád techno, nezobrazoval ako zhoda.
- **Blup Connect, celý inak.** „Ľudí, ktorých možno poznáš" už nerobí
  vzdialenosť — teraz je to: kto sleduje teba, s kým máš spoločnú komunitu,
  s kým sa vzájomne sledujete, s kým si bol na tom istom evente. **Kto s tebou
  nemá nič spoločné, sa neukáže vôbec** (predtým to dopĺňalo náhodných ľudí
  z mesta). A koho odmietneš, ten sa už nevráti.

**Premium**

- **Zmena farby BLUPu.** Modrá, ružová, fialová, tyrkysová, jantárová, limetková
  — prefarbí sa celá appka. Po skončení predplatného sa vráti modrá a tvoja
  farba ostane uložená, takže sa po obnovení nemusí vyberať znova.
- **Pozadie chatu z vlastnej fotky**, odznak Premium pri mene, **dvojnásobné
  body**, **jedno boostnutie eventu týždenne zadarmo** a **„kto si pozrel tvoj
  profil"** — počet vidí každý, mená len Premium. Kto má zapnutý anonymný režim,
  ten sa nezapisuje vôbec.

**Boost**

- **Boost je teraz reklamný systém, nie prepínač.** Rozpočet v zobrazeniach,
  rozloženie v čase (aby sa celý neminul za hodinu), aukcia — ale **s podlahou
  relevancie: za peniaze sa nedá dostať pred niekoho vhodnejšieho.** Najviac
  3 sponzorované veci na človeka za deň a jeden „spotlight" denne celkovo.
- **Report, ktorý niečo hovorí:** dosah sú *ľudia*, nie zobrazenia, a vstupenka
  sa pripíše len tomu, kto na reklamu klikol a do 24 hodín kúpil. Vlastné
  prezeranie organizátorovi rozpočet neminie.

**Sedenie — a chyba, ktorá bola pod ním**

- **Miesto, ktoré si kupujúci vybral, mu po zaplatení ostalo.** Predtým nie:
  košík sa pri prechode na platbu maže, sedadlo viselo na ňom, takže sa **v tej
  sekunde vrátilo do predaja** — a vystavená vstupenka nemala na sebe žiadne
  miesto. Dvaja ľudia s lístkom na tú istú stoličku a nijaký spôsob zistiť,
  komu patrí. Sedadlo teraz putuje **košík → objednávka → vstupenka** a dve
  jedinečné obmedzenia v databáze robia druhý nárok nemožným, nie nepravdepodobným.
- **Číslovaný sektor sa už nedá kúpiť „naslepo".** Dvoje dvere to dovoľovali —
  nákup bez účtu (ten plán sály nikdy nevidí) a obyčajný zoznam vstupeniek.
  Obe sú zavreté.
- **„Nájdi nám miesta vedľa seba."** Vyberie najlepší súvislý blok — najbližší
  rad k pódiu, čo najbližšie k stredu — a drží ho celý alebo vôbec. Miesto pre
  vozík nikdy nerozdá partii, ktorá oň nežiadala.
- **Odpočet, dokedy ti miesto držíme** (predtým to ticho skončilo a človek sa
  to dozvedel pri platbe), **rozlíšenie „držíš" a „máš kúpené"** (vyzeralo to
  rovnako a klepnutie na kúpené nerobilo nič), **druhy miest** (vozík, sprievod,
  obmedzený výhľad) na pláne aj na vstupenke.
- **Plán sály sa dá upraviť.** Doteraz sa sektor dal len vytvoriť a zmazať —
  a zmazanie berie so sebou jeho miesta a s nimi rad a číslo z každej predanej
  vstupenky. Teraz sa dá premenovať, prefarbiť, posunúť aj prekresliť, a
  **prekreslenie odmietne zmazať miesto, ktoré už niekto kúpil**.
- **Plán sály bol nedostupný.** Karta, ktorá otvára editor, sa ukazovala len pri
  evente, ktorý plán už má — a jediná obrazovka, kde sa plán dá vytvoriť, je
  práve ten editor.
- **Zoznam „kto kde sedí"**, zoradený tak, ako sa prechádza sála, s voľnými
  miestami a exportom do CSV. V zozname „Kto príde" sa dá hľadať aj podľa
  miesta — pri vchode sa ľudia hľadajú podľa „rad D, štrnástka", nie podľa kódu.

**Plán sály, haly a štadióna — a kto ho kreslí**

- **Plán kreslí BLUP, nie organizátor.** Doteraz to smel ktokoľvek z organizácie
  a vyzeralo to štedro. Plán ale rozhoduje, čo sa predáva a za koľko: sektor
  o pár pixelov vedľa predá iné miesto, než na ktoré sa kupujúci pozeral, a
  sektor napojený na zlý typ vstupenky predá inú cenu. **Organizátor má teraz pri
  evente „Požiadať o plán sály"** — napíše, ako sála vyzerá, príde nám to do
  fronty (*Admin → Žiadosti o plán sály*) a keď je hotovo, dostane upozornenie.
  Pravidlo drží na troch miestach naraz, lebo do plánu vedú tri cesty: funkcie,
  priamy zápis cez API, a priradenie hotového plánu na event.
- **Sektor má druh.** *Sedenie, VIP, Lóža, Státie, Miesta pre vozík* — a k tomu
  *Pódium, Bar, Vstup, Iné*, ktoré sa **nepredávajú**: nakreslia sa na plán, aby
  sa kupujúci vedel zorientovať. Plán sály bez pódia je mriežka obdĺžnikov, v
  ktorej sa nikto nevyzná. Druh rozhoduje o farbe aj o tom, čo kupujúci číta
  vedľa ceny, a **pódium s cenou databáza odmietne** — nie obrazovka.
- **Poznámka pre kupujúceho pri sektore**: „Vlastný vstup, obsluha pri stole".
- **Nákup ide cez plán.** Pri evente, ktorý má plán sály, vedie tlačidlo
  *Kúpiť* rovno naň — nie na zoznam názvov vstupeniek. Nad plánom je **legenda
  cien**: farba a k nej suma, lebo plán sa číta najprv podľa farby („tie zelené
  sú za 990") a inak človek háda, ktorý obdĺžnik čo stojí.
- **Bodky až po klepnutí na sektor.** Na celom pláne nie sú žiadne — sú tam len
  sektory. Keď na niektorý klepneš, **otvorí sa cez celú šírku plánu** a až vtedy
  sa v ňom vykreslia miesta, takže naraz nikdy nevidíš viac ako jeden sektor a
  bodky sú dosť veľké na to, aby sa do nich dalo trafiť palcom. Keď je rad
  natoľko široký, že by sa ani po zväčšení nedalo do bodky trafiť — a to závisí
  od šírky displeja, nie od počtu miest — vyberá sa po radoch: najprv rad, potom
  miesto v ňom.
- **Štadión sa zmestí do telefónu.** Plán vracal každé sedadlo každého sektora
  v jednom JSON-e: pri divadle 400 objektov, pri štadióne 20 000 a niekoľko
  megabajtov — len aby sa nakreslil jeden sektor. Teraz plán nesie tvar a počty
  a miesta sa načítajú až pre sektor, ktorý si otvoril.
  **Plán štadióna s 8 000 miestami má ~2 kB.**
- **Tá istá hala o mesiac.** Sektor je naviazaný na typ vstupenky a ten patrí
  jednému eventu, takže hala, ktorá hrá päťdesiatkrát do roka, by sa kreslila
  päťdesiatkrát. Plán sa teraz dá **skopírovať na iný event** a sektory sa
  napoja na jeho typy vstupeniek **podľa názvu** — „VIP" nájde „VIP". Podľa
  poradia alebo ceny by to bol odhad a zlý odhad tu predá lacné miesta za drahú
  cenu.

**Nával ľudí, veľa registrácií, veľa e-mailov**

- **Čakačka na vypredanú vstupenku.** Keď sa niečo uvoľní, dáme vedieť **presne
  toľkým ľuďom, koľko je vstupeniek** — v poradí, ako sa prihlásili. Nič
  nedržíme a e-mail to aj hovorí. Funguje aj bez účtu, stačí adresa.
- **Pozvánky.** Každý má svoj kód. **Za registráciu sa neplatí nič** — body
  prídu, až keď pozvaný človek potvrdí e-mail a naozaj si niečo kúpi alebo
  niekam príde. Desať za mesiac na jedného pozývajúceho.
- **Organizátor vie napísať ľuďom, ktorí u neho boli.** Tým, čo majú vstupenku
  na tento event; tým, čo sa prihlásili; alebo tým, čo u neho niekedy boli.
  **Počet uvidí pred odoslaním** a potvrdenie ho povie nahlas. Tri rozposlania
  za deň, a len overená organizácia.
- **Odhlásenie jedným klikom priamo z e-mailu** — bez prihlásenia, aj pre
  človeka, ktorý účet nikdy nemal. Gmail aj Yahoo to na hromadnej pošte
  vyžadujú a bez toho sa e-maily filtrujú ako spam.
- **Strop na hodinu, a vstupenky idú vždy prvé.** Rozposielanie nikdy nezdrží
  vstupenku niekomu, kto stojí pri vchode. Nastavuje sa v *Admin → Poplatky
  a sadzby*.
- **Nedoručiteľná adresa sa už neskúša.** Jeden tvrdý odraz opakovaný
  päťkrát naprieč tisíckami riadkov je presne to, čím sa zabíja doména.

**✓ Rýchla kontrola po nasadení**

```sql
-- sedenie: predaná vstupenka musí mať na sebe miesto
select t.code, vs.row_label, vs.seat_number
from public.tickets t
join public.venue_seats vs on vs.id = t.venue_seat_id
limit 5;

-- e-maily: koľko ich smie odísť a koľko čaká
select public.email_queue_stats();      -- spusti ako admin

-- čakačka: komu by sa práve teraz písalo (nič neodošle, kým nebeží cron)
select public.waitlist_size('<ticket-type-id>');

-- plán sály: ako veľký je ten JSON, ktorý si stiahne telefón
select length(public.seat_map_for_event('<event-id>')::text);   -- kilobajty, nie megabajty

-- a že organizátor plán naozaj kresliť nemôže (spusti ako organizátor)
select public.assert_can_manage_venue_map(null);   -- musí skončiť VENUE_PLAN_IS_ADMIN_ONLY
```

---

## Čo bolo nové v balíku pred týmto

Zo šiestich vecí z tvojho testovania. Pri každej je aj to, čo presne bolo zle.

**Vstupenky**

- **Vidíš, kto príde.** *Organizátor → pri evente „Kto príde"* (a aj zo
  *Štatistík eventu*): zoznam s **menom, adresou, na ktorú vstupenka odišla, a
  kódom vstupenky**. Nad ním počty — platné, použité, neplatné. Hľadá sa v ňom
  podľa mena, e-mailu aj kódu.
- **Jednu vstupenku sa dá vypnúť a zase zapnúť.** Deaktivovaná vstupenka
  **naozaj neprejde pri vstupe** — skener odmieta všetko, čo nie je platné —
  a držiteľovi príde upozornenie s dôvodom, ktorý napíšeš. Znovuaktivovanie
  zmaže aj odbavenie, takže vstupenka funguje ešte raz a potom je *použitá*.
  Vrátená (refundovaná) vstupenka sa znovu zapnúť nedá; to je rozhodnutie o
  peniazoch, nie o dverách.
- Kto to smie: **tvorca eventu, majiteľ/admin/event manager organizácie a
  admin BLUPu.** Nikto iný tie mená a adresy ani neuvidí — kontrola je v
  databáze, nie v appke. Každé vypnutie a zapnutie sa zapisuje do auditu.

**Objav**

- **„Stojí za cestu."** Keď si z Nitry a v Bratislave je koncert, ktorý sedí na
  tvoj vkus a ide naň veľa ľudí, uvidíš ho na domovskej stránke vo vlastnom
  páse. Berie sa 50 – 220 km a len to, čo prejde cez dosť vysokú latku — inak by
  to bol druhý feed, nie tip.

**Vytváranie eventu**

- **Tlačidlá v orezávaní fotky majú konečne text.** Boli tam celý čas: nápis mal
  farbu `accentText`, čo je **tá istá modrá ako pozadie tlačidla**, takže modré
  písmená na modrom tlačidle. A skratka `font: 700 15px/1 inherit` je neplatná,
  takže ju prehliadač zahodil celú. Teraz je popis biely a veľkosť sa nastavuje
  po vlastnostiach.
- **Admin vie pridať event „ako BLUP".** Pri vytváraní eventu je prepínač
  *Pridať ako BLUP* a dve políčka: **kto to naozaj organizuje** a **odkaz na
  zdroj**. Tak sa dajú na začiatku ručne pridávať cudzie eventy bez toho, aby
  to vyzeralo, že ich robíme my. Na taký event sa nedajú predávať vstupenky —
  cudzie peniaze cez náš účet nepotečú.

**Na telefóne**

- **Potiahnutie nadol obnoví stránku.** Nefungovalo z dvoch dôvodov naraz:
  súbor `usePullToRefresh.ts` prekrýval webovú verziu `.web.tsx` (**tá istá
  pasca s príponami ako pri cookies** — Metro berie prvú príponu, `ts` je pred
  `tsx`), a keď sa to odkrylo, poslucháči sa odpájali a pripájali pri každom
  vykreslení — nameraných **728-krát ešte pred prvým dotykom**, takže pohyb
  prsta pristál na už zrušenom poslucháčovi. Aby sa to nestalo tretíkrát,
  `scripts/check-platform-files.mjs` odteraz odmietne dvojicu súborov s
  rozdielnou príponou.

**E-maily so vstupenkami**

- Queue je v poriadku a testy to pokrývajú — **chýba nasadenie a cron**. Aby to
  už nebolo neviditeľné: *Admin → prehľad* ukazuje **koľko e-mailov čaká, ako
  starý je najstarší a koľko zlyhalo**. Keď najstarší čaká dlhšie ako 10 minút,
  cron nebeží. Rýchla kontrola z príkazového riadka: `./scripts/check-emails.sh`.

**Nahrávanie webu**

- **`blup-config.js` vedľa `index.html`.** Build si doteraz zapiekol adresu
  backendu v momente, keď vznikol — a balík vyrobený proti lokálnej databáze sa
  na doméne načíta úplne v poriadku a **nehovorí s ničím**. Tichšie to zlyhať
  nevie. Odteraz sa dá ten istý balík nasmerovať prepísaním jedného súboru na
  hostingu, bez buildovania. Nič tajné v ňom nie je — `anon key` si aj tak
  stiahne každý návštevník a dáta chráni RLS. `service_role` tam nepatrí a
  kontrola `check-origin --dist` to odmietne.

**✓ Rýchla kontrola po nasadení**

```sql
-- kto príde na event (spusti ako organizátor, nie service_role)
select code, holder_name, email, status
from public.event_ticket_holders('<event-id>');

-- vypnutie jednej vstupenky
select status from public.set_ticket_active('<ticket-id>', false, 'test');
-- ... a skener ju musí odmietnuť
select public.check_in_ticket('<kod>', '<qr_secret>');   -- reason: CANCELLED
```

---

## Čo bolo nové ešte predtým

Toto je zoznam vecí z tvojho posledného testovania. Pri každej je aj to, čo
presne bolo zle — nie preto, aby to znelo dôkladne, ale aby si vedel, čo presne
overiť.

**Peniaze a vstupenky**

- **DPH.** Zapína sa v *Organizátor → Verejný profil a logo → DPH*, sadzba je
  prednastavená na 23 %. **Kupujúci vidí a platí plnú sumu** — pri cene mu
  pribudne len poznámka `(s DPH 23 %)`, na vstupenke, v košíku aj v pokladni.
  **Rozpad brutto / netto / DPH vidíš len ty**, v *Účtovníctve* a v štatistike
  eventu. Počíta sa z celej tržby za obdobie, nie sčítaním zaokrúhlení po
  vstupenkách, takže to sedí s tým, čo ide do priznania.
- **Na jednu objednávku ide najviac 10 vstupeniek** (bolo 20). Číslo je v
  `platform_settings.max_tickets_per_order`, dá sa zmeniť bez nasadenia.
- **Plávajúci košík.** Po pridaní vstupenky ťa sleduje bublina s počtom; po
  kliknutí ponúkne *Prejsť do pokladne* alebo *Pokračovať v nákupe*. Predtým to
  bolo len číslo v bočnom menu, ktoré si nikto nevšimol — a rezervácie medzitým
  ticho vypršali.
- **Onboarding výplat** už nemlčí. Ak organizácia ešte nie je overená, pošle ťa
  rovno na formulár overenia; ak zlyhá čokoľvek iné, napíše čo.

**Zobrazenia**

- **Zobrazenie sa počíta, len keď niekto otvorí event.** Predtým sa počítalo aj
  pri prejdení kartou vo feede, a navyše sa zapisovalo vo funkcii, ktorá načítava
  event — takže jedno otvorenie pripočítalo tri. Nová verzia počíta jedného
  návštevníka raz za pol hodiny.

**Vytváranie eventu**

- **Naozajstný kalendár a hodiny** namiesto písania `YYYY-MM-DD`.
- **Návrhy adries počas písania**; Enter adresu potvrdí a **špendlík sa naozaj
  presunie** tam, kde adresa je.
- **Mapa v evente** ukazuje event, nie miesto, kde práve stojíš.
- Pri *Viac dní* už nie je nad políčkom napísané „Koniec Začiatok".
- **Titulná fotka** si drží svoje proporcie, malú fotku nezväčšuje a formulár
  píše odporúčaný rozmer aj to, čo sa naozaj nahralo.
- **Voľba spôsobu predaja (po sektoroch a miestach) je zatiaľ vypnutá**, ako si
  písal. Kód pre sedadlá ostáva v projekte, len sa naň z formulára nedá dostať.

**Vzhľad**

- **Karta ukazuje celý plagát**, nie výrez zo stredu. Čo sa nezmestí, leží na
  rozmazanej kópii tej istej fotky namiesto sivých pruhov.
- **Karty sa už neroztiahnu** cez celú šírku monitora — a to platí pre feed aj
  pre swipovanie.
- **Komentáre a Spoločné plány** sú zarovnané na stred, nadpisy tiež.
- **Prechod medzi stránkami** modro prebliskne a skeletony pulzujú tou istou
  modrou.

**Feed**

- Novo vytvorený event sa **objaví vo feede hneď**, nie až keď vyprší cache.
- **Organizátor môže písať na feed pod menom svojej organizácie.** Autorom
  zostáva človek — za každý príspevok niekto ručí — ale zobrazí sa logo a názov
  organizácie. Podpísať príspevok cudzou organizáciou databáza nedovolí.

**Mazanie a prázdne stránky**

- **„Zmazať natrvalo" naozaj maže.** Pod RLS nie je odmietnuté zmazanie chyba,
  je to zmazanie nula riadkov — appka si teraz prečíta, čo skutočne odišlo, a
  event vyhodí zo všetkých cache, kým odíde z obrazovky.
- **Pád obrazovky končí na chybovej stránke s tlačidlom *Skúsiť znova*.**
  Doteraz nebola žiadna — jediná chyba pri vykresľovaní nechala bielu stránku a
  jediná cesta von bol refresh. Presne to, čo si opisoval.

**Cookies a pätička**

- **Lišta o cookies naozaj funguje.** A tu je horšia časť: doteraz nefungovala
  vôbec. Súbor s natívnou (prázdnou) verziou meracieho modulu prekrýval webovú
  verziu — Metro berie prvú príponu, na ktorú narazí, a `ts` je pred `tsx` —
  takže na webe sa načítala prázdna verzia. **Nenačítal sa žiadny pixel a lišta
  sa nikdy neukázala**, práve na jedinej platforme, kde cookies vôbec sú.
  Premenovaním súboru je to vyriešené a `scripts/smoke-cookies.mjs` to odteraz
  overuje v prehliadači, aby to znova nestíchlo.
- **Zásady cookies** sú štvrtý právny dokument a idú v migrácii ako ostatné.
  Popisujú, čo BLUP naozaj ukladá — prihlásenie, košík, odpoveď na lištu — a čo
  sa načíta až po súhlase.
- **Pätička na každej stránke**: právne dokumenty, *Aktualizovať nastavenia
  cookies* (lišta sa otvorí znova a odpoveď sa dá prepísať) a údaje
  prevádzkovateľa.
- **Údaje prevádzkovateľa** vyplníš v *Admin → Poplatky a sadzby →
  Prevádzkovateľ*: obchodné meno, sídlo, IČO, IČ DPH, kontakt. **Nič sa
  nedopĺňa za teba** — čo nevyplníš, sa nezobrazí. Bez obchodného mena, sídla a
  IČO nie je stránka v EÚ v poriadku, tak si na to vyhraď dve minúty.

**Drobnosti**

- Enter potvrdzuje aj zľavový kód, sumu výplaty, názov partie a názov
  organizátora.
- Tlačidlá pod nadpismi v organizátorskej sekcii sú užšie a na strede.
- „Vytvor BLUP" sa volá **„Vytvor event"**.

**✓ Rýchla kontrola po nasadení**

```sql
-- zobrazenia sa počítajú raz za pol hodiny na návštevníka
select public.cart_limits();          -- max_tickets_per_order musí byť 10
select public.vat_split(1200, 2300);  -- 976 netto, 224 DPH

-- štyri právne dokumenty vrátane cookies
select kind from public.legal_documents where published_at is not null;
```

A v prehliadači: dole na stránke klikni na **Aktualizovať nastavenia cookies** —
musí sa objaviť lišta s dvoma rovnocennými tlačidlami.

---

## 1 · Databáza (3 minúty)

```bash
npx supabase db push
```

Aplikuje sa **36 nových migrácií** (počítané od verzie, v ktorej si hlásil tie
chyby) — 26 z predošlých balíkov a 10 z tohto. Existujúce tabuľky sa nemažú ani
neprepisujú; pridávajú sa stĺpce, tabuľky (`stories`, `story_views`) a funkcie.

Nemusíš mi to veriť — `db push` sám vypíše, ktoré aplikuje, a čo je už v
databáze preskočí. Zoznam toho, čo tam už je, si pozrieš takto:

```bash
npx supabase migration list
```

Tri z nich sa dotknú tvojich dát, tak nech vieš, čo robia:

**Adresy eventov.** Každý event dostane `slug` z názvu. **Staré odkazy s uuid
fungujú ďalej** — nič, čo si komu poslal, neprestane fungovať.

**Prepočet počítadiel.** Toto je dôležité. V starej verzii bola chyba, ktorá
držala `attendee_count`, `view_count` a ďalšie na nule — preto mapa hlásila
„0 ide". Oprava mechanizmu by sama od seba staré eventy nespravila; opravili by
sa až pri ďalšom prihlásení, čo pri prebehnutom evente nenastane nikdy. Migrácia
ich preto **prepočíta zo zdrojových tabuliek**, ktoré boli celý čas správne.
Vypíše, koľkých eventov sa to týkalo:

```
NOTICE:  Counters recomputed on 42 events
```

Zobrazenia sa nikdy neznížia — ak databáza pozná viac, než je v `event_views`,
nechá si vyššie číslo.

**Košík.** Jedno obmedzenie sa mení na čiastočný index, aby sa dali držať
konkrétne sedadlá. Ak má niekto práve otvorený košík, rezervácia mu vydrží.

**✓ Kontrola:**

```sql
select count(*) from public.legal_documents where published_at is not null;
-- musí vrátiť 3

select count(*) from public.events where slug is null;
-- musí vrátiť 0
```

---

## 2 · Serverové funkcie (2 minúty)

```bash
npx supabase functions deploy
```

Nasadí sa **19 funkcií**, z toho tri nové:

- **`og`** — náhľad odkazu na Instagrame a vo WhatsApp. Bez nej sa zdieľané
  eventy budú ďalej zobrazovať s generickou kartou.
- **`gif-search`** — vyhľadávanie GIFov v chate. **Nepovinná.** Bez nej (alebo
  bez `TENOR_API_KEY`) picker povie, že vyhľadávanie nie je nastavené, a
  posielanie vlastných GIFov z fotiek funguje aj tak. Kľúč sa nastavuje cez
  `npx supabase secrets set TENOR_API_KEY=…` a **nikdy nesmie ísť do appky** —
  kľúč v nahratom JavaScripte si vie ktokoľvek vybrať a míňať.
- **`unsubscribe`** — odkaz na konci každého newslettera. **Nasadzuje sa bez
  overovania tokenu** (skript to robí sám, `--no-verify-jwt`), pretože naň
  kliká človek v poštovom klientovi, ktorý účet často ani nemá. Bez nej každé
  odhlásenie zlyhá — a to je sťažnosť na spam aj podľa GDPR.

A **`ticket-email` sa výrazne mení**: rozposiela teraz celý front, nielen
vstupenky. Bez jej nasadenia neodíde žiadne upozornenie z čakačky ani žiadne
rozposielanie od organizátora.

Nové premenné prostredia netreba. Ak si už raz spustil `supabase secrets set`,
funkcie si ich načítajú samy.

**✓ Kontrola:**

```bash
curl "https://<project-ref>.supabase.co/functions/v1/og?ref=test"
```

Musí vrátiť HTML s `og:title`, nie chybu.

---

## 3 · Web (10 minút, väčšinou čakanie)

```bash
cd mobile
npm install
npm run build:web
```

`npm install` je tu preto, že pribudli závislosti. Build vypíše na konci, koľko
pravidiel pre náhľady zapísal — ak uvidíš varovanie o `EXPO_PUBLIC_SUPABASE_URL`,
`mobile/.env` nie je vyplnený a **náhľady odkazov fungovať nebudú**.

Potom nasaď obsah `mobile/dist` tak, ako si zvyknutý:

```bash
# Vercel
cd dist && vercel --prod

# Websupport — cez FTP, celý obsah dist do web/, aj skryté súbory
```

> **Nahraj `.htaccess` znova.** Vygeneroval sa nanovo a **pribudli v ňom
> pravidlá pre náhľady odkazov**. Starý súbor by fungoval, ale Instagram by
> ďalej ukazoval generickú kartu.

> **A pozri sa do `blup-config.js`.** Leží vedľa `index.html` a načíta sa skôr
> než appka. Ak si buildoval s vyplneným `mobile/.env`, netreba v ňom nič meniť
> — prázdne hodnoty sa ignorujú. Ak buildoval niekto iný alebo si si nie istý,
> vyplň v ňom `supabaseUrl` a `supabaseAnonKey` (Supabase → *Project Settings →
> API*) a `webUrl` na `https://blup.sk`. Je to jediný súbor, ktorý sa dá na
> hostingu prepísať bez buildovania.
>
> **Service_role key tam nepatrí.** Ani Stripe secret key. Tento súbor si
> stiahne každý návštevník — presne ako celý zvyšok JavaScriptu.

**✓ Kontrola:** otvor `https://blup.sk` a pozri sa na názov v záložke
prehliadača. Musí byť **„Blup — eventy okolo teba"**, nie `blup.sk`. Ak vidíš
`blup.sk`, na server sa dostal starý build.

Ešte istejšia kontrola, pred nahratím:

```bash
node scripts/check-origin.mjs --dist
```

Odmietne build, ktorý ukazuje na `127.0.0.1`, aj taký, kde `blup-config.js` leží
v priečinku a stránka ho vôbec nenačíta.

---

## 4 · Nastavenia, ktoré si možno ešte nespravil (5 minút)

Tieto sa nedajú nasadiť z kódu — sú v Supabase.

| Kde | Čo | Prečo |
| --- | --- | --- |
| **Authentication → URL Configuration** | `Site URL` = `https://blup.sk` | Inak potvrdzovací odkaz v e-maile vedie na `localhost` |
| **Authentication → Emails → SMTP** | Resend, podľa Fázy 5c v `SPUSTENIE.md` | Bez toho chodia 2 e-maily za hodinu a len členom tímu |
| **Authentication → Rate Limits** | *Emails per hour* z `2` na `100` | Tretia registrácia v hodine inak ticho odpadne |
| **SQL Editor** | Tri nové cron joby (`blup-waitlist`, `blup-invites`, `blup-stories`) | Fáza 8 v `SPUSTENIE.md`. Bez prvých dvoch sa nikdy nikomu neozveme, že sa uvoľnila vstupenka, a body za pozvánky nikto nedostane. Bez `blup-stories` sa vypršané príbehy nikomu nezobrazujú (to rieši každé čítanie), len sa riadky a obrázky nemažú |
| **Edge Functions → Secrets** | `TENOR_API_KEY` — **nepovinné** | Len na vyhľadávanie GIFov v chate. Bez neho picker povie, že nie je nastavené, a vlastné GIFy z fotiek fungujú |
| **Admin → Poplatky a sadzby** | `email_per_hour` (predvolene 500) | Strop na hodinu. Vstupenky idú vždy prvé, takže rozposielanie nikdy nezdrží vstupenku |
| **Authentication → Providers → Google** | Client ID a Secret | Tlačidlo sa objaví samo, keď je zapnuté |

---

## Čo sa po aktualizácii zmení pre ľudí, ktorí už appku používajú

Nič sa im nestratí — účty, vstupenky ani uložené eventy. Zmení sa toto:

- **Adresy eventov** sa im v prehliadači prepíšu na čitateľné. Staré fungujú ďalej.
- **Profily** odpovedajú aj na `@meno`.
- **Počítadlá** prestanú ukazovať nuly — u eventov, kde ich mali, čísla naskočia naraz.
- **Feed** má tri záložky a otvorí sa na tej, kde niečo je.
- **Pri registrácii** treba súhlas s podmienkami; existujúcich používateľov sa to netýka.
- **Plán sály** už organizátor nekreslí. Ak ho niekto z nich mal rozkreslený,
  **nič sa nezmaže** — len ho ďalej upravuje admin. Organizátorovi sa pri evente
  namiesto editora ukáže „Požiadať o plán sály".
- **Organizátori** musia pri ďalšom overení prijať zmluvu. Už overené organizácie
  bežia ďalej, ale zmluvu podpísanú nemajú — ak ju chceš aj od nich, pošli im
  odkaz na `/legal/agreement` a nechaj ich prejsť overením znova.

---

## Keď sa niečo pokazí

| Príznak | Čo s tým |
| --- | --- |
| `db push` sa zastaví na chybe | Nič sa nezapísalo — Postgres migráciu vracia celú. Pošli mi text chyby. |
| Počítadlá stále na nule | Migrácia `20260101003800` nedobehla; pusti `npx supabase db push` znova a sleduj `NOTICE: Counters recomputed` |
| V záložke je `blup.sk` | Na serveri je starý build — nahraj `dist` znova |
| `/event/nieco` vracia 404 | Nenahral sa `.htaccess` (FTP ho skrýva) alebo `vercel.json` |
| Náhľad na Instagrame je generický | Buď chýba nasadená funkcia `og`, alebo je na serveri starý `.htaccess` |
| Potvrdzovací odkaz vedie na localhost | `Site URL` v Supabase, krok 4 |

---

## Ak si chceš byť istý pred nasadením

```bash
./scripts/verify-db.sh
```

Postaví dočasnú databázu, aplikuje **všetkých 106 migrácií od nuly** a prejde
**478 tvrdení**. Tvojej databázy sa to nedotkne. Ak toto prejde a `db push`
potom zlyhá, chyba je v tvojich dátach, nie v schéme — a to je pri hľadaní
veľmi cenné vedieť.
