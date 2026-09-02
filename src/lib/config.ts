/** Centrálna konfigurácia prevádzky — jediné miesto na úpravu. */

export const RESTAURANT = {
  name: "ENZO",
  legalName: "ENZO Smash Burgers & Pizza",
  descriptor: "SMASH BURGERS & PIZZA",
  tagline: "SMASHED FRESH. SERVED HOT.",
  claim: "GOOD BURGERS. NO BULLSHIT.",
  since: "EST. 2026",
  place: "KONIAROVCE",
  /** Lokál — „v Koniarovciach" */
  placeLocative: "Koniarovciach",
  address: {
    street: "Koniarovce 290",
    city: "Koniarovce",
    postalCode: "956 13",
    country: "Slovensko",
  },
  phone: "0948 238 346",
  phoneHref: "+421948238346",
  email: "objednavky@enzo.sk",
  instagram: "https://instagram.com",
  facebook: "https://facebook.com",
  hours: [
    { days: "Pondelok — Štvrtok", time: "11:00 — 21:00" },
    { days: "Piatok — Sobota", time: "11:00 — 22:00" },
    { days: "Nedeľa", time: "12:00 — 21:00" },
  ],
  deliveryZones: [
    "Koniarovce",
    "Preseľany",
    "Ludanice",
    "Chrabrany",
    "Topoľčany",
    "Nitrianska Streda",
  ],
  /** Fakturačné údaje do pätičky a na účtenku */
  company: {
    name: "ENZIK s.r.o.",
    ico: "57579661",
    dic: "2122832888",
    seat: "Farská 1342/50, 949 01 Nitra",
    branch: "Koniarovce 290, 956 13",
    manager: "Enriko Petrík",
  },
} as const;

export const ORDER_CONFIG = {
  currency: "EUR",
  locale: "sk-SK",
  /** Poplatok za doručenie */
  deliveryFee: 2.5,
  /** Doručenie zdarma od tejto sumy */
  freeDeliveryFrom: 35,
  /** Minimálna hodnota objednávky */
  minOrder: 12,
  estimatedTimePickup: "15 — 25 min",
  estimatedTimeDelivery: "35 — 50 min",
  /** Počiatočné číslo objednávky pre demo */
  firstOrderNumber: 1041,
} as const;
