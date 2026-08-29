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
    id: "fries",
    label: "Fries",
    title: "FRIES & LOADED FRIES",
    caption: "Dvakrát smažené. Vždy horúce.",
  },
  {
    id: "sides",
    label: "Sides",
    title: "SIDES & EXTRAS",
    caption: "Všetko, čím sa dá jedlo posunúť ďalej.",
  },
  {
    id: "sauces",
    label: "Dips",
    title: "OMÁČKY",
    caption: "Robíme si ich sami. Každý deň.",
  },
  {
    id: "drinks",
    label: "Drinks",
    title: "NÁPOJE",
    caption: "Vychladené. Poriadne.",
  },
];

/* ------------------------------------------------------------------ */
/*  Zdieľané doplnky                                                   */
/* ------------------------------------------------------------------ */

export const BURGER_EXTRAS: ExtraOption[] = [
  { id: "extra-patty", name: "Extra patty", price: 2.4 },
  { id: "extra-cheese", name: "Extra cheddar", price: 0.6 },
  { id: "extra-bacon", name: "Extra slanina", price: 1.6 },
  { id: "jalapenos", name: "Jalapeños", price: 0.5 },
  { id: "crispy-onion", name: "Chrumkavá cibuľka", price: 0.5 },
  { id: "enzo-sauce", name: "ENZO sauce navyše", price: 0.8 },
];

export const CHICKEN_EXTRAS: ExtraOption[] = [
  { id: "extra-chicken", name: "Extra kuracie", price: 2.4 },
  { id: "extra-cheese", name: "Extra cheddar", price: 0.6 },
  { id: "extra-bacon", name: "Extra slanina", price: 1.6 },
  { id: "jalapenos", name: "Jalapeños", price: 0.5 },
  { id: "spicy-mayo", name: "Spicy mayo navyše", price: 0.8 },
];

export const FRIES_EXTRAS: ExtraOption[] = [
  { id: "extra-cheese-sauce", name: "Extra cheddar omáčka", price: 0.9 },
  { id: "extra-bacon", name: "Extra slanina", price: 1.6 },
  { id: "jalapenos", name: "Jalapeños", price: 0.5 },
  { id: "enzo-sauce", name: "ENZO sauce", price: 0.8 },
];

/* ------------------------------------------------------------------ */
/*  Produkty                                                           */
/* ------------------------------------------------------------------ */

export const PRODUCTS: Product[] = [
  /* ---------------------------- BURGERS --------------------------- */
  {
    id: "the-enzo",
    name: "THE ENZO",
    description:
      "2× smashed hovädzie, dvojitý cheddar, nakladané uhorky, cibuľa, ENZO sauce",
    price: 7.9,
    category: "burgers",
    image: "/images/products/the-enzo.webp",
    imageAlt: "Smash burger THE ENZO s dvojitým cheddarom a nakladanými uhorkami",
    badge: "NAJPREDÁVANEJŠIE",
    tags: ["2× patty", "Signature"],
    extras: BURGER_EXTRAS,
  },
  {
    id: "bacon-boy",
    name: "BACON BOY",
    description:
      "2× smashed hovädzie, dvojitý cheddar, chrumkavá slanina, cibuľa, bacon mayo",
    price: 8.4,
    category: "burgers",
    image: "/images/products/bacon-boy.webp",
    imageAlt: "Burger BACON BOY s chrumkavou slaninou a cheddarom",
    tags: ["2× patty", "Bacon"],
    extras: BURGER_EXTRAS,
  },
  {
    id: "hot-enzo",
    name: "HOT ENZO",
    description:
      "2× smashed hovädzie, dvojitý cheddar, jalapeños, cibuľa, spicy ENZO sauce",
    price: 8.2,
    category: "burgers",
    image: "/images/products/hot-enzo.webp",
    imageAlt: "Pikantný burger HOT ENZO s jalapeños",
    badge: "PÁLIVÉ",
    tags: ["2× patty", "Hot 🌶"],
    extras: BURGER_EXTRAS,
  },
  {
    id: "big-enzo",
    name: "BIG ENZO",
    description:
      "3× smashed hovädzie, trojitý cheddar, slanina, uhorky, cibuľa, ENZO sauce",
    price: 9.9,
    category: "burgers",
    image: "/images/products/big-enzo.webp",
    imageAlt: "Trojitý burger BIG ENZO",
    badge: "DOUBLE IS BETTER",
    tags: ["3× patty", "XL"],
    extras: BURGER_EXTRAS,
  },
  {
    id: "the-classic",
    name: "THE CLASSIC",
    description:
      "2× smashed hovädzie, cheddar, nakladané uhorky, cibuľa, kečup, majonéza",
    price: 6.9,
    category: "burgers",
    image: "/images/products/the-classic.webp",
    imageAlt: "Klasický smash burger THE CLASSIC",
    tags: ["2× patty"],
    extras: BURGER_EXTRAS,
  },

  /* ---------------------------- CHICKEN --------------------------- */
  {
    id: "chicken-smash",
    name: "CHICKEN SMASH",
    description: "Chrumkavé kuracie prsia, cheddar, ľadový šalát, ENZO mayo",
    price: 7.9,
    category: "chicken",
    image: "/images/products/chicken-smash.webp",
    imageAlt: "Burger CHICKEN SMASH s chrumkavým kuracím mäsom",
    tags: ["Crispy"],
    extras: CHICKEN_EXTRAS,
  },
  {
    id: "spicy-chicken",
    name: "SPICY CHICKEN",
    description: "Chrumkavé kuracie prsia, cheddar, jalapeños, spicy mayo",
    price: 8.2,
    category: "chicken",
    image: "/images/products/spicy-chicken.webp",
    imageAlt: "Pikantný burger SPICY CHICKEN",
    badge: "PÁLIVÉ",
    tags: ["Crispy", "Hot 🌶"],
    extras: CHICKEN_EXTRAS,
  },

  /* ----------------------------- FRIES ---------------------------- */
  {
    id: "fries",
    name: "FRIES",
    description: "Dvakrát smažené hranolky, morská soľ",
    price: 2.9,
    category: "fries",
    image: "/images/products/fries.webp",
    imageAlt: "Chrumkavé hranolky ENZO",
    extras: FRIES_EXTRAS,
  },
  {
    id: "cheese-fries",
    name: "CHEESE FRIES",
    description: "Hranolky preliate horúcou cheddar omáčkou",
    price: 3.9,
    category: "fries",
    image: "/images/products/cheese-fries.webp",
    imageAlt: "Hranolky s cheddar omáčkou",
    extras: FRIES_EXTRAS,
  },
  {
    id: "bacon-cheese-fries",
    name: "BACON CHEESE FRIES",
    description: "Hranolky, cheddar omáčka, chrumkavá slanina, jarná cibuľka",
    price: 4.6,
    category: "fries",
    image: "/images/products/bacon-cheese-fries.webp",
    imageAlt: "Hranolky so slaninou a cheddar omáčkou",
    extras: FRIES_EXTRAS,
  },
  {
    id: "enzo-loaded-fries",
    name: "ENZO LOADED FRIES",
    description:
      "Hranolky, smashed hovädzie, cheddar omáčka, uhorky, cibuľa, ENZO sauce",
    price: 5.4,
    category: "fries",
    image: "/images/products/loaded-fries.webp",
    imageAlt: "ENZO LOADED FRIES s hovädzím mäsom a omáčkou",
    badge: "GET SMASHED",
    extras: FRIES_EXTRAS,
  },

  /* ----------------------------- SIDES ---------------------------- */
  {
    id: "chicken-strips",
    name: "CHICKEN STRIPS (3 KS)",
    description: "Chrumkavé kuracie stripsy s dipom podľa výberu",
    price: 4.2,
    category: "sides",
    image: "/images/products/chicken-strips.webp",
    imageAlt: "Chrumkavé kuracie stripsy",
  },
  {
    id: "onion-rings",
    name: "ONION RINGS (6 KS)",
    description: "Cibuľové krúžky v chrumkavom cestíčku",
    price: 3.2,
    category: "sides",
    image: "/images/products/onion-rings.webp",
    imageAlt: "Chrumkavé cibuľové krúžky",
  },
  {
    id: "extra-patty-side",
    name: "EXTRA PATTY",
    description: "Jedno smashed hovädzie patty navyše",
    price: 2.4,
    category: "sides",
    image: "/images/products/extra-patty.webp",
    imageAlt: "Smashed hovädzie patty",
  },
  {
    id: "extra-bacon-side",
    name: "EXTRA BACON",
    description: "Porcia chrumkavej slaniny",
    price: 1.6,
    category: "sides",
    image: "/images/products/extra-bacon.webp",
    imageAlt: "Chrumkavá slanina",
  },
  {
    id: "extra-cheese-side",
    name: "EXTRA CHEESE",
    description: "Plátok topeného cheddaru",
    price: 0.6,
    category: "sides",
    image: "/images/products/extra-cheese.webp",
    imageAlt: "Plátok cheddaru",
  },

  /* ---------------------------- SAUCES ---------------------------- */
  {
    id: "enzo-sauce",
    name: "ENZO SAUCE",
    description: "Naša signature omáčka. Krémová, dymová, návyková.",
    price: 0.8,
    category: "sauces",
    lid: { accent: "cream", lines: ["ENZO", "SAUCE"] },
  },
  {
    id: "bacon-mayo",
    name: "BACON MAYO",
    description: "Majonéza s praženou slaninou a čiernym korením",
    price: 0.8,
    category: "sauces",
    lid: { accent: "red", lines: ["BACON", "MAYO"] },
  },
  {
    id: "spicy-sauce",
    name: "SPICY SAUCE",
    description: "Chilli, cesnak, štipka dymu. Poriadne pálivá.",
    price: 0.8,
    category: "sauces",
    lid: { accent: "gold", lines: ["SPICY", "SAUCE"] },
  },
  {
    id: "bbq-sauce",
    name: "BBQ SAUCE",
    description: "Sladko-dymová BBQ na pomalom ohni",
    price: 0.8,
    category: "sauces",
    lid: { accent: "burgundy", lines: ["BBQ", "SAUCE"] },
  },

  /* ---------------------------- DRINKS ---------------------------- */
  {
    id: "coca-cola",
    name: "COCA-COLA 0,33 L",
    description: "Vychladená plechovka",
    price: 2.2,
    category: "drinks",
    image: "/images/products/cola.webp",
    imageAlt: "Plechovka Coca-Cola",
  },
  {
    id: "coca-cola-zero",
    name: "COCA-COLA ZERO 0,33 L",
    description: "Bez cukru, plná chuť",
    price: 2.2,
    category: "drinks",
    image: "/images/products/cola-zero.webp",
    imageAlt: "Pohár Coca-Cola Zero s ľadom",
  },
  {
    id: "fanta",
    name: "FANTA 0,33 L",
    description: "Pomarančová klasika",
    price: 2.2,
    category: "drinks",
    image: "/images/products/fanta.webp",
    imageAlt: "Plechovka Fanta",
  },
  {
    id: "sprite",
    name: "SPRITE 0,33 L",
    description: "Citrón a limetka, poriadne vychladené",
    price: 2.2,
    category: "drinks",
    image: "/images/products/sprite.webp",
    imageAlt: "Plechovka Sprite",
  },
  {
    id: "domaca-limonada",
    name: "DOMÁCA LIMONÁDA 0,4 L",
    description: "Pomaranč, citrón, mäta — miešame na mieste",
    price: 3.2,
    category: "drinks",
    image: "/images/products/lemonade.webp",
    imageAlt: "Domáca pomarančová limonáda",
    badge: "NOVINKA",
  },
  {
    id: "voda",
    name: "VODA 0,5 L",
    description: "Neperlivá pramenitá voda",
    price: 1.6,
    category: "drinks",
    image: "/images/products/water.webp",
    imageAlt: "Pohár vody",
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
export const FEATURED_IDS = ["the-enzo", "big-enzo", "enzo-loaded-fries"] as const;
