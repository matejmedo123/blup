import type { Category, ExtraOption, Product } from "./types";

/* ------------------------------------------------------------------ */
/*  Kategórie                                                          */
/* ------------------------------------------------------------------ */

export const CATEGORIES: Category[] = [
  {
    id: "burgers",
    label: "Burgers",
    title: "SMASH BURGERS",
    caption: "Smashujeme čerstvo na platni. Žiadne kompromisy.",
  },
  {
    id: "chicken",
    label: "Chicken",
    title: "CHICKEN",
    caption: "Chrumkavé kuracie. Krehké vnútri, zlaté zvonku.",
  },
  {
    id: "pork",
    label: "Bravčové",
    title: "BRAVČOVÉ",
    caption: "Pomaly tiahnuté mäso, ktoré sa rozpadá samo.",
  },
  {
    id: "kombo",
    label: "Kombo",
    title: "KOMBO FACTORY MENU",
    caption: "Burger, hranolky, omáčka a Kofola v jednom.",
  },
  {
    id: "sides",
    label: "Prílohy",
    title: "PRÍLOHY & OMÁČKY",
    caption: "Všetko, čím sa dá jedlo posunúť ďalej.",
  },
  {
    id: "sweets",
    label: "Sladké",
    title: "SLADKÁ BODKA",
    caption: "Na záver niečo teplé a sladké.",
  },
  {
    id: "drinks",
    label: "Nápoje",
    title: "NÁPOJE",
    caption: "Vychladené. Poriadne.",
  },
];

/* ------------------------------------------------------------------ */
/*  Zdieľané doplnky                                                   */
/* ------------------------------------------------------------------ */

export const BURGER_EXTRAS: ExtraOption[] = [
  { id: "extra-porcia", name: "Extra porcia mäsa", price: 3.5 },
  { id: "horuci-chedar", name: "Horúci chedar", price: 2.8 },
  { id: "jalapenos", name: "Jalapeños", price: 0.8 },
  { id: "slaninova-mayo", name: "Slaninová mayo", price: 1.0 },
  { id: "factory-mayo", name: "Factory mayo", price: 1.0 },
  { id: "coleslaw-extra", name: "Coleslaw šalát", price: 1.8 },
];

export const CHICKEN_EXTRAS: ExtraOption[] = [
  { id: "horuci-chedar", name: "Horúci chedar", price: 2.8 },
  { id: "jalapenos", name: "Jalapeños", price: 0.8 },
  { id: "cesnakovy-dresing", name: "Cesnakový dresing", price: 1.0 },
  { id: "factory-mayo", name: "Factory mayo", price: 1.0 },
];

export const FRIES_EXTRAS: ExtraOption[] = [
  { id: "udena-paprika", name: "Údená paprika", price: 0 },
  { id: "cesnak", name: "Cesnak", price: 0 },
  { id: "horuci-chedar", name: "Horúci chedar", price: 2.8 },
];

/* ------------------------------------------------------------------ */
/*  Produkty — podľa tlačeného menu ENZO Koniarovce                    */
/* ------------------------------------------------------------------ */

export const PRODUCTS: Product[] = [
  /* --------------------------- SMASH BURGERS ---------------------- */
  {
    id: "the-enzo-smash",
    name: "THE ENZO SMASH",
    description: "Náš signature smash burger — smashed hovädzie, chedar, ENZO omáčka",
    price: 9.9,
    category: "burgers",
    image: "/images/products/the-enzo-smash.webp",
    imageAlt: "Smash burger THE ENZO SMASH s topeným chedarom",
    badge: "NAJPREDÁVANEJŠIE",
    tags: ["Signature"],
    extras: BURGER_EXTRAS,
  },
  {
    id: "bacon-boy",
    name: "BACON BOY",
    description: "Smashed hovädzie, chrumkavá slanina, chedar, slaninová mayo",
    price: 9.9,
    category: "burgers",
    image: "/images/products/bacon-boy.webp",
    imageAlt: "Burger BACON BOY s chrumkavou slaninou",
    tags: ["Bacon"],
    extras: BURGER_EXTRAS,
  },
  {
    id: "jalapenos-smash",
    name: "JALAPEÑOS SMASH",
    description: "Smashed hovädzie, chedar, jalapeños, jalapeños dresing",
    price: 9.9,
    category: "burgers",
    image: "/images/products/jalapenos-smash.webp",
    imageAlt: "Pikantný burger JALAPEÑOS SMASH",
    badge: "PÁLIVÉ",
    tags: ["Hot 🌶"],
    extras: BURGER_EXTRAS,
  },
  {
    id: "trippple-king-smash",
    name: "TRIPPPLE KING SMASH",
    description: "Tri smashed hovädzie porcie, trojitý chedar, ENZO omáčka",
    price: 12.5,
    category: "burgers",
    image: "/images/products/trippple-king.webp",
    imageAlt: "Trojitý burger TRIPPPLE KING SMASH",
    badge: "3× MÄSO",
    tags: ["XL"],
    extras: BURGER_EXTRAS,
  },
  {
    id: "double-cheeseburger",
    name: "DOUBLE CHEESEBURGER",
    description: "Dve smashed porcie hovädzieho, dvojitý chedar, uhorky, cibuľa",
    price: 9.5,
    category: "burgers",
    image: "/images/products/double-cheeseburger.webp",
    imageAlt: "DOUBLE CHEESEBURGER s dvojitým chedarom",
    tags: ["2× mäso"],
    extras: BURGER_EXTRAS,
  },
  {
    id: "junior",
    name: "JUNIOR",
    description: "Menší smash burger — akurát pre menších jedákov",
    price: 5.9,
    category: "burgers",
    image: "/images/products/junior.webp",
    imageAlt: "Menší burger JUNIOR",
    tags: ["Malý"],
    extras: BURGER_EXTRAS,
  },
  {
    id: "extra-porcia",
    name: "EXTRA PORCIA",
    description: "Jedna smashed porcia hovädzieho navyše",
    price: 3.5,
    category: "burgers",
    image: "/images/products/extra-porcia.webp",
    imageAlt: "Smashed hovädzia porcia na platni",
  },

  /* ----------------------------- CHICKEN -------------------------- */
  {
    id: "crispy-chicken-burger",
    name: "CRISPY CHICKEN BURGER",
    description: "Chrumkavé kuracie prsia, chedar, ľadový šalát, Factory mayo",
    price: 9.5,
    category: "chicken",
    image: "/images/products/crispy-chicken-burger.webp",
    imageAlt: "Crispy chicken burger s chrumkavým kuracím mäsom",
    tags: ["Crispy"],
    extras: CHICKEN_EXTRAS,
  },
  {
    id: "stripsy-3",
    name: "DOMÁCE STRIPSY 3 KS",
    description: "Tri kusy domácich kuracích stripsov",
    price: 3.9,
    category: "chicken",
    image: "/images/products/stripsy.webp",
    imageAlt: "Domáce kuracie stripsy",
  },
  {
    id: "stripsy-6",
    name: "DOMÁCE STRIPSY 6 KS",
    description: "Šesť kusov domácich kuracích stripsov",
    price: 6.9,
    category: "chicken",
    image: "/images/products/stripsy.webp",
    imageAlt: "Domáce kuracie stripsy",
  },
  {
    id: "stripsy-9",
    name: "DOMÁCE STRIPSY 9 KS",
    description: "Deväť kusov domácich kuracích stripsov",
    price: 9.9,
    category: "chicken",
    image: "/images/products/stripsy.webp",
    imageAlt: "Domáce kuracie stripsy",
    badge: "NA ZDIEĽANIE",
  },

  /* ---------------------------- BRAVČOVÉ -------------------------- */
  {
    id: "trhane-bravcove",
    name: "TRHANÉ BRAVČOVÉ",
    description: "Pomaly tiahnuté bravčové mäso s omáčkou podľa výberu",
    price: 10.9,
    category: "pork",
    image: "/images/products/trhane-bravcove.webp",
    imageAlt: "Trhané bravčové mäso",
    tags: ["Slow cooked"],
  },
  {
    id: "pulled-pork-burger",
    name: "PULLED PORK BURGER",
    description: "Trhané bravčové, coleslaw, BBQ omáčka v brioške",
    price: 9.9,
    category: "pork",
    image: "/images/products/pulled-pork-burger.webp",
    imageAlt: "Pulled pork burger s coleslaw",
    extras: BURGER_EXTRAS,
  },

  /* ------------------------------ KOMBO --------------------------- */
  {
    id: "kombo-factory-menu",
    name: "KOMBO FACTORY MENU",
    description:
      "Burger podľa vlastného výberu + domáce hranolky, omáčka podľa výberu, Kofola Original 0,33 l",
    price: 4.9,
    category: "kombo",
    image: "/images/products/kombo.webp",
    imageAlt: "Kombo menu — burger, hranolky a nápoj",
    badge: "LEN NA ROZVOZ",
    tags: ["Príplatok k burgeru"],
  },

  /* -------------------------- PRÍLOHY & OMÁČKY -------------------- */
  {
    id: "domace-hranolky",
    name: "DOMÁCE HRANOLKY (180 G)",
    description: "S možnosťou údenej papriky alebo cesnaku",
    price: 2.9,
    category: "sides",
    image: "/images/products/domace-hranolky.webp",
    imageAlt: "Domáce hranolky",
    extras: FRIES_EXTRAS,
  },
  {
    id: "batatove-hranolky",
    name: "BATÁTOVÉ HRANOLKY (180 G)",
    description: "Sladké zemiaky, chrumkavé zvonku",
    price: 4.5,
    category: "sides",
    image: "/images/products/batatove-hranolky.webp",
    imageAlt: "Batátové hranolky",
  },
  {
    id: "cibulove-kruzky",
    name: "CIBUĽOVÉ KRÚŽKY (120 G)",
    description: "Cibuľové krúžky v chrumkavom cestíčku",
    price: 4.5,
    category: "sides",
    image: "/images/products/cibulove-kruzky.webp",
    imageAlt: "Chrumkavé cibuľové krúžky",
  },
  {
    id: "coleslaw",
    name: "COLESLAW ŠALÁT (80 G)",
    description: "Chrumkavá kapusta, mrkva a krémový dresing",
    price: 1.8,
    category: "sides",
    image: "/images/products/coleslaw.webp",
    imageAlt: "Coleslaw šalát",
  },
  {
    id: "horuci-chedar",
    name: "HORÚCI CHEDAR",
    description: "Roztopený chedar na preliatie hranoliek alebo burgera",
    price: 2.8,
    category: "sides",
    image: "/images/products/horuci-chedar.webp",
    imageAlt: "Horúci chedar na hranolkách",
  },
  {
    id: "omacka-slaninova-mayo",
    name: "SLANINOVÁ MAYO (50 G)",
    description: "Majonéza s praženou slaninou",
    price: 1.0,
    category: "sides",
    lid: { accent: "cream", lines: ["BACON", "MAYO"] },
  },
  {
    id: "omacka-factory-mayo",
    name: "FACTORY MAYO (50 G)",
    description: "Naša domáca signature majonéza",
    price: 1.0,
    category: "sides",
    lid: { accent: "cream", lines: ["FACTORY", "MAYO"] },
  },
  {
    id: "omacka-bbq",
    name: "BBQ (50 G)",
    description: "Sladko-dymová BBQ omáčka",
    price: 1.0,
    category: "sides",
    lid: { accent: "burgundy", lines: ["BBQ", "SAUCE"] },
  },
  {
    id: "omacka-kecup",
    name: "KEČUP (50 G)",
    description: "Klasika, ktorá nesklame",
    price: 1.0,
    category: "sides",
    lid: { accent: "red", lines: ["KEČUP", ""] },
  },
  {
    id: "omacka-tatarska",
    name: "TATÁRSKA (50 G)",
    description: "Krémová tatárska omáčka",
    price: 1.0,
    category: "sides",
    lid: { accent: "cream", lines: ["TATÁRSKA", ""] },
  },
  {
    id: "omacka-cesnakovy-dresing",
    name: "CESNAKOVÝ DRESING (50 G)",
    description: "Cesnak, jogurt a bylinky",
    price: 1.0,
    category: "sides",
    lid: { accent: "cream", lines: ["CESNAK", "DRESING"] },
  },
  {
    id: "omacka-jalapenos-dresing",
    name: "JALAPEÑOS DRESING (50 G)",
    description: "Pikantný dresing s jalapeños",
    price: 1.0,
    category: "sides",
    lid: { accent: "gold", lines: ["JALAPEÑOS", "DRESING"] },
  },

  /* --------------------------- SLADKÁ BODKA ----------------------- */
  {
    id: "churros",
    name: "ŠKORICOVÉ CHURROS",
    description:
      "10 ks (150 g) — jahodový džem alebo karamelový toping podľa výberu",
    price: 5.5,
    category: "sweets",
    image: "/images/products/churros.webp",
    imageAlt: "Škoricové churros",
    badge: "NOVINKA",
    extras: [
      { id: "jahodovy-dzem", name: "Jahodový džem", price: 0 },
      { id: "karamelovy-toping", name: "Karamelový toping", price: 0 },
    ],
  },

  /* ----------------------------- NÁPOJE --------------------------- */
  {
    id: "kofola-original",
    name: "KOFOLA ORIGINAL 0,33 L",
    description: "Vychladená klasika",
    // POZOR: cena nápoja nie je v tlačenom menu — pred spustením ju potvrď.
    price: 2.0,
    category: "drinks",
    image: "/images/products/kofola.webp",
    imageAlt: "Pohár Kofoly s ľadom",
  },
];

/* ------------------------------------------------------------------ */
/*  Prístupové funkcie (jednoduché nahradenie API volaniami)           */
/* ------------------------------------------------------------------ */

export function getProducts(): Product[] {
  return PRODUCTS;
}

export function getProductById(id: string): Product | undefined {
  return PRODUCTS.find((p) => p.id === id);
}

export function getProductsByCategory(category: Category["id"]): Product[] {
  return PRODUCTS.filter((p) => p.category === category);
}

/** Produkty zoskupené podľa kategórie v poradí CATEGORIES. */
export function getMenu(): { category: Category; products: Product[] }[] {
  return CATEGORIES.map((category) => ({
    category,
    products: getProductsByCategory(category.id),
  }));
}

/** Výber pre "Najobľúbenejšie" bloky na homepage. */
export const FEATURED_IDS = [
  "the-enzo-smash",
  "kombo-factory-menu",
] as const;
