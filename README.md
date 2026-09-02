# ENZO — Smash Burgers & Pizza, Koniarovce

Web s online objednávkovým procesom pre prevádzku ENZO v Koniarovciach.
Vizuál vychádza z brand boardu: bordová, krémová, čierna a horčicová,
slab-serifový wordmark, šachovnicový motív.

**Smashed fresh. Served hot.**

> **Nasadenie:** kompletný návod je v [`NAVOD-WEBSUPPORT.md`](./NAVOD-WEBSUPPORT.md).
> Hotový balík na nahratie: **`enzo-web.zip`**.

---

## Stack

| | |
|---|---|
| Framework | Next.js 16 (App Router) so **statickým exportom** |
| Jazyk | TypeScript (strict) |
| Štýly | Tailwind CSS v4 (`@theme` tokeny v `src/app/globals.css`) |
| Písma | Alfa Slab One (wordmark), Archivo Black (nadpisy), Archivo (text) |
| Stav | React Context + `localStorage` |

Žiadna UI knižnica, žiadny state manager, žiadna animačná knižnica.
Výstup je čisté HTML/CSS/JS — beží na obyčajnom webhostingu bez Node.js.

## Príkazy

```bash
npm install
npm run dev        # vývoj na http://localhost:3000
npm run build      # statický export do out/
npm run zip        # build + zabalenie do enzo-web.zip
npm run lint
npm run typecheck
```

## Používateľská cesta

```
Úvod → Menu → Detail produktu (doplnky, množstvo, poznámka)
     → Košík → Pokladňa (odber/rozvoz, platba, validácia)
     → Potvrdenie objednávky → Tlač účtenky
```

Košík sa ukladá do `localStorage` a prežije obnovenie stránky.
Objednávka dostane číslo `ENZO-1042` a uloží sa do histórie v prehliadači.

## Menu

8 kategórií, 41 položiek podľa tlačeného menu prevádzky:

| Kategória | Položiek |
|---|---|
| Smash burgers | 7 |
| Pizza | 12 |
| Chicken | 4 |
| Bravčové | 2 |
| Kombo | 1 |
| Prílohy a omáčky | 12 |
| Sladká bodka | 1 |
| Nápoje | 1 |

## Štruktúra

```
src/
├── app/
│   ├── layout.tsx                  metadata, OG, JSON-LD, providery
│   ├── page.tsx                    úvodná stránka
│   ├── globals.css                 dizajnové tokeny, utility, tlačové štýly
│   ├── pokladna/                   checkout
│   ├── objednavka/                 potvrdenie objednávky
│   ├── podmienky/                  obchodné podmienky
│   └── ochrana-osobnych-udajov/
├── components/
│   ├── layout/    Header, MobileNavigation, Footer, LegalPage
│   ├── home/      Hero, BrandStory, HowItWorks, PromoSection, ContactSection
│   ├── menu/      MenuSection, MenuCategoryTabs, ProductCard, ProductModal, SauceLid
│   ├── cart/      CartDrawer, CartItemRow, MobileOrderBar, CartToast
│   ├── checkout/  Checkout, OrderSummary, PickupForm, DeliveryForm, PaymentSelector
│   ├── order/     OrderConfirmation, PrintableReceipt
│   └── ui/        Button, Field, Logo, Icons, QuantityStepper, Checkerboard, Reveal
├── context/CartContext.tsx         stav košíka
└── lib/
    ├── types.ts        doménové typy (Product, CartItem, Order, …)
    ├── config.ts       prevádzka, poplatky, limity  ← tu sa mení najviac
    ├── products.ts     katalóg menu
    ├── cart.ts         čisté funkcie: pridanie, množstvo, súčty
    ├── order.ts        model objednávky, číslovanie, perzistencia
    ├── validation.ts   validácia pokladne + slovenské hlášky
    ├── format.ts       formátovanie cien a dátumov (sk-SK)
    ├── scrollLock.ts   zamknutie scrollu bez „poskočenia" stránky
    └── storage.ts      bezpečná obálka nad localStorage
```

`lib/` neobsahuje žiadny JSX — dá sa bez zmien nahradiť volaniami na API.

## Kde sa čo mení

| Chcem zmeniť | Súbor |
|---|---|
| Adresa, telefón, hodiny, rozvozové obce, fakturačné údaje | `src/lib/config.ts` → `RESTAURANT` |
| Poplatok za rozvoz, minimálna objednávka, časy | `src/lib/config.ts` → `ORDER_CONFIG` |
| Menu, ceny, popisy, doplnky | `src/lib/products.ts` |
| Fotografie | `public/images/products/` |
| Farby, písma, šachovnica | `src/app/globals.css` → `@theme` |

## Logo a značka

Zdrojové súbory sú v `public/brand/` — SVG (skutočné krivky) aj PNG
v ~2 400 px s priehľadným pozadím:

- `enzo-wordmark-{burgundy,cream,black,white}` + `-transparent` varianty
- `enzo-badge-{burgundy,cream}` — kruhový odznak na obaly
- `enzo-lockup-horizontal{,-cream}` — vodorovná verzia

Logo v samotnom webe **nie je obrázok** — je vyskladané typograficky
a v CSS (`src/components/ui/Logo.tsx`), takže je ostré v akejkoľvek veľkosti.

| Farba | HEX |
|---|---|
| Bordová | `#7A1E1E` |
| Krémová | `#F6F0E3` |
| Čierna | `#111111` |
| Horčicová | `#E1B12C` |

## Platba a objednávky

Platobná brána **nie je** napojená. Pri platbe kartou sa objednávka označí ako
`paymentState: "demo-paid"` a zákazník je na to upozornený v pokladni aj na
potvrdení. Objednávka sa **neodosiela na server** — ukladá sa lokálne
v prehliadači zákazníka. Napojenie backendu je popísané v návode.

## Tlač účtenky

Tlačidlo *Vytlačiť potvrdenie* volá `window.print()`. Tlačová vrstva
(`PrintableReceipt`) je v prehliadači skrytá a pri tlači je jediným
viditeľným obsahom — formát 80 mm, monospace, s položkami, doplnkami,
poznámkami, súčtami a fakturačnými údajmi prevádzkovateľa.

## Prístupnosť

- sémantické HTML, jeden `h1` na stránku, korektná hierarchia nadpisov
- skip link, viditeľné focus stavy, focus pasca v modáloch
- `Escape` zatvára modal, košík aj mobilnú navigáciu
- popisky a `aria-describedby` pri chybách, `role="alert"` pri hláškach
- dotykové ciele min. 44 px, `alt` texty na všetkých fotkách
- rešpektuje `prefers-reduced-motion`; bez JavaScriptu sa obsah zobrazí okamžite

## Overené

Statický export otestovaný automatizovaným priechodom celej objednávkovej
cesty (desktop aj mobil) a kontrolou rozloženia na šírkach
320 / 360 / 375 / 390 / 430 / 640 / 768 / 820 / 1024 / 1180 / 1280 / 1440 / 1920 px
na štyroch stránkach — bez horizontálneho pretečenia, bez chýb v konzole
a bez chýbajúcich súborov.

## Fotografie

`public/images/` — fotografie z Unsplash (Unsplash License, voľné na
komerčné použitie), zmenšené a prevedené do WebP. Ide o **zástupné** fotky;
pred ostrým spustením ich treba nahradiť skutočnou fotografiou prevádzky.
