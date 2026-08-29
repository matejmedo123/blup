/** Centrálna konfigurácia prevádzky — jediné miesto na úpravu. */

export const RESTAURANT = {
  name: "ENZO",
  legalName: "ENZO Smash Burgers & Fries",
  descriptor: "SMASH BURGERS & FRIES",
  tagline: "SMASHED FRESH. SERVED HOT.",
  claim: "GOOD BURGERS. NO BULLSHIT.",
  since: "EST. 2026",
  place: "PRESEĽANY",
  /** Lokál — „v Preseľanoch" */
  placeLocative: "Preseľanoch",
  address: {
    street: "Hlavná 128",
    city: "Preseľany",
    postalCode: "956 12",
    country: "Slovensko",
  },
  phone: "+421 902 118 240",
  phoneHref: "+421902118240",
  email: "ahoj@enzoburgers.sk",
  instagram: "https://instagram.com",
  facebook: "https://facebook.com",
  hours: [
    { days: "Pondelok — Štvrtok", time: "11:00 — 21:00" },
    { days: "Piatok — Sobota", time: "11:00 — 23:00" },
    { days: "Nedeľa", time: "12:00 — 21:00" },
  ],
  deliveryZones: ["Preseľany", "Topoľčany", "Nitrianska Blatnica", "Bojná", "Ludanice"],
} as const;

export const ORDER_CONFIG = {
  currency: "EUR",
  locale: "sk-SK",
  /** Poplatok za doručenie */
  deliveryFee: 2.5,
  /** Doručenie zdarma od tejto sumy */
  freeDeliveryFrom: 35,
  /** Minimálna hodnota objednávky */
  minOrder: 10,
  estimatedTimePickup: "15 — 20 min",
  estimatedTimeDelivery: "30 — 45 min",
  /** Počiatočné číslo objednávky pre demo */
  firstOrderNumber: 1041,
} as const;
