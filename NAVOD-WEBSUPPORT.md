# ENZO — návod na nasadenie na Websupport

Web je vyexportovaný ako obyčajné HTML, CSS, JavaScript a obrázky. **Nepotrebuje
žiadnu databázu, PHP ani Node.js** — funguje na najlacnejšom webhostingu.
Stačí nahrať obsah balíka do priečinka webu.

Balík: **`enzo-web.zip`** (~7,5 MB)

---

## Rýchly prehľad — 6 krokov

| # | Krok | Kde |
|---|---|---|
| 1 | Rozbaliť `enzo-web.zip` | vo svojom počítači |
| 2 | Nahrať **obsah** priečinka do `web/` | Websupport → Súbory |
| 3 | Skontrolovať, že je tam aj `.htaccess` | Websupport → Súbory |
| 4 | Nasmerovať doménu na hosting | Websupport → Domény |
| 5 | Zapnúť bezplatný SSL certifikát | Websupport → SSL |
| 6 | Otvoriť web a otestovať objednávku | prehliadač |

---

## 1. Rozbalenie balíka

Rozbaľ `enzo-web.zip`. Vznikne priečinok, v ktorom nájdeš:

```
index.html                 úvodná stránka
404.html                   stránka pre neexistujúcu adresu
.htaccess                  nastavenia servera (HTTPS, kompresia, cache)
robots.txt, sitemap.xml    pre vyhľadávače
favicon.svg, og.jpg …      ikony a náhľadový obrázok pre sociálne siete
pokladna/                  pokladňa
objednavka/                potvrdenie objednávky
podmienky/                 obchodné podmienky
ochrana-osobnych-udajov/   ochrana osobných údajov
images/                    fotografie jedál
brand/                     logá na stiahnutie (SVG + PNG)
_next/                     štýly a skripty webu
```

> **Dôležité:** nahrávaš **obsah** tohto priečinka, nie priečinok samotný.
> Na hostingu musí `index.html` ležať priamo v `web/`, nie v `web/enzo-web/`.

---

## 2. Nahratie na hosting

### Cez Websupport administráciu (najjednoduchšie)

1. Prihlás sa na [admin.websupport.sk](https://admin.websupport.sk).
2. Vľavo vyber **Webhosting → Súbory** (Správca súborov).
3. Otvor priečinok **`web`** — to je verejný priečinok domény.
   *(U starších balíkov sa môže volať `public_html` alebo `www`.)*
4. Ak sú v ňom nejaké staré súbory (napr. `index.html` s uvítacou stránkou),
   **označ ich a vymaž**.
5. Klikni **Nahrať** a vlož celý rozbalený obsah.
   Správca súborov vie nahrať aj ZIP a rozbaliť ho priamo na serveri —
   ak túto možnosť ponúka, nahraj `enzo-web.zip` do `web/`, rozbaľ ho tam
   a potom **presuň obsah o úroveň vyššie**, aby `index.html` bol priamo v `web/`.

### Cez FTP (rýchlejšie pri veľa súboroch)

Prístupové údaje nájdeš vo Websupporte v **Webhosting → FTP účty**.

| Položka | Hodnota |
|---|---|
| Server | `ftp.tvojadomena.sk` (alebo podľa Websupportu) |
| Používateľ | z administrácie |
| Heslo | z administrácie |
| Port | 21 (FTP) alebo 22 (SFTP) |
| Cieľový priečinok | `/web` |

Odporúčaný program: [FileZilla](https://filezilla-project.org) (zdarma).
Vľavo otvor rozbalený priečinok, vpravo `/web`, označ všetko vľavo
a presuň doprava.

---

## 3. Kontrola `.htaccess`

Súbor `.htaccess` sa začína bodkou, takže ho niektoré programy **skrývajú**.

- **FileZilla:** menu *Server → Vynútiť zobrazenie skrytých súborov*
- **Správca súborov Websupport:** väčšinou zobrazuje aj skryté súbory

Skontroluj, že `.htaccess` je v `web/`. Zabezpečuje:

- automatické presmerovanie na **https://**
- **kompresiu** stránok (rýchlejšie načítanie)
- **cache** obrázkov a skriptov
- vlastnú **404** stránku
- základné bezpečnostné hlavičky

Web funguje aj bez neho, ale bude pomalší a bez automatického HTTPS.

---

## 4. Doména

Vo Websupporte v **Domény → tvoja doména** skontroluj, že je nasmerovaná
na tento hosting (`A` záznam smeruje na IP hostingu).

Ak je doména vedená inde, nastav u toho poskytovateľa nameservery
podľa pokynov Websupportu.

Zmena sa prejaví obvykle do 1 hodiny, výnimočne do 24 hodín.

---

## 5. SSL certifikát (https)

Websupport dáva Let's Encrypt certifikát zdarma.

**Webhosting → SSL certifikáty → Aktivovať Let's Encrypt**

Bez neho prehliadače zobrazia „Nezabezpečené" a zákazníci odídu.
Po aktivácii sa vďaka `.htaccess` návštevník automaticky presmeruje na `https://`.

---

## 6. Kontrola po nasadení

Prejdi si na mobile aj na počítači:

- [ ] `https://tvojadomena.sk` sa načíta a zobrazí ENZO
- [ ] visí zámok (https) v adresnom riadku
- [ ] menu sa prepína medzi kategóriami (Burgers, Pizza, Chicken…)
- [ ] klik na produkt otvorí detail, dá sa pridať do košíka
- [ ] košík počíta správne, prežije obnovenie stránky (F5)
- [ ] pokladňa vypíše chyby pri prázdnom formulári
- [ ] objednávka prejde a zobrazí potvrdenie s číslom
- [ ] „Vytlačiť potvrdenie" otvorí tlačový náhľad
- [ ] `https://tvojadomena.sk/neexistuje` zobrazí ENZO 404 stránku

---

## Ako to funguje — čo web robí a čo nie

**Web zbiera objednávky do prehliadača zákazníka.** Ukladá ich do lokálneho
úložiska (`localStorage`) na jeho zariadení a zobrazí potvrdenie s číslom
objednávky. **Objednávka sa zatiaľ neposiela k vám** — na to treba doplniť
backend (pozri poslednú sekciu).

**Platba kartou nie je napojená.** Objednávka sa označí ako „zaplatená (demo)"
a zákazník je na to výslovne upozornený v pokladni aj na potvrdení.
Žiadne peniaze sa nestrhávajú.

Kým nie je doplnený backend, dávaj do popredia telefónne číslo — web
funguje ako moderné online menu s košíkom, ktorý si zákazník vie
vytlačiť a nadiktovať.

---

## Čo doplniť pred ostrým spustením

| Vec | Kde |
|---|---|
| **Cena Kofoly** — v tlačenom menu nebola, teraz je 2,00 € | `src/lib/products.ts` → `kofola-original` |
| **E-mail** — teraz `objednavky@enzo.sk` | `src/lib/config.ts` → `RESTAURANT.email` |
| **Instagram a Facebook** — teraz vedú na prázdne odkazy | `src/lib/config.ts` |
| **Rozvozové obce** — over zoznam a poplatok | `src/lib/config.ts` |
| **Fotografie jedál** — teraz zástupné stock fotky | `public/images/products/` |
| **Právne texty** — vzorové, daj skontrolovať | `src/app/podmienky/` |

---

## Ako zmeniť menu alebo ceny

Všetko podstatné je v dvoch súboroch.

### Ceny, popisy, nové položky — `src/lib/products.ts`

Jedna položka = jeden záznam:

```ts
{
  id: "pizza-margherita",              // musí byť unikátne
  name: "MARGHERITA",
  description: "Pomodoro, mozzarella, bazalka",
  price: 8.0,                          // bodka, nie čiarka
  category: "pizza",
  image: "/images/products/pizza-margherita.webp",
  imageAlt: "Pizza Margherita s bazalkou",
  extras: PIZZA_EXTRAS,                // voliteľné doplnky
}
```

Kategórie, taby aj počty v taboch sa dopočítajú samy.

### Adresa, hodiny, poplatky — `src/lib/config.ts`

```ts
phone: "0948 238 346",
hours: [{ days: "Pondelok — Štvrtok", time: "11:00 — 21:00" }, …],
deliveryFee: 2.5,          // poplatok za rozvoz
freeDeliveryFrom: 35,      // rozvoz zdarma od tejto sumy
minOrder: 12,              // minimálna objednávka
```

### Po úprave treba web znova vygenerovať

```bash
npm install      # iba prvýkrát
npm run build    # vytvorí priečinok out/
```

Obsah priečinka `out/` nahraj znova do `web/`. Alebo si daj úpravu
spraviť tomu, kto ti web spravuje — je to práca na pár minút.

---

## Aktualizácia už bežiaceho webu

1. Uprav `products.ts` alebo `config.ts`
2. `npm run build`
3. Nahraj obsah `out/` do `web/` a prepíš existujúce súbory
4. V prehliadači daj **Ctrl + F5** (tvrdé obnovenie)

Priečinok `_next/` sa mení pri každom builde — nahraj ho vždy celý.
Staré súbory v `_next/` môžeš pokojne zmazať.

---

## Logá na stiahnutie

V `brand/` (a aj na webe na `/brand/…`) nájdeš:

| Súbor | Použitie |
|---|---|
| `enzo-wordmark-burgundy.svg` / `.png` | hlavné logo na svetlom podklade |
| `enzo-wordmark-cream.svg` / `.png` | logo na bordovom podklade |
| `enzo-wordmark-black.svg`, `-white.svg` | jednofarebné verzie (pečiatka, výšivka, fólia) |
| `enzo-wordmark-*-transparent.svg` | bez pozadia — na fotky a obaly |
| `enzo-badge-burgundy.svg` / `-cream.svg` | kruhový odznak na obaly a nálepky |
| `enzo-lockup-horizontal.svg` | vodorovná verzia do hlavičky dokumentov |

**SVG** sú skutočné krivky (text je prevedený na tvary), takže sa dajú
zväčšiť na akúkoľvek veľkosť — na billboard aj na pečiatku. Otvoria sa
v Illustratore, Inkscape, CorelDRAW aj vo Figme.
**PNG** sú vyrenderované v ~2 400 px šírke s priehľadným pozadím —
stačia na sociálne siete aj bežnú tlač.

Farby značky:

| | HEX | Použitie |
|---|---|---|
| Bordová | `#7A1E1E` | hlavná farba |
| Krémová | `#F6F0E3` | podklad, text na bordovej |
| Čierna | `#111111` | text |
| Horčicová | `#E1B12C` | akcent, šachovnica |

Písma: **Alfa Slab One** (wordmark ENZO) a **Archivo / Archivo Black**
(nadpisy a text) — obe sú zdarma na [fonts.google.com](https://fonts.google.com).

---

## Keď budeš chcieť objednávky naozaj prijímať

Web je na to pripravený — logika je oddelená od vzhľadu, takže stačí
doplniť tri veci:

1. **Odoslanie objednávky na server alebo e-mail**
   `src/lib/order.ts` → funkcia `saveOrder()` ukladá lokálne;
   nahradí sa volaním `POST /api/orders` alebo odoslaním e-mailu.
2. **Platobná brána** (napr. GoPay, Besteron, Stripe)
   `src/components/checkout/PaymentSelector.tsx` a krok odoslania
   v `Checkout.tsx`.
3. **Zobrazenie objednávok pre kuchyňu** — jednoduchá admin stránka
   alebo posielanie na tlačiareň.

Body 1 a 2 vyžadujú hosting s Node.js (Websupport ho má vo vyšších
programoch) alebo samostatnú malú službu. Samotný web môže ostať tam, kde je.

---

## Riešenie problémov

**Web sa nenačíta, vidím zoznam súborov**
`index.html` nie je priamo v `web/`, ale o priečinok nižšie. Presuň obsah vyššie.

**Stránky ako `/pokladna/` hlásia 404**
Chýba priečinok `pokladna/` alebo v ňom `index.html`. Nahraj celý balík znova
a uisti sa, že prenos dokončil všetky súbory.

**Nefunguje https**
Ešte nie je aktivovaný SSL certifikát (krok 5) alebo doména ešte nesmeruje
na hosting (krok 4).

**Zmeny sa neprejavili**
Prehliadač má starú verziu — **Ctrl + F5**. Ak to nepomôže, skontroluj,
že si prepísal aj priečinok `_next/`.

**Fotky sa nezobrazujú**
Skontroluj, že sa nahral celý priečinok `images/`. Pri FTP prenose
sa občas niektoré súbory preskočia — porovnaj počet súborov
(balík má 133 súborov).

**Diakritika je rozsypaná**
Nahral sa poškodený súbor. Nahraj `index.html` a `_next/` znova,
v FTP klientovi nastav prenos v **binárnom** režime.
