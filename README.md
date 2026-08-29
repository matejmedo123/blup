# ENZO — Smash Burgers & Fries

Responzívny prototyp webu slovenskej smash-burger prevádzky **ENZO** s plne funkčným
online objednávkovým procesom. Vizuálna identita je odvodená z priloženého brand boardu
(bordová, krémová, čierna + horčicová; Anton ako display písmo, šachovnicový vzor,
packaging ENZO).

**Smashed fresh. Served hot.**

---

## Stack

| | |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| Jazyk | TypeScript (strict) |
| Štýly | Tailwind CSS v4 (`@theme` tokeny v `src/app/globals.css`) |
| Písma | Anton (display) + Archivo (UI) cez `next/font/google`, subset `latin-ext` |
| Stav | React Context + `localStorage`, žiadne ďalšie závislosti |

Žiadna UI knižnica, žiadny state manager, žiadna animačná knižnica — všetko je
v komponentoch projektu.

## Spustenie

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # produkčný build
npm run lint     # ESLint
npx tsc --noEmit # typová kontrola
```

## Používateľská cesta

```
Úvod → Menu → Detail produktu (extra + množstvo + poznámka)
     → Košík (drawer) → Pokladňa (odber/doručenie, platba, validácia)
     → Potvrdenie objednávky → Tlač účtenky
```

Košík sa ukladá do `localStorage` a prežije reload. Objednávka dostane číslo
`ENZO-1042`, uloží sa do histórie a košík sa vyprázdni.

## Štruktúra

```
src/
├── app/
│   ├── layout.tsx                  # metadata, OG, JSON-LD, providery, skip link
│   ├── page.tsx                    # úvodná stránka
│   ├── globals.css                 # dizajnové tokeny, utility, tlačové štýly
│   ├── pokladna/                   # checkout
│   ├── objednavka/                 # potvrdenie objednávky (?c=ENZO-1042)
│   ├── podmienky/                  # obchodné podmienky
│   └── ochrana-osobnych-udajov/
├── components/
│   ├── layout/    Header, MobileNavigation, Footer, LegalPage
│   ├── home/      Hero, BrandStory, HowItWorks, PromoSection, ContactSection
│   ├── menu/      MenuSection, MenuCategoryTabs, ProductCard, ProductModal, SauceLid
│   ├── cart/      CartDrawer, CartItemRow, MobileOrderBar, CartToast
│   ├── checkout/  Checkout, OrderSummary, PickupForm, DeliveryForm, PaymentSelector
│   ├── order/     OrderConfirmation, PrintableReceipt
│   └── ui/        Button, Field, Logo, Icons, QuantityStepper, Checkerboard, Reveal
├── context/CartContext.tsx         # jediný zdroj pravdy pre košík
└── lib/
    ├── types.ts        # doménové typy (Product, CartItem, Order, …)
    ├── config.ts       # údaje prevádzky, poplatky, limity  ← tu sa mení najviac
    ├── products.ts     # katalóg produktov a kategórií
    ├── cart.ts         # čisté funkcie: pridanie, množstvo, súčty
    ├── order.ts        # model objednávky, číslovanie, perzistencia
    ├── validation.ts   # validácia pokladne + slovenské hlášky
    ├── format.ts       # formátovanie cien a dátumov (sk-SK)
    ├── scrollLock.ts   # zamknutie scrollu bez „poskočenia" stránky
    └── storage.ts      # bezpečná obálka nad localStorage
```

Doménová logika je oddelená od UI — `lib/` neobsahuje žiadny JSX a dá sa
bez zmien nahradiť volaniami na API.

## Čo sa mení najčastejšie

| Chcem zmeniť | Súbor |
|---|---|
| Adresu, telefón, otváracie hodiny, rozvozové obce | `src/lib/config.ts` → `RESTAURANT` |
| Poplatok za doručenie, minimálnu objednávku, časy | `src/lib/config.ts` → `ORDER_CONFIG` |
| Produkty, ceny, popisy, doplnky, kategórie | `src/lib/products.ts` |
| Fotky produktov | `public/images/products/` + pole `image` v produkte |
| Farby, písma, šachovnicu | `src/app/globals.css` → blok `@theme` |

Pridanie produktu = jeden objekt v `PRODUCTS`; kategórie, taby aj počty
sa dopočítajú samé.

## Napojenie na backend

Prototyp je pripravený na výmenu perzistencie za API:

- `getProducts()` / `getProductById()` / `getMenu()` v `lib/products.ts` — nahradiť `fetch`.
- `createOrder()` + `saveOrder()` v `lib/order.ts` — nahradiť `POST /api/orders`.
- `CartContext` pracuje výhradne s čistými funkciami z `lib/cart.ts`, takže
  serverový prepočet cien sa dá zapojiť bez zásahu do komponentov.

## Platba

Platobná brána **nie je** napojená. Pri platbe kartou sa objednávka označí ako
`paymentState: "demo-paid"` a používateľ je na to explicitne upozornený
v pokladni aj na potvrdení. Nič sa nestrháva.

## Tlač účtenky

Tlačidlo *Vytlačiť potvrdenie* volá `window.print()`. Tlačová vrstva
(`PrintableReceipt`) je v prehliadači skrytá a pri tlači je jediným viditeľným
obsahom — hlavička, pätička aj zvyšok UI sa skryjú. Formát `80 mm`, monospace,
so všetkými položkami, doplnkami, poznámkami a súčtami.

## Prístupnosť

- sémantické HTML, jeden `h1` na stránku, korektná hierarchia nadpisov
- skip link, viditeľné focus stavy (horčicový outline), focus pasca v modáloch
- `Escape` zatvára modal, košík aj mobilnú navigáciu
- popisky a `aria-describedby` pri chybách formulára, `role="alert"` pri hláškach
- dotykové ciele min. 44 px, `alt` texty na všetkých fotkách
- rešpektuje `prefers-reduced-motion`; bez JavaScriptu sa obsah zobrazí okamžite

## Overené

Manuálne aj automatizovane (Playwright) prejdené na šírkach
375 / 390 / 430 / 640 / 768 / 820 / 1024 / 1180 / 1280 / 1440 / 1920 px:
žiadne horizontálne pretečenie, žiadne chyby v konzole, kompletná objednávková
cesta vrátane validácie, perzistencie košíka a tlače.

## Obrázky

- `public/images/products/`, `public/images/editorial/` — fotografie z Unsplash
  (Unsplash License, voľné na komerčné použitie), zmenšené a prevedené do WebP.
  Ide o zástupné fotky — pred ostrým nasadením ich treba nahradiť skutočnou
  produktovou fotografiou ENZO.
- `public/images/brand/` — výrezy packagingu priamo z dodaného ENZO brand boardu.
- Logo, kruhový odznak a šachovnica sú vyskladané typograficky / v CSS,
  takže sú ostré v akejkoľvek veľkosti.

---

Demo prototyp. Objednávky sa ukladajú výhradne lokálne v prehliadači.
